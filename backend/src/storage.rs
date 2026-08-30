use std::collections::HashMap;
use std::error::Error as StdError;
use std::fmt;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aws_config::BehaviorVersion;
use aws_config::retry::RetryConfig;
use aws_config::timeout::TimeoutConfig;
use aws_credential_types::Credentials;
use aws_sdk_s3::config::interceptors::BeforeTransmitInterceptorContextRef;
use aws_sdk_s3::config::{ConfigBag, Intercept, RuntimeComponents};
use aws_sdk_s3::error::ProvideErrorMetadata;
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::types::{
    AbortIncompleteMultipartUpload, BucketLifecycleConfiguration, ChecksumAlgorithm, ChecksumMode,
    CompletedMultipartUpload, CompletedPart, Delete, ExpirationStatus, LifecycleRule,
    LifecycleRuleFilter, ObjectIdentifier,
};
use aws_smithy_runtime_api::box_error::BoxError;
use aws_smithy_runtime_api::client::retries::RequestAttempts;
use aws_types::region::Region;
use futures_util::future::{Either, select};
use futures_util::{StreamExt, stream};
use serde::Serialize;
use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::{Instant, MissedTickBehavior, interval_at, sleep};
use tokio_postgres::{AsyncMessage, NoTls};

use crate::config::Config;
use crate::db::Database;
use crate::e2ee::{UPLOAD_PART_BYTES, uses_vault_multipart_upload};
use crate::observability::Metrics;
use crate::upload_completion::{
    FileUploadFinalizeOutcome, claim_file_upload_completions, completion_retry_delay_seconds,
    defer_file_upload_completion, file_upload_metadata_matches, finalize_file_upload_record,
    transition_file_upload_to_cleanup,
};

const MULTIPART_RECONCILIATION_LOCK_ID: i64 = 4_133_797_884_291_001;
const COUNTER_RECONCILIATION_LOCK_ID: i64 = 4_133_797_884_291_002;
const STORAGE_OBJECT_PREFIX: &str = "users/";
const USER_DELETION_BATCH_SIZE: i64 = 500;
const USER_DELETION_BATCHES_PER_TICK: usize = 32;
const SESSION_EXPIRY_BATCH_SIZE: i64 = 1_000;
const SESSION_EXPIRY_BATCHES_PER_TICK: usize = 4;
const TRASH_EXPIRY_BATCH_SIZE: i64 = 500;
const TRASH_EXPIRY_BATCHES_PER_TICK: usize = 32;
const MAINTENANCE_RESTART_DELAY: Duration = Duration::from_secs(1);
const S3_REQUEST_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const S3_REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(10);
const S3_REQUEST_OPERATION_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(15);
const S3_REQUEST_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const S3_MAINTENANCE_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const S3_MAINTENANCE_READ_TIMEOUT: Duration = Duration::from_secs(20);
const S3_MAINTENANCE_OPERATION_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(20);
const S3_MAINTENANCE_OPERATION_TIMEOUT: Duration = Duration::from_secs(60);
const MULTIPART_LIFECYCLE_RULE_ID: &str = "aeralyth-abort-incomplete-multipart";
const LIFECYCLE_BACKED_RECONCILIATION_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const COUNTER_RECONCILIATION_BATCH_SIZE: i64 = 500;
const STORAGE_JOB_LEASE_SECONDS: i64 = 5 * 60;
const STORAGE_JOB_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);
const MAINTENANCE_DEAD_LETTER_ATTEMPTS: i32 = 12;
const RETRY_DELAY_FLOOR_SECONDS: i64 = 10;
const RETRY_DELAY_CAP_SECONDS: i64 = 60 * 60;
const CLAIM_EXPIRED_VAULT_UPLOADS_QUERY: &str = "
    WITH claimed AS (
      SELECT id
      FROM vault_uploads
      WHERE status IN ('initializing', 'pending', 'completing', 'aborting')
        AND expires_at <= now()
      ORDER BY expires_at, id
      LIMIT 25
      FOR UPDATE SKIP LOCKED
    )
    UPDATE vault_uploads AS uploads
    SET status = 'aborting', expires_at = now() + interval '5 minutes'
    FROM claimed
    WHERE uploads.id = claimed.id
    RETURNING uploads.id, uploads.object_key,
              uploads.multipart_upload_id, uploads.write_expires_at
";
const CLAIM_EXPIRED_FILE_UPLOADS_QUERY: &str = "
    WITH claimed AS (
      SELECT id
      FROM file_uploads
      WHERE status IN ('initializing', 'pending', 'aborting')
        AND expires_at <= now()
      ORDER BY expires_at, id
      LIMIT 25
      FOR UPDATE SKIP LOCKED
    )
    UPDATE file_uploads AS uploads
    SET expires_at = now() + interval '5 minutes'
    FROM claimed
    WHERE uploads.id = claimed.id
    RETURNING
      uploads.id,
      uploads.file_id,
      uploads.owner_id,
      uploads.parent_id,
      uploads.original_name,
      uploads.object_key,
      uploads.mime_type,
      uploads.size_bytes,
      uploads.upload_mode,
      uploads.multipart_upload_id,
      uploads.status,
      uploads.checksum_sha256
";
const CLAIM_STORAGE_DELETION_JOBS_QUERY: &str = "
    WITH claimed AS (
      SELECT id
      FROM storage_deletion_jobs
      WHERE available_at <= now()
        AND dead_lettered_at IS NULL
        AND (locked_until IS NULL OR locked_until < now())
      ORDER BY id
      LIMIT 25
      FOR UPDATE SKIP LOCKED
    ), claimed_jobs AS (
      UPDATE storage_deletion_jobs AS jobs
      SET locked_until = now() + ($1::bigint * interval '1 second'),
          lease_token = gen_random_uuid()::text
      FROM claimed
      WHERE jobs.id = claimed.id
      RETURNING
        jobs.id,
        jobs.object_key,
        jobs.multipart_upload_id,
        jobs.attempts,
        jobs.lease_token
    )
    SELECT
      claimed_jobs.*,
      EXISTS (
        SELECT 1
        FROM vault_uploads
        WHERE vault_uploads.object_key = claimed_jobs.object_key
          AND vault_uploads.upload_mode = 'multipart'
          AND vault_uploads.status IN ('aborting', 'aborted')
          AND vault_uploads.multipart_upload_id IS NULL
      ) AS discover_multipart
    FROM claimed_jobs
";
const COMPLETE_MIGRATION_CLEANUP_QUERY: &str = "
    UPDATE vault_migrations
    SET state = 'complete', updated_at = now()
    WHERE legacy_object_key = $1 AND state = 'cleanup_queued'
";
const EXPIRE_TRASH_BATCH_QUERY: &str = "
    WITH targets AS MATERIALIZED (
      SELECT files.id, files.owner_id, files.storage_name, files.entry_type,
             uploads.upload_mode, uploads.write_expires_at
      FROM files
      INNER JOIN users ON users.id = files.owner_id
      LEFT JOIN file_uploads AS uploads
        ON uploads.file_id = files.id AND uploads.status = 'completed'
      WHERE files.state = 'trashed'
        AND files.trashed_at IS NOT NULL
        AND files.trashed_at
              + (users.trash_retention_days * interval '1 day') <= now()
        AND NOT EXISTS (
          SELECT 1 FROM files AS children WHERE children.parent_id = files.id
        )
      ORDER BY files.trashed_at, files.id
      LIMIT $1
      FOR UPDATE OF files SKIP LOCKED
    ), queued AS (
      INSERT INTO storage_deletion_jobs (object_key, available_at)
      SELECT
        CASE
          WHEN position('/' IN targets.storage_name) = 0
            THEN targets.owner_id || '/' || targets.storage_name
          ELSE targets.storage_name
        END,
        CASE
          WHEN targets.upload_mode = 'single'
            THEN GREATEST(COALESCE(targets.write_expires_at, now()), now())
          ELSE now()
        END
      FROM targets
      WHERE targets.entry_type = 'file'
      ON CONFLICT (object_key) DO UPDATE SET
        available_at = GREATEST(
          storage_deletion_jobs.available_at,
          EXCLUDED.available_at
        )
      RETURNING object_key
    ), deleted AS (
      DELETE FROM files AS entries
      USING targets
      WHERE entries.id = targets.id
        AND (SELECT count(*) FROM queued) >= 0
      RETURNING entries.id
    )
    SELECT count(*)::bigint AS deleted FROM deleted
";
const RECONCILE_USER_COUNTERS_PAGE_QUERY: &str = "
    WITH owners AS MATERIALIZED (
      SELECT id
      FROM users
      WHERE id > $1
      ORDER BY id
      LIMIT $2
    ), file_counts AS MATERIALIZED (
      SELECT
        files.owner_id,
        count(*) FILTER (
          WHERE files.state = 'active' AND files.entry_type = 'file'
        )::bigint AS total_files,
        count(*) FILTER (
          WHERE files.state = 'active' AND files.entry_type = 'folder'
        )::bigint AS total_folders,
        count(*) FILTER (
          WHERE files.state = 'trashed' AND files.entry_type = 'file'
        )::bigint AS trashed_files,
        count(*) FILTER (
          WHERE files.state = 'active' AND files.favorite
        )::bigint AS favorite_files,
        COALESCE(sum(files.size_bytes) FILTER (
          WHERE files.entry_type = 'file'
        ), 0)::bigint AS used_bytes
      FROM files
      INNER JOIN owners ON owners.id = files.owner_id
      GROUP BY files.owner_id
    ), shared_counts AS MATERIALIZED (
      SELECT
        file_shares.recipient_id AS owner_id,
        count(*)::bigint AS shared_files
      FROM file_shares
      INNER JOIN owners ON owners.id = file_shares.recipient_id
      INNER JOIN files AS shared_files ON shared_files.id = file_shares.file_id
      WHERE shared_files.state = 'active'
        AND shared_files.entry_type = 'file'
      GROUP BY file_shares.recipient_id
    ), expected AS MATERIALIZED (
      SELECT
        owners.id AS owner_id,
        COALESCE(file_counts.total_files, 0)::bigint AS total_files,
        COALESCE(file_counts.total_folders, 0)::bigint AS total_folders,
        COALESCE(file_counts.total_files, 0)::bigint AS active_files,
        COALESCE(file_counts.trashed_files, 0)::bigint AS trashed_files,
        COALESCE(file_counts.favorite_files, 0)::bigint AS favorite_files,
        COALESCE(shared_counts.shared_files, 0)::bigint AS shared_files,
        COALESCE(file_counts.used_bytes, 0)::bigint AS used_bytes
      FROM owners
      LEFT JOIN file_counts ON file_counts.owner_id = owners.id
      LEFT JOIN shared_counts ON shared_counts.owner_id = owners.id
    ), drifted AS MATERIALIZED (
      SELECT expected.*, counters.xmin AS counter_xmin
      FROM expected
      LEFT JOIN user_file_counters AS counters
        ON counters.owner_id = expected.owner_id
      WHERE counters.owner_id IS NULL
         OR ROW(
              counters.total_files,
              counters.total_folders,
              counters.active_files,
              counters.trashed_files,
              counters.favorite_files,
              counters.shared_files,
              counters.used_bytes
            ) IS DISTINCT FROM ROW(
              expected.total_files,
              expected.total_folders,
              expected.active_files,
              expected.trashed_files,
              expected.favorite_files,
              expected.shared_files,
              expected.used_bytes
            )
    ), updated AS (
      UPDATE user_file_counters AS counters
      SET total_files = drifted.total_files,
          total_folders = drifted.total_folders,
          active_files = drifted.active_files,
          trashed_files = drifted.trashed_files,
          favorite_files = drifted.favorite_files,
          shared_files = drifted.shared_files,
          used_bytes = drifted.used_bytes,
          updated_at = now()
      FROM drifted
      WHERE counters.owner_id = drifted.owner_id
        AND counters.xmin = drifted.counter_xmin
      RETURNING counters.owner_id
    ), inserted AS (
      INSERT INTO user_file_counters (
        owner_id,
        total_files,
        total_folders,
        active_files,
        trashed_files,
        favorite_files,
        shared_files,
        used_bytes,
        updated_at
      )
      SELECT
        owner_id,
        total_files,
        total_folders,
        active_files,
        trashed_files,
        favorite_files,
        shared_files,
        used_bytes,
        now()
      FROM drifted
      WHERE counter_xmin IS NULL
      ON CONFLICT (owner_id) DO NOTHING
      RETURNING owner_id
    )
    SELECT
      (SELECT count(*)::bigint FROM owners) AS scanned,
      (
        (SELECT count(*)::bigint FROM updated)
        + (SELECT count(*)::bigint FROM inserted)
      ) AS updated,
      (SELECT max(id) FROM owners) AS next_owner_id
";
const RECONCILE_ADMIN_COUNTERS_QUERY: &str = "
    WITH expected AS (
      SELECT
        (SELECT count(*)::bigint FROM users WHERE status <> 'deleting') AS total_users,
        (SELECT count(*)::bigint FROM users WHERE status = 'active') AS active_users,
        (
          SELECT count(*)::bigint
          FROM users
          WHERE status = 'active' AND role = 'admin'
        ) AS active_admins,
        (
          SELECT count(*)::bigint
          FROM invitations
          WHERE status = 'pending'
        ) AS pending_invitations
    ), drifted AS MATERIALIZED (
      SELECT expected.*, counters.xmin AS counter_xmin
      FROM admin_directory_counters AS counters
      CROSS JOIN expected
      WHERE counters.singleton = TRUE
        AND ROW(
          counters.total_users,
          counters.active_users,
          counters.active_admins,
          counters.pending_invitations
        ) IS DISTINCT FROM ROW(
          expected.total_users,
          expected.active_users,
          expected.active_admins,
          expected.pending_invitations
        )
    )
    UPDATE admin_directory_counters AS counters
    SET total_users = drifted.total_users,
        active_users = drifted.active_users,
        active_admins = drifted.active_admins,
        pending_invitations = drifted.pending_invitations,
        updated_at = now()
    FROM drifted
    WHERE counters.singleton = TRUE
      AND counters.xmin = drifted.counter_xmin
";
const USER_DELETION_PHASES: &[&str] = &[
    "file_uploads",
    "vault_uploads",
    "vault_object_generations",
    "vault_migrations",
    "vault_share_envelopes",
    "vault_share_wrappers",
    "vault_share_owner_keys",
    "vault_revocation_cutoffs",
    "vault_share_pending_revocations",
    "vault_share_recipients",
    "vault_share_epochs",
    "vault_shares",
    "file_shares",
    "share_links",
    "repositories",
    "vault_node_heads",
    "vault_node_records",
    "vault_wrappers",
    "files",
    "vault_identity_trust",
    "vault_identity_keys",
    "user_vaults",
    "invitations",
    "sessions",
    "finalize",
];

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum MaintenanceWorker {
    UserDeletion,
    StorageDeletion,
    UploadFinalization,
    LegacyUploadExpiry,
    VaultUploadExpiry,
    InvitationExpiry,
    SessionExpiry,
    TrashExpiry,
    MultipartReconciliation,
    CounterReconciliation,
}

#[derive(Clone, Copy, Debug)]
struct MaintenanceSchedule {
    worker: MaintenanceWorker,
    initial_delay: Duration,
    interval: Duration,
    maximum_interval: Duration,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum S3RequestPolicy {
    Request,
    Maintenance,
}

impl S3RequestPolicy {
    fn label(self) -> &'static str {
        match self {
            Self::Request => "request",
            Self::Maintenance => "maintenance",
        }
    }

    fn timeout_config(self) -> TimeoutConfig {
        let (connect, read, attempt, operation) = match self {
            Self::Request => (
                S3_REQUEST_CONNECT_TIMEOUT,
                S3_REQUEST_READ_TIMEOUT,
                S3_REQUEST_OPERATION_ATTEMPT_TIMEOUT,
                S3_REQUEST_OPERATION_TIMEOUT,
            ),
            Self::Maintenance => (
                S3_MAINTENANCE_CONNECT_TIMEOUT,
                S3_MAINTENANCE_READ_TIMEOUT,
                S3_MAINTENANCE_OPERATION_ATTEMPT_TIMEOUT,
                S3_MAINTENANCE_OPERATION_TIMEOUT,
            ),
        };
        TimeoutConfig::builder()
            .connect_timeout(connect)
            .read_timeout(read)
            .operation_attempt_timeout(attempt)
            .operation_timeout(operation)
            .build()
    }

    fn retry_config(self) -> RetryConfig {
        RetryConfig::standard().with_max_attempts(match self {
            Self::Request => 2,
            Self::Maintenance => 3,
        })
    }
}

#[derive(Clone)]
struct S3RetryMetricsInterceptor {
    metrics: Metrics,
    policy: S3RequestPolicy,
}

impl fmt::Debug for S3RetryMetricsInterceptor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("S3RetryMetricsInterceptor")
            .field("policy", &self.policy)
            .finish_non_exhaustive()
    }
}

impl S3RetryMetricsInterceptor {
    fn record_attempt(&self, attempts: u32) {
        if attempts > 1 {
            self.metrics.record_s3_retry_attempt(self.policy.label());
        }
    }
}

impl Intercept for S3RetryMetricsInterceptor {
    fn name(&self) -> &'static str {
        "S3RetryMetricsInterceptor"
    }

    fn read_before_attempt(
        &self,
        _context: &BeforeTransmitInterceptorContextRef<'_>,
        _runtime_components: &RuntimeComponents,
        cfg: &mut ConfigBag,
    ) -> Result<(), BoxError> {
        if let Some(attempts) = cfg.load::<RequestAttempts>() {
            self.record_attempt(attempts.attempts());
        }
        Ok(())
    }
}

fn multipart_lifecycle_rule(days: u64) -> Result<LifecycleRule, StorageError> {
    let days = i32::try_from(days)
        .map_err(|_| storage_message("multipart lifecycle age exceeds S3 limits"))?;
    LifecycleRule::builder()
        .id(MULTIPART_LIFECYCLE_RULE_ID)
        .filter(
            LifecycleRuleFilter::builder()
                .prefix(STORAGE_OBJECT_PREFIX)
                .build(),
        )
        .status(ExpirationStatus::Enabled)
        .abort_incomplete_multipart_upload(
            AbortIncompleteMultipartUpload::builder()
                .days_after_initiation(days)
                .build(),
        )
        .build()
        .map_err(storage_error)
}

fn merge_multipart_lifecycle_rule(
    mut rules: Vec<LifecycleRule>,
    desired: LifecycleRule,
) -> (Vec<LifecycleRule>, bool) {
    if rules.iter().any(|rule| rule == &desired) {
        return (rules, false);
    }
    rules.retain(|rule| rule.id() != Some(MULTIPART_LIFECYCLE_RULE_ID));
    rules.push(desired);
    (rules, true)
}

async fn ensure_multipart_lifecycle_backstop(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    days: u64,
) -> Result<(), StorageError> {
    let rules = match client
        .get_bucket_lifecycle_configuration()
        .bucket(bucket)
        .send()
        .await
    {
        Ok(configuration) => configuration.rules().to_vec(),
        Err(error)
            if error
                .as_service_error()
                .and_then(ProvideErrorMetadata::code)
                == Some("NoSuchLifecycleConfiguration") =>
        {
            Vec::new()
        }
        Err(error) => return Err(storage_error(error)),
    };
    let (rules, changed) = merge_multipart_lifecycle_rule(rules, multipart_lifecycle_rule(days)?);
    if !changed {
        return Ok(());
    }
    let lifecycle_configuration = BucketLifecycleConfiguration::builder()
        .set_rules(Some(rules))
        .build()
        .map_err(storage_error)?;
    client
        .put_bucket_lifecycle_configuration()
        .bucket(bucket)
        .lifecycle_configuration(lifecycle_configuration)
        .send()
        .await
        .map_err(storage_error)?;
    Ok(())
}

const MAINTENANCE_SCHEDULES: &[MaintenanceSchedule] = &[
    MaintenanceSchedule {
        worker: MaintenanceWorker::UserDeletion,
        initial_delay: Duration::from_secs(0),
        interval: Duration::from_secs(10),
        maximum_interval: Duration::from_secs(5 * 60),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::StorageDeletion,
        initial_delay: Duration::from_secs(1),
        interval: Duration::from_secs(10),
        maximum_interval: Duration::from_secs(5 * 60),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::UploadFinalization,
        initial_delay: Duration::from_secs(0),
        interval: Duration::from_secs(1),
        maximum_interval: Duration::from_secs(5 * 60),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::LegacyUploadExpiry,
        initial_delay: Duration::from_secs(2),
        interval: Duration::from_secs(10),
        maximum_interval: Duration::from_secs(5 * 60),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::VaultUploadExpiry,
        initial_delay: Duration::from_secs(3),
        interval: Duration::from_secs(10),
        maximum_interval: Duration::from_secs(5 * 60),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::InvitationExpiry,
        initial_delay: Duration::from_secs(4),
        interval: Duration::from_secs(10),
        maximum_interval: Duration::from_secs(5 * 60),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::SessionExpiry,
        initial_delay: Duration::from_secs(5),
        interval: Duration::from_secs(10),
        maximum_interval: Duration::from_secs(5 * 60),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::TrashExpiry,
        initial_delay: Duration::from_secs(6),
        interval: Duration::from_secs(10),
        maximum_interval: Duration::from_secs(5 * 60),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::MultipartReconciliation,
        initial_delay: Duration::from_secs(0),
        interval: Duration::from_secs(60 * 60),
        maximum_interval: Duration::from_secs(60 * 60),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::CounterReconciliation,
        initial_delay: Duration::from_secs(30 * 60),
        interval: Duration::from_secs(24 * 60 * 60),
        maximum_interval: Duration::from_secs(24 * 60 * 60),
    },
];

fn effective_maintenance_schedule(
    mut schedule: MaintenanceSchedule,
    lifecycle_backstop_enabled: bool,
) -> MaintenanceSchedule {
    if schedule.worker == MaintenanceWorker::MultipartReconciliation && lifecycle_backstop_enabled {
        schedule.interval = LIFECYCLE_BACKED_RECONCILIATION_INTERVAL;
        schedule.maximum_interval = LIFECYCLE_BACKED_RECONCILIATION_INTERVAL;
    }
    schedule
}

#[derive(Clone)]
pub enum Storage {
    Local {
        root: PathBuf,
    },
    S3 {
        client: aws_sdk_s3::Client,
        maintenance_client: aws_sdk_s3::Client,
        bucket: String,
        legacy_root: PathBuf,
        presign_seconds: u64,
        multipart_threshold_bytes: u64,
        multipart_part_bytes: u64,
        multipart_orphan_grace_seconds: u64,
        lifecycle_backstop_enabled: bool,
    },
}

#[derive(Debug)]
pub struct StorageError {
    message: String,
    not_found: bool,
}

impl StorageError {
    pub fn is_not_found(&self) -> bool {
        self.not_found
    }
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl StdError for StorageError {}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadPartPlan {
    pub part_number: i32,
    pub etag: String,
    pub checksum_sha256: Option<String>,
}

pub struct PreparedUpload {
    pub mode: &'static str,
    pub upload_url: Option<String>,
    pub parts: Vec<UploadPartPlan>,
    pub multipart_upload_id: Option<String>,
    pub part_size_bytes: Option<u64>,
}

#[derive(Clone)]
pub struct UploadedPart {
    pub part_number: i32,
    pub etag: String,
    pub checksum_sha256: String,
}

pub struct ObjectMetadata {
    pub size_bytes: u64,
    pub checksum_sha256: Option<String>,
    pub etag: Option<String>,
}

pub struct MultipartUploadSession {
    pub object_key: String,
    pub upload_id: String,
    pub initiated_epoch_seconds: i64,
}

pub struct MultipartUploadPage {
    pub uploads: Vec<MultipartUploadSession>,
    pub next_key_marker: Option<String>,
    pub next_upload_id_marker: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MultipartIntentSource {
    File,
    Vault,
}

#[derive(Debug)]
struct MultipartIntent {
    source: MultipartIntentSource,
    status: String,
    upload_id: Option<String>,
    protected_until: SystemTime,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MultipartReconciliationAction {
    Keep,
    Adopt(MultipartIntentSource),
    Abort,
}

impl Storage {
    pub async fn create(config: &Config, metrics: Metrics) -> Result<Self, StorageError> {
        if config.storage_backend == "local" {
            let root = PathBuf::from(&config.storage_path);
            tokio::fs::create_dir_all(&root)
                .await
                .map_err(storage_error)?;

            return Ok(Self::Local { root });
        }

        let bucket = required(config.s3_bucket.clone(), "S3 bucket")?;
        let endpoint = required(config.s3_endpoint.clone(), "S3 endpoint")?;
        let access_key_id = required(config.s3_access_key_id.clone(), "S3 access key")?;
        let secret_access_key =
            required(config.s3_secret_access_key.clone(), "S3 secret access key")?;
        let credentials = Credentials::new(
            access_key_id,
            secret_access_key,
            None,
            None,
            "aeralyth-storage",
        );
        let shared_config = aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(config.s3_region.clone()))
            .credentials_provider(credentials)
            .load()
            .await;
        let s3_config = aws_sdk_s3::config::Builder::from(&shared_config)
            .endpoint_url(endpoint.clone())
            .force_path_style(config.s3_force_path_style)
            .timeout_config(S3RequestPolicy::Request.timeout_config())
            .retry_config(S3RequestPolicy::Request.retry_config())
            .interceptor(S3RetryMetricsInterceptor {
                metrics: metrics.clone(),
                policy: S3RequestPolicy::Request,
            })
            .build();
        let maintenance_s3_config = aws_sdk_s3::config::Builder::from(&shared_config)
            .endpoint_url(endpoint)
            .force_path_style(config.s3_force_path_style)
            .timeout_config(S3RequestPolicy::Maintenance.timeout_config())
            .retry_config(S3RequestPolicy::Maintenance.retry_config())
            .interceptor(S3RetryMetricsInterceptor {
                metrics,
                policy: S3RequestPolicy::Maintenance,
            })
            .build();
        let client = aws_sdk_s3::Client::from_conf(s3_config);
        let maintenance_client = aws_sdk_s3::Client::from_conf(maintenance_s3_config);
        if let Some(days) = config.s3_abort_incomplete_multipart_days {
            ensure_multipart_lifecycle_backstop(&maintenance_client, &bucket, days).await?;
        }

        Ok(Self::S3 {
            client,
            maintenance_client,
            bucket,
            legacy_root: PathBuf::from(&config.storage_path),
            presign_seconds: config.storage_presign_seconds,
            multipart_threshold_bytes: config.storage_multipart_threshold_bytes,
            multipart_part_bytes: config.storage_multipart_part_bytes,
            multipart_orphan_grace_seconds: config.storage_multipart_orphan_grace_seconds,
            lifecycle_backstop_enabled: config.s3_abort_incomplete_multipart_days.is_some(),
        })
    }

    fn lifecycle_backstop_enabled(&self) -> bool {
        matches!(
            self,
            Self::S3 {
                lifecycle_backstop_enabled: true,
                ..
            }
        )
    }

    pub fn backend_name(&self) -> &'static str {
        match self {
            Self::Local { .. } => "local",
            Self::S3 { .. } => "s3",
        }
    }

    pub fn upload_mode(&self, size_bytes: u64) -> &'static str {
        match self {
            Self::Local { .. } => "local",
            Self::S3 {
                multipart_threshold_bytes,
                ..
            } if size_bytes >= *multipart_threshold_bytes => "multipart",
            Self::S3 { .. } => "single",
        }
    }

    pub fn local_path(&self, object_key: &str) -> Option<PathBuf> {
        match self {
            Self::Local { root } => safe_local_path(root, object_key),
            Self::S3 { .. } => None,
        }
    }

    pub fn local_path_for_owner(&self, object_key: &str, owner_id: &str) -> Option<PathBuf> {
        if object_key.contains('/') {
            return self.local_path(object_key);
        }

        match self {
            Self::Local { root } => safe_local_path(root, &format!("{owner_id}/{object_key}")),
            Self::S3 { legacy_root, .. } => {
                safe_local_path(legacy_root, &format!("{owner_id}/{object_key}"))
            }
        }
    }

    pub async fn prepare_upload(
        &self,
        upload_id: &str,
        object_key: &str,
        content_type: Option<&str>,
        size_bytes: u64,
    ) -> Result<PreparedUpload, StorageError> {
        match self {
            Self::Local { .. } => Ok(PreparedUpload {
                mode: "local",
                upload_url: Some(format!("/api/files/uploads/{upload_id}/content")),
                parts: Vec::new(),
                multipart_upload_id: None,
                part_size_bytes: None,
            }),
            Self::S3 {
                client,
                bucket,
                multipart_threshold_bytes,
                multipart_part_bytes,
                ..
            } if size_bytes >= *multipart_threshold_bytes => {
                let output = client
                    .create_multipart_upload()
                    .bucket(bucket)
                    .key(object_key)
                    .set_content_type(content_type.map(str::to_owned))
                    .checksum_algorithm(ChecksumAlgorithm::Sha256)
                    .send()
                    .await
                    .map_err(storage_error)?;
                let multipart_upload_id = output
                    .upload_id()
                    .map(str::to_owned)
                    .ok_or_else(|| storage_message("S3 did not return a multipart upload id"))?;
                Ok(PreparedUpload {
                    mode: "multipart",
                    upload_url: None,
                    parts: Vec::new(),
                    multipart_upload_id: Some(multipart_upload_id),
                    part_size_bytes: Some(*multipart_part_bytes),
                })
            }
            Self::S3 { .. } => Ok(PreparedUpload {
                mode: "single",
                upload_url: None,
                parts: Vec::new(),
                multipart_upload_id: None,
                part_size_bytes: None,
            }),
        }
    }

    pub async fn prepare_vault_upload(
        &self,
        object_key: &str,
        size_bytes: u64,
    ) -> Result<PreparedUpload, StorageError> {
        let Self::S3 { client, bucket, .. } = self else {
            return Err(storage_message(
                "encrypted vault uploads require S3 storage",
            ));
        };

        if uses_vault_multipart_upload(size_bytes) {
            let output = client
                .create_multipart_upload()
                .bucket(bucket)
                .key(object_key)
                .content_type("application/octet-stream")
                .checksum_algorithm(ChecksumAlgorithm::Sha256)
                .send()
                .await
                .map_err(storage_error)?;
            let multipart_upload_id = output
                .upload_id()
                .map(str::to_owned)
                .ok_or_else(|| storage_message("S3 did not return a multipart upload id"))?;

            return Ok(PreparedUpload {
                mode: "multipart",
                upload_url: None,
                parts: Vec::new(),
                multipart_upload_id: Some(multipart_upload_id),
                part_size_bytes: Some(UPLOAD_PART_BYTES),
            });
        }

        Ok(PreparedUpload {
            mode: "single",
            upload_url: None,
            parts: Vec::new(),
            multipart_upload_id: None,
            part_size_bytes: None,
        })
    }

    pub async fn presign_single_upload(
        &self,
        object_key: &str,
        content_type: &str,
        checksum_sha256: &str,
        content_length: u64,
    ) -> Result<String, StorageError> {
        let Self::S3 {
            client,
            bucket,
            presign_seconds,
            ..
        } = self
        else {
            return Err(storage_message(
                "single-object presigning requires S3 storage",
            ));
        };
        let content_length = i64::try_from(content_length)
            .map_err(|_| storage_message("upload content length is invalid"))?;
        let request = client
            .put_object()
            .bucket(bucket)
            .key(object_key)
            .content_type(content_type)
            .checksum_sha256(checksum_sha256)
            .content_length(content_length)
            .presigned(presigning_config(*presign_seconds)?)
            .await
            .map_err(storage_error)?;

        Ok(request.uri().to_string())
    }

    pub async fn presign_upload_part(
        &self,
        object_key: &str,
        multipart_upload_id: &str,
        part_number: i32,
        checksum_sha256: &str,
        content_length: u64,
    ) -> Result<String, StorageError> {
        let Self::S3 {
            client,
            bucket,
            presign_seconds,
            ..
        } = self
        else {
            return Err(storage_message("multipart presigning requires S3 storage"));
        };
        let content_length = i64::try_from(content_length)
            .map_err(|_| storage_message("upload part length is invalid"))?;
        let request = client
            .upload_part()
            .bucket(bucket)
            .key(object_key)
            .upload_id(multipart_upload_id)
            .part_number(part_number)
            .checksum_sha256(checksum_sha256)
            .content_length(content_length)
            .presigned(presigning_config(*presign_seconds)?)
            .await
            .map_err(storage_error)?;

        Ok(request.uri().to_string())
    }

    pub async fn uploaded_parts(
        &self,
        object_key: &str,
        multipart_upload_id: &str,
    ) -> Result<Vec<UploadPartPlan>, StorageError> {
        let Self::S3 { client, bucket, .. } = self else {
            return Ok(Vec::new());
        };
        let mut marker: Option<String> = None;
        let mut parts = Vec::new();

        loop {
            let output = client
                .list_parts()
                .bucket(bucket)
                .key(object_key)
                .upload_id(multipart_upload_id)
                .set_part_number_marker(marker.clone())
                .send()
                .await
                .map_err(storage_error)?;

            for part in output.parts() {
                let Some(part_number) = part.part_number() else {
                    continue;
                };
                let Some(etag) = part.e_tag().map(str::to_owned) else {
                    continue;
                };
                parts.push(UploadPartPlan {
                    part_number,
                    etag,
                    checksum_sha256: part.checksum_sha256().map(str::to_owned),
                });
            }

            if output.is_truncated() != Some(true) {
                break;
            }
            marker = output.next_part_number_marker().map(str::to_owned);

            if marker.is_none() {
                break;
            }
        }

        Ok(parts)
    }

    pub async fn multipart_upload_page(
        &self,
        prefix: &str,
        key_marker: Option<&str>,
        upload_id_marker: Option<&str>,
    ) -> Result<MultipartUploadPage, StorageError> {
        let Self::S3 {
            maintenance_client,
            bucket,
            ..
        } = self
        else {
            return Ok(MultipartUploadPage {
                uploads: Vec::new(),
                next_key_marker: None,
                next_upload_id_marker: None,
            });
        };
        let output = maintenance_client
            .list_multipart_uploads()
            .bucket(bucket)
            .prefix(prefix)
            .set_key_marker(key_marker.map(str::to_owned))
            .set_upload_id_marker(upload_id_marker.map(str::to_owned))
            .max_uploads(1_000)
            .send()
            .await
            .map_err(storage_error)?;
        let mut uploads = Vec::new();

        for upload in output.uploads() {
            let (Some(object_key), Some(upload_id), Some(initiated)) =
                (upload.key(), upload.upload_id(), upload.initiated())
            else {
                log::warn!("S3 returned an incomplete multipart upload listing entry");
                continue;
            };
            uploads.push(MultipartUploadSession {
                object_key: object_key.to_owned(),
                upload_id: upload_id.to_owned(),
                initiated_epoch_seconds: initiated.secs(),
            });
        }
        let is_truncated = output.is_truncated() == Some(true);
        let next_key_marker = output.next_key_marker().map(str::to_owned);
        let next_upload_id_marker = output.next_upload_id_marker().map(str::to_owned);

        if is_truncated && (next_key_marker.is_none() || next_upload_id_marker.is_none()) {
            return Err(storage_message(
                "S3 multipart listing omitted required pagination markers",
            ));
        }

        Ok(MultipartUploadPage {
            uploads,
            next_key_marker: is_truncated.then_some(next_key_marker).flatten(),
            next_upload_id_marker: is_truncated.then_some(next_upload_id_marker).flatten(),
        })
    }

    pub async fn abort_multipart_uploads_for_key(
        &self,
        object_key: &str,
    ) -> Result<(), StorageError> {
        let mut key_marker: Option<String> = None;
        let mut upload_id_marker: Option<String> = None;

        loop {
            let page = self
                .multipart_upload_page(
                    object_key,
                    key_marker.as_deref(),
                    upload_id_marker.as_deref(),
                )
                .await?;
            let outcomes = stream::iter(
                page.uploads
                    .into_iter()
                    .filter(|upload| upload.object_key == object_key),
            )
            .map(|upload| async move {
                self.abort_multipart(&upload.object_key, &upload.upload_id)
                    .await
            })
            .buffer_unordered(8)
            .collect::<Vec<_>>()
            .await;
            for outcome in outcomes {
                outcome?;
            }

            let next_key_marker = page.next_key_marker;
            let next_upload_id_marker = page.next_upload_id_marker;
            if next_key_marker.is_none() {
                break;
            }
            if next_key_marker == key_marker && next_upload_id_marker == upload_id_marker {
                return Err(storage_message(
                    "S3 multipart listing did not advance its pagination markers",
                ));
            }
            key_marker = next_key_marker;
            upload_id_marker = next_upload_id_marker;
        }

        Ok(())
    }

    pub fn multipart_orphan_grace_seconds(&self) -> Option<u64> {
        match self {
            Self::Local { .. } => None,
            Self::S3 {
                multipart_orphan_grace_seconds,
                ..
            } => Some(*multipart_orphan_grace_seconds),
        }
    }

    pub fn presign_seconds(&self) -> u64 {
        match self {
            Self::Local { .. } => 0,
            Self::S3 {
                presign_seconds, ..
            } => *presign_seconds,
        }
    }

    pub async fn complete_multipart(
        &self,
        object_key: &str,
        multipart_upload_id: &str,
        parts: &[UploadedPart],
        expected_size_bytes: u64,
    ) -> Result<ObjectMetadata, StorageError> {
        let Self::S3 { client, bucket, .. } = self else {
            return Ok(ObjectMetadata {
                size_bytes: expected_size_bytes,
                checksum_sha256: None,
                etag: None,
            });
        };
        let completed_parts = parts
            .iter()
            .map(|part| {
                CompletedPart::builder()
                    .part_number(part.part_number)
                    .e_tag(part.etag.clone())
                    .checksum_sha256(part.checksum_sha256.clone())
                    .build()
            })
            .collect::<Vec<_>>();
        let multipart = CompletedMultipartUpload::builder()
            .set_parts(Some(completed_parts))
            .build();

        let output = client
            .complete_multipart_upload()
            .bucket(bucket)
            .key(object_key)
            .upload_id(multipart_upload_id)
            .multipart_upload(multipart)
            .send()
            .await
            .map_err(storage_error)?;

        Ok(ObjectMetadata {
            size_bytes: expected_size_bytes,
            checksum_sha256: output.checksum_sha256().map(str::to_owned),
            etag: output.e_tag().map(str::to_owned),
        })
    }

    pub async fn abort_multipart(
        &self,
        object_key: &str,
        multipart_upload_id: &str,
    ) -> Result<(), StorageError> {
        let Self::S3 {
            maintenance_client,
            bucket,
            ..
        } = self
        else {
            return Ok(());
        };

        let result = maintenance_client
            .abort_multipart_upload()
            .bucket(bucket)
            .key(object_key)
            .upload_id(multipart_upload_id)
            .send()
            .await;

        match result {
            Ok(_) => {}
            Err(error)
                if error
                    .as_service_error()
                    .is_some_and(|service_error| service_error.is_no_such_upload()) => {}
            Err(error) => return Err(storage_error(error)),
        }

        Ok(())
    }

    pub async fn object_metadata(&self, object_key: &str) -> Result<ObjectMetadata, StorageError> {
        self.object_metadata_with_policy(object_key, S3RequestPolicy::Request)
            .await
    }

    async fn maintenance_object_metadata(
        &self,
        object_key: &str,
    ) -> Result<ObjectMetadata, StorageError> {
        self.object_metadata_with_policy(object_key, S3RequestPolicy::Maintenance)
            .await
    }

    async fn object_metadata_with_policy(
        &self,
        object_key: &str,
        policy: S3RequestPolicy,
    ) -> Result<ObjectMetadata, StorageError> {
        match self {
            Self::Local { .. } => {
                let path = self
                    .local_path(object_key)
                    .ok_or_else(|| storage_message("invalid local object key"))?;
                let metadata = tokio::fs::metadata(path).await.map_err(storage_io_error)?;
                Ok(ObjectMetadata {
                    size_bytes: metadata.len(),
                    checksum_sha256: None,
                    etag: None,
                })
            }
            Self::S3 {
                client,
                maintenance_client,
                bucket,
                ..
            } => {
                let client = match policy {
                    S3RequestPolicy::Request => client,
                    S3RequestPolicy::Maintenance => maintenance_client,
                };
                let output = client
                    .head_object()
                    .bucket(bucket)
                    .key(object_key)
                    .checksum_mode(ChecksumMode::Enabled)
                    .send()
                    .await
                    .map_err(|error| {
                        let not_found = error
                            .as_service_error()
                            .is_some_and(|service_error| service_error.is_not_found());
                        StorageError {
                            message: error.to_string(),
                            not_found,
                        }
                    })?;
                let size = output
                    .content_length()
                    .ok_or_else(|| storage_message("S3 object length is missing"))?;

                let size_bytes = u64::try_from(size)
                    .map_err(|_| storage_message("S3 object length is invalid"))?;

                Ok(ObjectMetadata {
                    size_bytes,
                    checksum_sha256: output.checksum_sha256().map(str::to_owned),
                    etag: output.e_tag().map(str::to_owned),
                })
            }
        }
    }

    pub async fn download_url(
        &self,
        object_key: &str,
        filename: &str,
    ) -> Result<Option<String>, StorageError> {
        if !object_key.contains('/') {
            return Ok(None);
        }

        let Self::S3 {
            client,
            bucket,
            presign_seconds,
            ..
        } = self
        else {
            return Ok(None);
        };
        let disposition = format!(
            "attachment; filename=\"{}\"",
            filename.replace(['\r', '\n', '"'], "")
        );
        let request = client
            .get_object()
            .bucket(bucket)
            .key(object_key)
            .response_content_disposition(disposition)
            .presigned(presigning_config(*presign_seconds)?)
            .await
            .map_err(storage_error)?;

        Ok(Some(request.uri().to_string()))
    }

    pub async fn delete_object(&self, object_key: &str) -> Result<(), StorageError> {
        match self {
            Self::Local { .. } => {
                if let Some(path) = self.local_path(object_key) {
                    match tokio::fs::remove_file(path).await {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(storage_error(error)),
                    }
                }
            }
            Self::S3 {
                maintenance_client,
                bucket,
                legacy_root,
                ..
            } => {
                if !object_key.starts_with("users/") {
                    if let Some(path) = safe_local_path(legacy_root, object_key) {
                        match tokio::fs::remove_file(path).await {
                            Ok(()) => {}
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                            Err(error) => return Err(storage_error(error)),
                        }
                    }
                    return Ok(());
                }

                maintenance_client
                    .delete_object()
                    .bucket(bucket)
                    .key(object_key)
                    .send()
                    .await
                    .map_err(storage_error)?;
            }
        }

        Ok(())
    }

    fn supports_bulk_delete(&self, object_key: &str) -> bool {
        matches!(self, Self::S3 { .. }) && object_key.starts_with(STORAGE_OBJECT_PREFIX)
    }

    pub async fn delete_objects(&self, object_keys: &[String]) -> Vec<Result<(), StorageError>> {
        if object_keys.is_empty() {
            return Vec::new();
        }
        if object_keys.len() > 1_000
            || !object_keys.iter().all(|key| self.supports_bulk_delete(key))
        {
            let message = if object_keys.len() > 1_000 {
                "S3 bulk deletion accepts at most 1,000 objects"
            } else {
                "the object batch is not eligible for S3 bulk deletion"
            };
            return object_keys
                .iter()
                .map(|_| Err(storage_message(message)))
                .collect();
        }
        let Self::S3 {
            maintenance_client,
            bucket,
            ..
        } = self
        else {
            unreachable!("bulk deletion eligibility requires S3 storage");
        };
        let identifiers = object_keys
            .iter()
            .map(|key| ObjectIdentifier::builder().key(key).build())
            .collect::<Result<Vec<_>, _>>();
        let identifiers = match identifiers {
            Ok(identifiers) => identifiers,
            Err(error) => {
                let message = error.to_string();
                return object_keys
                    .iter()
                    .map(|_| Err(storage_message(message.clone())))
                    .collect();
            }
        };
        let request = match Delete::builder()
            .set_objects(Some(identifiers))
            .quiet(true)
            .build()
        {
            Ok(request) => request,
            Err(error) => {
                let message = error.to_string();
                return object_keys
                    .iter()
                    .map(|_| Err(storage_message(message.clone())))
                    .collect();
            }
        };
        let output = match maintenance_client
            .delete_objects()
            .bucket(bucket)
            .delete(request)
            .send()
            .await
        {
            Ok(output) => output,
            Err(error) => {
                let message = error.to_string();
                return object_keys
                    .iter()
                    .map(|_| Err(storage_message(message.clone())))
                    .collect();
            }
        };
        let mut failures = HashMap::new();
        let mut unscoped_failure = None;
        for error in output.errors() {
            let message = format!(
                "S3 bulk deletion failed{}{}",
                error
                    .code()
                    .map(|code| format!(" with {code}"))
                    .unwrap_or_default(),
                error
                    .message()
                    .map(|message| format!(": {message}"))
                    .unwrap_or_default(),
            );
            if let Some(key) = error.key() {
                failures.insert(key.to_owned(), message);
            } else {
                unscoped_failure = Some(message);
            }
        }

        object_keys
            .iter()
            .map(|key| {
                failures
                    .get(key)
                    .or(unscoped_failure.as_ref())
                    .map_or_else(|| Ok(()), |message| Err(storage_message(message.clone())))
            })
            .collect()
    }
}

pub async fn run_maintenance(
    db: Database,
    storage: Storage,
    metrics: Metrics,
    database_url: String,
    shutdown: watch::Receiver<bool>,
    storage_concurrency: usize,
) {
    let (notifications, _) = broadcast::channel::<String>(256);
    let mut supervisors = JoinSet::new();
    supervisors.spawn(supervise_maintenance_notifications(
        database_url,
        notifications.clone(),
        shutdown.clone(),
    ));
    for schedule in MAINTENANCE_SCHEDULES.iter().copied() {
        let schedule =
            effective_maintenance_schedule(schedule, storage.lifecycle_backstop_enabled());
        supervisors.spawn(supervise_maintenance_worker(
            schedule,
            db.clone(),
            storage.clone(),
            metrics.clone(),
            shutdown.clone(),
            storage_concurrency,
            notifications.clone(),
        ));
    }

    while let Some(result) = supervisors.join_next().await {
        if let Err(error) = result {
            log::error!("maintenance supervisor stopped unexpectedly: {error}");
        }
    }
}

async fn supervise_maintenance_notifications(
    database_url: String,
    notifications: broadcast::Sender<String>,
    shutdown: watch::Receiver<bool>,
) {
    loop {
        if *shutdown.borrow() {
            return;
        }
        let connection_result = select(
            Box::pin(wait_for_shutdown(shutdown.clone())),
            Box::pin(tokio_postgres::connect(&database_url, NoTls)),
        )
        .await;
        let Either::Right((connection_result, _)) = connection_result else {
            return;
        };
        let (client, connection) = match connection_result {
            Ok(connected) => connected,
            Err(error) => {
                log::error!("maintenance notification listener could not connect: {error}");
                let _ = notifications.send("__all__".to_owned());
                if wait_for_restart_or_shutdown(shutdown.clone()).await {
                    return;
                }
                continue;
            }
        };
        let (message_sender, mut message_receiver) = mpsc::channel(256);
        let connection_task = tokio::spawn(async move {
            let mut messages = stream::poll_fn({
                let mut connection = connection;
                move |context| connection.poll_message(context)
            });
            while let Some(message) = messages.next().await {
                if message_sender.send(message).await.is_err() {
                    break;
                }
            }
        });
        let listen_result = select(
            Box::pin(wait_for_shutdown(shutdown.clone())),
            Box::pin(client.batch_execute("LISTEN aeralyth_maintenance")),
        )
        .await;
        let listen_result = match listen_result {
            Either::Left(_) => {
                connection_task.abort();
                return;
            }
            Either::Right((listen_result, _)) => listen_result,
        };
        if let Err(error) = listen_result {
            connection_task.abort();
            log::error!("maintenance notification listener could not subscribe: {error}");
            let _ = notifications.send("__all__".to_owned());
            if wait_for_restart_or_shutdown(shutdown.clone()).await {
                return;
            }
            continue;
        }

        loop {
            let next = select(
                Box::pin(wait_for_shutdown(shutdown.clone())),
                Box::pin(message_receiver.recv()),
            )
            .await;
            match next {
                Either::Left(_) => {
                    connection_task.abort();
                    return;
                }
                Either::Right((Some(Ok(AsyncMessage::Notification(notification))), _)) => {
                    let _ = notifications.send(notification.payload().to_owned());
                }
                Either::Right((Some(Ok(_)), _)) => {}
                Either::Right((Some(Err(error)), _)) => {
                    log::error!("maintenance notification listener failed: {error}");
                    let _ = notifications.send("__all__".to_owned());
                    break;
                }
                Either::Right((None, _)) => {
                    let _ = notifications.send("__all__".to_owned());
                    break;
                }
            }
        }
        connection_task.abort();
        if wait_for_restart_or_shutdown(shutdown.clone()).await {
            return;
        }
    }
}

async fn wait_for_restart_or_shutdown(shutdown: watch::Receiver<bool>) -> bool {
    matches!(
        select(
            Box::pin(wait_for_shutdown(shutdown)),
            Box::pin(sleep(MAINTENANCE_RESTART_DELAY)),
        )
        .await,
        Either::Left(_)
    )
}

async fn supervise_maintenance_worker(
    schedule: MaintenanceSchedule,
    db: Database,
    storage: Storage,
    metrics: Metrics,
    shutdown: watch::Receiver<bool>,
    storage_concurrency: usize,
    notifications: broadcast::Sender<String>,
) {
    loop {
        if *shutdown.borrow() {
            return;
        }

        let worker = tokio::spawn(run_maintenance_worker(
            schedule,
            db.clone(),
            storage.clone(),
            metrics.clone(),
            shutdown.clone(),
            storage_concurrency,
            notifications.subscribe(),
        ));
        let outcome = worker.await;
        if *shutdown.borrow() {
            return;
        }
        metrics.record_maintenance_restart(schedule.worker.label());

        match outcome {
            Ok(()) => log::error!(
                "{} maintenance worker exited unexpectedly; restarting",
                schedule.worker.label()
            ),
            Err(error) => log::error!(
                "{} maintenance worker panicked or was cancelled: {error}; restarting",
                schedule.worker.label()
            ),
        }

        if matches!(
            select(
                Box::pin(wait_for_shutdown(shutdown.clone())),
                Box::pin(sleep(MAINTENANCE_RESTART_DELAY)),
            )
            .await,
            Either::Left(_)
        ) {
            return;
        }
    }
}

async fn run_maintenance_worker(
    schedule: MaintenanceSchedule,
    db: Database,
    storage: Storage,
    metrics: Metrics,
    shutdown: watch::Receiver<bool>,
    storage_concurrency: usize,
    notifications: broadcast::Receiver<String>,
) {
    run_adaptive_task(
        schedule.worker,
        schedule.initial_delay,
        schedule.interval,
        schedule.maximum_interval,
        shutdown,
        notifications,
        move || {
            let db = db.clone();
            let storage = storage.clone();
            let metrics = metrics.clone();
            async move {
                let started = Instant::now();
                let outcome = schedule
                    .worker
                    .run(&db, &storage, &metrics, storage_concurrency)
                    .await;
                let success = outcome.is_ok();
                let iteration = match outcome {
                    Ok(true) => MaintenanceIteration::worked(),
                    Ok(false) => match schedule.worker.next_due_delay(&db).await {
                        Ok(next_due) => MaintenanceIteration {
                            did_work: false,
                            next_due,
                        },
                        Err(error) => {
                            log::error!(
                                "{} maintenance next-due query failed: {error}",
                                schedule.worker.label()
                            );
                            MaintenanceIteration::worked()
                        }
                    },
                    Err(error) => {
                        log::error!(
                            "{} maintenance worker failed: {error}",
                            schedule.worker.label()
                        );
                        MaintenanceIteration::worked()
                    }
                };
                metrics.record_maintenance(schedule.worker.label(), started.elapsed(), success);
                iteration
            }
        },
    )
    .await;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MaintenanceIteration {
    did_work: bool,
    next_due: Option<Duration>,
}

impl MaintenanceIteration {
    const fn worked() -> Self {
        Self {
            did_work: true,
            next_due: None,
        }
    }
}

async fn run_adaptive_task<Operation, OperationFuture>(
    worker: MaintenanceWorker,
    initial_delay: Duration,
    base_interval: Duration,
    maximum_interval: Duration,
    shutdown: watch::Receiver<bool>,
    mut notifications: broadcast::Receiver<String>,
    mut operation: Operation,
) where
    Operation: FnMut() -> OperationFuture,
    OperationFuture: Future<Output = MaintenanceIteration>,
{
    if *shutdown.borrow() {
        return;
    }

    let mut idle_interval = base_interval;
    let mut next_delay = initial_delay;
    loop {
        let wake = select(
            Box::pin(wait_for_shutdown(shutdown.clone())),
            Box::pin(select(
                Box::pin(sleep(next_delay)),
                Box::pin(wait_for_maintenance_notification(
                    &mut notifications,
                    worker,
                )),
            )),
        )
        .await;
        let Either::Right((wake_source, _)) = wake else {
            break;
        };
        if matches!(wake_source, Either::Right(_)) {
            idle_interval = base_interval;
        }

        let operation_result = select(
            Box::pin(wait_for_shutdown(shutdown.clone())),
            Box::pin(operation()),
        )
        .await;
        let iteration = match operation_result {
            Either::Left(_) => break,
            Either::Right((iteration, _)) => iteration,
        };
        (idle_interval, next_delay) =
            adaptive_maintenance_delay(idle_interval, base_interval, maximum_interval, iteration);
    }
}

fn adaptive_maintenance_delay(
    idle_interval: Duration,
    base_interval: Duration,
    maximum_interval: Duration,
    iteration: MaintenanceIteration,
) -> (Duration, Duration) {
    let idle_interval = if iteration.did_work {
        base_interval
    } else {
        idle_interval
            .checked_mul(2)
            .unwrap_or(maximum_interval)
            .min(maximum_interval)
    };
    let next_delay = iteration.next_due.map_or(idle_interval, |due| {
        idle_interval.min(due.max(base_interval))
    });
    (idle_interval, next_delay)
}

async fn wait_for_maintenance_notification(
    notifications: &mut broadcast::Receiver<String>,
    worker: MaintenanceWorker,
) {
    loop {
        match notifications.recv().await {
            Ok(payload) if worker.accepts_notification(&payload) => return,
            Ok(_) => {}
            Err(broadcast::error::RecvError::Lagged(_)) => return,
            Err(broadcast::error::RecvError::Closed) => {
                std::future::pending::<()>().await;
            }
        }
    }
}

#[cfg(test)]
async fn run_periodic_task<Operation, OperationFuture>(
    initial_delay: Duration,
    period: Duration,
    shutdown: watch::Receiver<bool>,
    mut operation: Operation,
) where
    Operation: FnMut() -> OperationFuture,
    OperationFuture: Future<Output = ()>,
{
    if *shutdown.borrow() {
        return;
    }

    let mut task_interval = interval_at(Instant::now() + initial_delay, period);
    task_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        if matches!(
            select(
                Box::pin(wait_for_shutdown(shutdown.clone())),
                Box::pin(task_interval.tick()),
            )
            .await,
            Either::Left(_)
        ) {
            break;
        }
        if matches!(
            select(
                Box::pin(wait_for_shutdown(shutdown.clone())),
                Box::pin(operation()),
            )
            .await,
            Either::Left(_)
        ) {
            break;
        }
    }
}

async fn wait_for_shutdown(mut shutdown: watch::Receiver<bool>) {
    while !*shutdown.borrow() {
        if shutdown.changed().await.is_err() {
            return;
        }
    }
}

impl MaintenanceWorker {
    const fn label(self) -> &'static str {
        match self {
            Self::UserDeletion => "user deletion",
            Self::StorageDeletion => "storage deletion",
            Self::UploadFinalization => "upload finalization",
            Self::LegacyUploadExpiry => "legacy upload expiry",
            Self::VaultUploadExpiry => "encrypted upload expiry",
            Self::InvitationExpiry => "invitation expiry",
            Self::SessionExpiry => "session expiry",
            Self::TrashExpiry => "trash expiry",
            Self::MultipartReconciliation => "multipart reconciliation",
            Self::CounterReconciliation => "counter reconciliation",
        }
    }

    fn accepts_notification(self, table: &str) -> bool {
        if table == "__all__" {
            return true;
        }
        match self {
            Self::UserDeletion => matches!(table, "user_deletion_jobs"),
            Self::StorageDeletion => matches!(table, "storage_deletion_jobs"),
            Self::UploadFinalization | Self::LegacyUploadExpiry => {
                matches!(table, "file_uploads")
            }
            Self::VaultUploadExpiry => matches!(table, "vault_uploads"),
            Self::InvitationExpiry => matches!(table, "invitations"),
            Self::SessionExpiry => matches!(table, "sessions"),
            Self::TrashExpiry => matches!(table, "files" | "users"),
            Self::MultipartReconciliation | Self::CounterReconciliation => false,
        }
    }

    async fn next_due_delay(
        self,
        db: &Database,
    ) -> Result<Option<Duration>, Box<dyn StdError + Send + Sync>> {
        let due_expression = match self {
            Self::UserDeletion => {
                "SELECT MIN(GREATEST(available_at, COALESCE(locked_until, available_at))) AS next_at FROM user_deletion_jobs WHERE dead_lettered_at IS NULL"
            }
            Self::StorageDeletion => {
                "SELECT MIN(GREATEST(available_at, COALESCE(locked_until, available_at))) AS next_at FROM storage_deletion_jobs WHERE dead_lettered_at IS NULL"
            }
            Self::UploadFinalization => {
                "SELECT MIN(GREATEST(completion_available_at, COALESCE(completion_locked_until, completion_available_at))) AS next_at FROM file_uploads WHERE status = 'completing' AND completion_dead_lettered_at IS NULL"
            }
            Self::LegacyUploadExpiry => {
                "SELECT MIN(expires_at) AS next_at FROM file_uploads WHERE status IN ('initializing', 'pending', 'aborting')"
            }
            Self::VaultUploadExpiry => {
                "SELECT MIN(expires_at) AS next_at FROM vault_uploads WHERE status IN ('initializing', 'pending', 'completing', 'aborting')"
            }
            Self::InvitationExpiry => {
                "SELECT MIN(expires_at) AS next_at FROM invitations WHERE status = 'pending'"
            }
            Self::SessionExpiry => "SELECT MIN(expires_at) AS next_at FROM sessions",
            Self::TrashExpiry => {
                "SELECT MIN(files.trashed_at + (users.trash_retention_days * interval '1 day')) AS next_at FROM files INNER JOIN users ON users.id = files.owner_id WHERE files.state = 'trashed' AND files.trashed_at IS NOT NULL"
            }
            Self::MultipartReconciliation | Self::CounterReconciliation => return Ok(None),
        };
        let row = db.query_one(due_expression, &[]).await?;
        let next_at: Option<SystemTime> = row.get("next_at");
        Ok(next_at.map(|next_at| {
            next_at
                .duration_since(SystemTime::now())
                .unwrap_or_default()
        }))
    }

    async fn run(
        self,
        db: &Database,
        storage: &Storage,
        metrics: &Metrics,
        storage_concurrency: usize,
    ) -> Result<bool, Box<dyn StdError + Send + Sync>> {
        match self {
            Self::UserDeletion => process_user_deletion_jobs(db).await,
            Self::StorageDeletion => process_deletion_jobs(db, storage, storage_concurrency).await,
            Self::UploadFinalization => reconcile_file_upload_completions(db, storage).await,
            Self::LegacyUploadExpiry => expire_abandoned_uploads(db, storage).await,
            Self::VaultUploadExpiry => {
                expire_abandoned_vault_uploads(db, storage, storage_concurrency).await
            }
            Self::InvitationExpiry => expire_invitations_batch(db).await,
            Self::SessionExpiry => expire_sessions_batches(db).await,
            Self::TrashExpiry => expire_trash_batches(db).await,
            Self::MultipartReconciliation => {
                reconcile_orphaned_multipart_uploads(db, storage, metrics, storage_concurrency)
                    .await
            }
            Self::CounterReconciliation => reconcile_counters(db, metrics).await,
        }
    }
}

async fn expire_trash_batches(db: &Database) -> Result<bool, Box<dyn StdError + Send + Sync>> {
    let mut did_work = false;
    for _ in 0..TRASH_EXPIRY_BATCHES_PER_TICK {
        let row = db
            .query_one(EXPIRE_TRASH_BATCH_QUERY, &[&TRASH_EXPIRY_BATCH_SIZE])
            .await?;
        let deleted: i64 = row.get("deleted");
        if deleted == 0 {
            break;
        }
        did_work = true;
    }
    Ok(did_work)
}

async fn process_user_deletion_jobs(
    db: &Database,
) -> Result<bool, Box<dyn StdError + Send + Sync>> {
    let mut did_work = false;
    for _ in 0..USER_DELETION_BATCHES_PER_TICK {
        let claimed = db
            .query_opt(
                "
                    WITH candidate AS (
                      SELECT user_id
                      FROM user_deletion_jobs
                      WHERE available_at <= now()
                        AND dead_lettered_at IS NULL
                        AND (locked_until IS NULL OR locked_until < now())
                      ORDER BY created_at, user_id
                      LIMIT 1
                      FOR UPDATE SKIP LOCKED
                    )
                    UPDATE user_deletion_jobs AS jobs
                    SET locked_until = now() + ($1::bigint * interval '1 second'),
                        lease_token = gen_random_uuid()::text,
                        updated_at = now()
                    FROM candidate
                    WHERE jobs.user_id = candidate.user_id
                    RETURNING jobs.user_id, jobs.phase, jobs.attempts, jobs.lease_token
                ",
                &[&STORAGE_JOB_LEASE_SECONDS],
            )
            .await?;
        let Some(claimed) = claimed else {
            break;
        };
        did_work = true;
        let user_id: String = claimed.get("user_id");
        let phase: String = claimed.get("phase");
        let attempts: i32 = claimed.get("attempts");
        let lease_token: String = claimed.get("lease_token");

        if let Err(error) = process_user_deletion_batch(db, &user_id, &phase, &lease_token).await {
            let error_message = error.to_string().chars().take(500).collect::<String>();
            let delay_seconds = retry_delay_seconds(attempts);
            db.execute(
                "
                    UPDATE user_deletion_jobs
                    SET attempts = attempts + 1,
                        available_at = now() + ($3::bigint * interval '1 second'),
                        locked_until = NULL,
                        lease_token = NULL,
                        dead_lettered_at = CASE
                          WHEN attempts + 1 >= $4 THEN now()
                          ELSE dead_lettered_at
                        END,
                        last_error = $5,
                        updated_at = now()
                    WHERE user_id = $1 AND lease_token = $2
                ",
                &[
                    &user_id,
                    &lease_token,
                    &delay_seconds,
                    &MAINTENANCE_DEAD_LETTER_ATTEMPTS,
                    &error_message,
                ],
            )
            .await?;
            return Err(error);
        }
    }

    Ok(did_work)
}

async fn process_user_deletion_batch(
    db: &Database,
    user_id: &str,
    claimed_phase: &str,
    lease_token: &str,
) -> Result<(), Box<dyn StdError + Send + Sync>> {
    let mut client = db.get().await?;
    let transaction = client.transaction().await?;
    let Some(job) = transaction
        .query_opt(
            "SELECT phase, lease_token FROM user_deletion_jobs WHERE user_id = $1 FOR UPDATE",
            &[&user_id],
        )
        .await?
    else {
        transaction.commit().await?;
        return Ok(());
    };
    let phase: String = job.get("phase");
    let current_lease_token: Option<String> = job.get("lease_token");
    if current_lease_token.as_deref() != Some(lease_token) {
        transaction.commit().await?;
        return Ok(());
    }
    if phase != claimed_phase {
        transaction
            .execute(
                "UPDATE user_deletion_jobs SET locked_until = NULL, lease_token = NULL WHERE user_id = $1 AND lease_token = $2",
                &[&user_id, &lease_token],
            )
            .await?;
        transaction.commit().await?;
        return Ok(());
    }

    if phase == "finalize" {
        let user = transaction
            .query_opt(
                "SELECT id FROM users WHERE id = $1 AND status = 'deleting' FOR UPDATE",
                &[&user_id],
            )
            .await?;
        if user.is_none() {
            transaction
                .execute(
                    "DELETE FROM user_deletion_jobs WHERE user_id = $1",
                    &[&user_id],
                )
                .await?;
            transaction.commit().await?;
            return Ok(());
        }
        let residual_objects: bool = transaction
            .query_one(
                "
                    SELECT EXISTS (
                      SELECT 1 FROM file_uploads WHERE owner_id = $1
                      UNION ALL
                      SELECT 1 FROM vault_uploads
                      WHERE owner_id = $1 AND object_key IS NOT NULL
                      UNION ALL
                      SELECT 1 FROM vault_object_generations WHERE owner_id = $1
                      UNION ALL
                      SELECT 1 FROM vault_migrations
                      WHERE owner_id = $1
                        AND (legacy_object_key IS NOT NULL OR staged_object_key IS NOT NULL)
                      UNION ALL
                      SELECT 1 FROM files
                      WHERE owner_id = $1 AND entry_type = 'file'
                    ) AS residual_objects
                ",
                &[&user_id],
            )
            .await?
            .get("residual_objects");
        if residual_objects {
            transaction
                .execute(
                    "UPDATE user_deletion_jobs SET phase = 'file_uploads', locked_until = NULL, lease_token = NULL, updated_at = now() WHERE user_id = $1 AND lease_token = $2",
                    &[&user_id, &lease_token],
                )
                .await?;
        } else {
            transaction
                .execute(
                    "DELETE FROM users WHERE id = $1 AND status = 'deleting'",
                    &[&user_id],
                )
                .await?;
        }
        transaction.commit().await?;
        return Ok(());
    }

    let affected = process_user_deletion_phase(&transaction, user_id, &phase).await?;
    let next_phase = if affected < USER_DELETION_BATCH_SIZE as u64 {
        next_user_deletion_phase(&phase)
            .ok_or_else(|| std::io::Error::other(format!("unknown user deletion phase: {phase}")))?
    } else {
        phase.as_str()
    };
    let affected = i64::try_from(affected).unwrap_or(i64::MAX);
    transaction
        .execute(
            "
                UPDATE user_deletion_jobs
                SET phase = $2,
                    processed_rows = processed_rows + $3,
                    attempts = 0,
                    available_at = now(),
                    locked_until = NULL,
                    lease_token = NULL,
                    last_error = NULL,
                    updated_at = now()
                WHERE user_id = $1 AND lease_token = $4
            ",
            &[&user_id, &next_phase, &affected, &lease_token],
        )
        .await?;
    transaction.commit().await?;
    Ok(())
}

fn next_user_deletion_phase(current: &str) -> Option<&'static str> {
    USER_DELETION_PHASES
        .iter()
        .position(|phase| *phase == current)
        .and_then(|index| USER_DELETION_PHASES.get(index + 1))
        .copied()
}

async fn process_user_deletion_phase(
    transaction: &tokio_postgres::Transaction<'_>,
    user_id: &str,
    phase: &str,
) -> Result<u64, tokio_postgres::Error> {
    let batch_size = USER_DELETION_BATCH_SIZE;
    match phase {
        "file_uploads" => {
            deletion_query_count(
                transaction,
                "
                    WITH targets AS MATERIALIZED (
                      SELECT id, object_key, multipart_upload_id, upload_mode,
                             write_expires_at
                      FROM file_uploads
                      WHERE owner_id = $1
                      ORDER BY id
                      LIMIT $2
                      FOR UPDATE SKIP LOCKED
                    ), queued AS (
                      INSERT INTO storage_deletion_jobs (
                        object_key, multipart_upload_id, available_at
                      )
                      SELECT object_key, multipart_upload_id,
                             CASE WHEN upload_mode = 'single'
                               THEN GREATEST(COALESCE(write_expires_at, now()), now())
                               ELSE now()
                             END
                      FROM targets
                      ON CONFLICT (object_key) DO UPDATE SET
                        multipart_upload_id = COALESCE(
                          EXCLUDED.multipart_upload_id,
                          storage_deletion_jobs.multipart_upload_id
                        ),
                        available_at = GREATEST(
                          storage_deletion_jobs.available_at,
                          EXCLUDED.available_at
                        )
                      RETURNING object_key
                    ), deleted AS (
                      DELETE FROM file_uploads AS uploads
                      USING targets
                      WHERE uploads.id = targets.id
                        AND (SELECT count(*) FROM queued) >= 0
                      RETURNING uploads.id
                    )
                    SELECT count(*)::bigint AS affected FROM deleted
                ",
                user_id,
                batch_size,
            )
            .await
        }
        "vault_uploads" => {
            deletion_query_count(
                transaction,
                "
                    WITH targets AS MATERIALIZED (
                      SELECT id, object_key, multipart_upload_id, upload_mode,
                             write_expires_at
                      FROM vault_uploads
                      WHERE owner_id = $1
                      ORDER BY id
                      LIMIT $2
                      FOR UPDATE SKIP LOCKED
                    ), queued AS (
                      INSERT INTO storage_deletion_jobs (
                        object_key, multipart_upload_id, available_at
                      )
                      SELECT object_key, multipart_upload_id,
                             CASE WHEN upload_mode = 'single'
                               THEN GREATEST(COALESCE(write_expires_at, now()), now())
                               ELSE now()
                             END
                      FROM targets
                      WHERE object_key IS NOT NULL
                      ON CONFLICT (object_key) DO UPDATE SET
                        multipart_upload_id = COALESCE(
                          EXCLUDED.multipart_upload_id,
                          storage_deletion_jobs.multipart_upload_id
                        ),
                        available_at = GREATEST(
                          storage_deletion_jobs.available_at,
                          EXCLUDED.available_at
                        )
                      RETURNING object_key
                    ), deleted AS (
                      DELETE FROM vault_uploads AS uploads
                      USING targets
                      WHERE uploads.id = targets.id
                        AND (SELECT count(*) FROM queued) >= 0
                      RETURNING uploads.id
                    )
                    SELECT count(*)::bigint AS affected FROM deleted
                ",
                user_id,
                batch_size,
            )
            .await
        }
        "vault_object_generations" => {
            deletion_query_count(
                transaction,
                "
                    WITH targets AS MATERIALIZED (
                      SELECT node_id, generation_number, object_key
                      FROM vault_object_generations
                      WHERE owner_id = $1
                      ORDER BY node_id, generation_number
                      LIMIT $2
                      FOR UPDATE SKIP LOCKED
                    ), queued AS (
                      INSERT INTO storage_deletion_jobs (object_key)
                      SELECT object_key FROM targets
                      ON CONFLICT (object_key) DO NOTHING
                      RETURNING object_key
                    ), deleted AS (
                      DELETE FROM vault_object_generations AS generations
                      USING targets
                      WHERE generations.node_id = targets.node_id
                        AND generations.generation_number = targets.generation_number
                        AND (SELECT count(*) FROM queued) >= 0
                      RETURNING generations.node_id
                    )
                    SELECT count(*)::bigint AS affected FROM deleted
                ",
                user_id,
                batch_size,
            )
            .await
        }
        "vault_migrations" => {
            deletion_query_count(
                transaction,
                "
                    WITH targets AS MATERIALIZED (
                      SELECT node_id, legacy_object_key, staged_object_key
                      FROM vault_migrations
                      WHERE owner_id = $1
                      ORDER BY node_id
                      LIMIT $2
                      FOR UPDATE SKIP LOCKED
                    ), object_keys AS (
                      SELECT DISTINCT object_key
                      FROM (
                        SELECT legacy_object_key AS object_key FROM targets
                        UNION ALL
                        SELECT staged_object_key AS object_key FROM targets
                      ) AS keys
                      WHERE object_key IS NOT NULL
                    ), queued AS (
                      INSERT INTO storage_deletion_jobs (object_key)
                      SELECT object_key FROM object_keys
                      ON CONFLICT (object_key) DO NOTHING
                      RETURNING object_key
                    ), deleted AS (
                      DELETE FROM vault_migrations AS migrations
                      USING targets
                      WHERE migrations.node_id = targets.node_id
                        AND (SELECT count(*) FROM queued) >= 0
                      RETURNING migrations.node_id
                    )
                    SELECT count(*)::bigint AS affected FROM deleted
                ",
                user_id,
                batch_size,
            )
            .await
        }
        "files" => {
            deletion_query_count(
                transaction,
                "
                    WITH targets AS MATERIALIZED (
                      SELECT files.id, files.entry_type,
                             CASE WHEN position('/' IN files.storage_name) = 0
                               THEN files.owner_id || '/' || files.storage_name
                               ELSE files.storage_name
                             END AS object_key
                      FROM files
                      WHERE files.owner_id = $1
                        AND NOT EXISTS (
                          SELECT 1 FROM files AS children
                          WHERE children.parent_id = files.id
                        )
                      ORDER BY files.id
                      LIMIT $2
                      FOR UPDATE OF files SKIP LOCKED
                    ), queued AS (
                      INSERT INTO storage_deletion_jobs (object_key)
                      SELECT object_key FROM targets WHERE entry_type = 'file'
                      ON CONFLICT (object_key) DO NOTHING
                      RETURNING object_key
                    ), deleted AS (
                      DELETE FROM files AS entries
                      USING targets
                      WHERE entries.id = targets.id
                        AND (SELECT count(*) FROM queued) >= 0
                      RETURNING entries.id
                    )
                    SELECT count(*)::bigint AS affected FROM deleted
                ",
                user_id,
                batch_size,
            )
            .await
        }
        _ => {
            let statement = user_deletion_statement(phase)
                .unwrap_or("DELETE FROM users WHERE FALSE AND id IN (SELECT $1::text LIMIT $2)");
            transaction
                .execute(statement, &[&user_id, &batch_size])
                .await
        }
    }
}

async fn deletion_query_count(
    transaction: &tokio_postgres::Transaction<'_>,
    statement: &str,
    user_id: &str,
    batch_size: i64,
) -> Result<u64, tokio_postgres::Error> {
    let row = transaction
        .query_one(statement, &[&user_id, &batch_size])
        .await?;
    let affected: i64 = row.get("affected");
    Ok(u64::try_from(affected).unwrap_or_default())
}

fn user_deletion_statement(phase: &str) -> Option<&'static str> {
    match phase {
        "vault_share_envelopes" => Some(
            "DELETE FROM vault_share_envelopes WHERE ctid IN (SELECT ctid FROM vault_share_envelopes WHERE sender_id = $1 OR recipient_id = $1 ORDER BY envelope_id LIMIT $2 FOR UPDATE SKIP LOCKED)",
        ),
        "vault_share_wrappers" => Some(
            "DELETE FROM vault_share_wrappers AS wrappers WHERE wrappers.ctid IN (SELECT candidate.ctid FROM vault_share_wrappers AS candidate WHERE EXISTS (SELECT 1 FROM vault_shares AS shares WHERE shares.id = candidate.share_id AND shares.owner_id = $1) OR EXISTS (SELECT 1 FROM files WHERE files.id = candidate.node_id AND files.owner_id = $1) ORDER BY candidate.wrapper_id LIMIT $2 FOR UPDATE OF candidate SKIP LOCKED)",
        ),
        "vault_share_owner_keys" => Some(
            "DELETE FROM vault_share_owner_keys AS keys WHERE keys.ctid IN (SELECT candidate.ctid FROM vault_share_owner_keys AS candidate INNER JOIN vault_shares AS shares ON shares.id = candidate.share_id WHERE shares.owner_id = $1 ORDER BY candidate.share_id, candidate.epoch LIMIT $2 FOR UPDATE OF candidate SKIP LOCKED)",
        ),
        "vault_revocation_cutoffs" => Some(
            "DELETE FROM vault_revocation_cutoffs AS cutoffs WHERE cutoffs.ctid IN (SELECT candidate.ctid FROM vault_revocation_cutoffs AS candidate WHERE candidate.revoked_recipient_id = $1 OR EXISTS (SELECT 1 FROM vault_shares AS shares WHERE shares.id = candidate.share_id AND shares.owner_id = $1) ORDER BY candidate.share_id, candidate.retired_epoch LIMIT $2 FOR UPDATE OF candidate SKIP LOCKED)",
        ),
        "vault_share_pending_revocations" => Some(
            "DELETE FROM vault_share_pending_revocations AS revocations WHERE revocations.ctid IN (SELECT candidate.ctid FROM vault_share_pending_revocations AS candidate WHERE candidate.recipient_id = $1 OR EXISTS (SELECT 1 FROM vault_shares AS shares WHERE shares.id = candidate.share_id AND shares.owner_id = $1) ORDER BY candidate.share_id, candidate.pending_epoch LIMIT $2 FOR UPDATE OF candidate SKIP LOCKED)",
        ),
        "vault_share_recipients" => Some(
            "DELETE FROM vault_share_recipients AS recipients WHERE recipients.ctid IN (SELECT candidate.ctid FROM vault_share_recipients AS candidate WHERE candidate.recipient_id = $1 OR EXISTS (SELECT 1 FROM vault_shares AS shares WHERE shares.id = candidate.share_id AND shares.owner_id = $1) ORDER BY candidate.share_id, candidate.recipient_id LIMIT $2 FOR UPDATE OF candidate SKIP LOCKED)",
        ),
        "vault_share_epochs" => Some(
            "DELETE FROM vault_share_epochs AS epochs WHERE epochs.ctid IN (SELECT candidate.ctid FROM vault_share_epochs AS candidate INNER JOIN vault_shares AS shares ON shares.id = candidate.share_id WHERE shares.owner_id = $1 ORDER BY candidate.share_id, candidate.epoch LIMIT $2 FOR UPDATE OF candidate SKIP LOCKED)",
        ),
        "vault_shares" => Some(
            "DELETE FROM vault_shares WHERE ctid IN (SELECT ctid FROM vault_shares WHERE owner_id = $1 ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)",
        ),
        "file_shares" => Some(
            "DELETE FROM file_shares WHERE ctid IN (SELECT ctid FROM file_shares WHERE owner_id = $1 OR recipient_id = $1 ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)",
        ),
        "share_links" => Some(
            "DELETE FROM share_links WHERE ctid IN (SELECT ctid FROM share_links WHERE owner_id = $1 OR recipient_id = $1 ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)",
        ),
        "repositories" => Some(
            "DELETE FROM repositories WHERE ctid IN (SELECT ctid FROM repositories WHERE owner_id = $1 ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)",
        ),
        "vault_node_heads" => Some(
            "DELETE FROM vault_node_heads WHERE ctid IN (SELECT ctid FROM vault_node_heads WHERE owner_id = $1 ORDER BY node_id LIMIT $2 FOR UPDATE SKIP LOCKED)",
        ),
        "vault_node_records" => Some(
            "DELETE FROM vault_node_records WHERE ctid IN (SELECT ctid FROM vault_node_records WHERE owner_id = $1 ORDER BY node_id, record_version LIMIT $2 FOR UPDATE SKIP LOCKED)",
        ),
        "vault_wrappers" => Some(
            "DELETE FROM vault_wrappers WHERE ctid IN (SELECT ctid FROM vault_wrappers WHERE owner_id = $1 ORDER BY wrapper_id LIMIT $2 FOR UPDATE SKIP LOCKED)",
        ),
        "vault_identity_trust" => Some(
            "DELETE FROM vault_identity_trust WHERE ctid IN (SELECT ctid FROM vault_identity_trust WHERE user_id = $1 OR peer_user_id = $1 ORDER BY user_id, peer_user_id LIMIT $2 FOR UPDATE SKIP LOCKED)",
        ),
        "vault_identity_keys" => Some(
            "DELETE FROM vault_identity_keys WHERE ctid IN (SELECT ctid FROM vault_identity_keys WHERE user_id = $1 ORDER BY key_version LIMIT $2 FOR UPDATE SKIP LOCKED)",
        ),
        "user_vaults" => Some(
            "DELETE FROM user_vaults WHERE ctid IN (SELECT ctid FROM user_vaults WHERE user_id = $1 LIMIT $2 FOR UPDATE SKIP LOCKED)",
        ),
        "invitations" => Some(
            "DELETE FROM invitations WHERE ctid IN (SELECT ctid FROM invitations WHERE created_by = $1 ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)",
        ),
        "sessions" => Some(
            "DELETE FROM sessions WHERE ctid IN (SELECT ctid FROM sessions WHERE user_id = $1 ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)",
        ),
        _ => None,
    }
}

struct ExpiredVaultUpload {
    id: String,
    object_key: Option<String>,
    multipart_upload_id: Option<String>,
    write_expires_at: Option<SystemTime>,
}

async fn expire_abandoned_vault_uploads(
    db: &Database,
    storage: &Storage,
    storage_concurrency: usize,
) -> Result<bool, Box<dyn StdError + Send + Sync>> {
    let uploads = db
        .query(CLAIM_EXPIRED_VAULT_UPLOADS_QUERY, &[])
        .await?
        .into_iter()
        .map(|upload| ExpiredVaultUpload {
            id: upload.get("id"),
            object_key: upload.get("object_key"),
            multipart_upload_id: upload.get("multipart_upload_id"),
            write_expires_at: upload.get("write_expires_at"),
        })
        .collect::<Vec<_>>();

    let outcomes = run_bounded_storage_tasks(uploads, storage_concurrency, |upload| async move {
        let ExpiredVaultUpload {
            id,
            object_key,
            multipart_upload_id,
            write_expires_at,
        } = upload;

        if write_expires_at.is_some_and(|expires_at| expires_at > SystemTime::now()) {
            db.execute(
                "UPDATE vault_uploads SET expires_at = write_expires_at WHERE id = $1 AND status = 'aborting'",
                &[&id],
            )
            .await?;
            return Ok::<(), Box<dyn StdError + Send + Sync>>(());
        }

        let cleanup = async {
            if let (Some(object_key), Some(multipart_upload_id)) =
                (object_key.as_deref(), multipart_upload_id.as_deref())
            {
                storage
                    .abort_multipart(object_key, multipart_upload_id)
                    .await?;
            }
            if let Some(object_key) = object_key.as_deref() {
                // A provider upload can exist before its ID is durably written to the
                // intent. Discover and abort every exact-key session before the intent
                // becomes terminal so that this crash window cannot defer cleanup to
                // the low-frequency global reconciliation sweep.
                storage.abort_multipart_uploads_for_key(object_key).await?;
                storage.delete_object(object_key).await?;
            }
            Ok::<(), StorageError>(())
        }
        .await;

        match cleanup {
            Ok(()) => {
                db.execute(
                    "UPDATE vault_uploads SET status = 'aborted' WHERE id = $1 AND status = 'aborting'",
                    &[&id],
                )
                .await?;
            }
            Err(error) => {
                log::warn!("encrypted upload {id} cleanup will retry: {error}");
            }
        }
        Ok::<(), Box<dyn StdError + Send + Sync>>(())
    })
    .await;
    let did_work = !outcomes.is_empty();
    for outcome in outcomes {
        outcome?;
    }

    Ok(did_work)
}

async fn reconcile_orphaned_multipart_uploads(
    db: &Database,
    storage: &Storage,
    metrics: &Metrics,
    storage_concurrency: usize,
) -> Result<bool, Box<dyn StdError + Send + Sync>> {
    let Some(grace_seconds) = storage.multipart_orphan_grace_seconds() else {
        return Ok(false);
    };
    let client = db.get().await?;
    let lock_row = client
        .query_one(
            "SELECT pg_try_advisory_lock($1)",
            &[&MULTIPART_RECONCILIATION_LOCK_ID],
        )
        .await?;
    let lock_acquired: bool = lock_row.get(0);

    if !lock_acquired {
        return Ok(false);
    }

    let sweep_result = sweep_orphaned_multipart_uploads(
        &client,
        storage,
        metrics,
        grace_seconds,
        storage_concurrency,
    )
    .await;
    let unlock_result = client
        .query_one(
            "SELECT pg_advisory_unlock($1)",
            &[&MULTIPART_RECONCILIATION_LOCK_ID],
        )
        .await;

    if let Err(error) = unlock_result {
        log::error!("could not release multipart reconciliation lock: {error}");
        if sweep_result.is_ok() {
            return Err(error.into());
        }
    }

    sweep_result.map(|()| true)
}

async fn sweep_orphaned_multipart_uploads(
    client: &deadpool_postgres::Client,
    storage: &Storage,
    metrics: &Metrics,
    grace_seconds: u64,
    storage_concurrency: usize,
) -> Result<(), Box<dyn StdError + Send + Sync>> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let cutoff = now.saturating_sub(grace_seconds);
    let cutoff = i64::try_from(cutoff).unwrap_or(i64::MAX);
    let mut key_marker: Option<String> = None;
    let mut upload_id_marker: Option<String> = None;
    let mut failures = ReconciliationFailures::default();

    loop {
        let page = storage
            .multipart_upload_page(
                STORAGE_OBJECT_PREFIX,
                key_marker.as_deref(),
                upload_id_marker.as_deref(),
            )
            .await?;
        let object_keys = page
            .uploads
            .iter()
            .map(|upload| upload.object_key.clone())
            .collect::<Vec<_>>();
        let intent_rows = if object_keys.is_empty() {
            Vec::new()
        } else {
            client
                .query(
                    "
                        SELECT 'file'::text AS source, object_key, status,
                               multipart_upload_id,
                               GREATEST(expires_at, COALESCE(write_expires_at, expires_at))
                                 AS protected_until
                        FROM file_uploads
                        WHERE object_key = ANY($1)
                        UNION ALL
                        SELECT 'vault'::text AS source, object_key, status,
                               multipart_upload_id,
                               GREATEST(expires_at, COALESCE(write_expires_at, expires_at))
                                 AS protected_until
                        FROM vault_uploads
                        WHERE object_key = ANY($1)
                    ",
                    &[&object_keys],
                )
                .await?
        };
        let mut intents = HashMap::<String, Vec<MultipartIntent>>::new();
        for row in intent_rows {
            let source = match row.get::<_, String>("source").as_str() {
                "file" => MultipartIntentSource::File,
                "vault" => MultipartIntentSource::Vault,
                _ => continue,
            };
            intents
                .entry(row.get("object_key"))
                .or_default()
                .push(MultipartIntent {
                    source,
                    status: row.get("status"),
                    upload_id: row.get("multipart_upload_id"),
                    protected_until: row.get("protected_until"),
                });
        }

        let mut aborts = Vec::new();
        for upload in page.uploads {
            if upload.initiated_epoch_seconds > cutoff {
                continue;
            }

            let action = multipart_reconciliation_action(
                &upload.object_key,
                &upload.upload_id,
                intents
                    .get(&upload.object_key)
                    .map(Vec::as_slice)
                    .unwrap_or_default(),
                SystemTime::now(),
            );

            if action == MultipartReconciliationAction::Keep {
                continue;
            }

            if let MultipartReconciliationAction::Adopt(source) = action {
                let statement = match source {
                    MultipartIntentSource::File => {
                        "UPDATE file_uploads SET multipart_upload_id = $1, status = 'pending', expires_at = now() + interval '24 hours' WHERE object_key = $2 AND status = 'initializing' AND multipart_upload_id IS NULL AND expires_at > now()"
                    }
                    MultipartIntentSource::Vault => {
                        "UPDATE vault_uploads SET multipart_upload_id = $1, status = 'pending', expires_at = now() + interval '1 hour' WHERE object_key = $2 AND status = 'initializing' AND multipart_upload_id IS NULL AND expires_at > now()"
                    }
                };
                let adopted = client
                    .execute(statement, &[&upload.upload_id, &upload.object_key])
                    .await?;

                if adopted == 1 {
                    log::warn!(
                        "adopted multipart upload {} for durable {:?} intent {}",
                        upload.upload_id,
                        source,
                        upload.object_key
                    );
                    continue;
                }
            }

            let protected_after_race = client
                .query_opt(
                    "
                        SELECT 1
                        FROM (
                          SELECT object_key, multipart_upload_id, status,
                                 GREATEST(expires_at, COALESCE(write_expires_at, expires_at))
                                   AS protected_until
                          FROM file_uploads
                          UNION ALL
                          SELECT object_key, multipart_upload_id, status,
                                 GREATEST(expires_at, COALESCE(write_expires_at, expires_at))
                                   AS protected_until
                          FROM vault_uploads
                        ) AS intents
                        WHERE object_key = $1
                          AND status IN ('initializing', 'pending', 'completing', 'aborting')
                          AND (multipart_upload_id = $2 OR protected_until > now())
                        LIMIT 1
                    ",
                    &[&upload.object_key, &upload.upload_id],
                )
                .await?
                .is_some();
            if protected_after_race {
                continue;
            }

            aborts.push(upload);
        }

        run_reconciliation_abort_page(
            aborts,
            storage_concurrency,
            metrics,
            &mut failures,
            |upload| async move {
                storage
                    .abort_multipart(&upload.object_key, &upload.upload_id)
                    .await?;
                log::warn!(
                    "aborted orphaned multipart upload {} for {}",
                    upload.upload_id,
                    upload.object_key
                );
                Ok::<(), StorageError>(())
            },
        )
        .await;

        let next_key_marker = page.next_key_marker;
        let next_upload_id_marker = page.next_upload_id_marker;

        if next_key_marker.is_none() {
            break;
        }
        if next_key_marker == key_marker && next_upload_id_marker == upload_id_marker {
            return Err(std::io::Error::other(
                "S3 multipart listing returned unchanged pagination markers",
            )
            .into());
        }

        key_marker = next_key_marker;
        upload_id_marker = next_upload_id_marker;
    }

    failures.finish()
}

#[derive(Default)]
struct ReconciliationFailures {
    count: usize,
    samples: Vec<String>,
}

impl ReconciliationFailures {
    fn record(&mut self, message: String) {
        self.count = self.count.saturating_add(1);
        if self.samples.len() < 5 {
            self.samples.push(message.chars().take(300).collect());
        }
    }

    fn finish(self) -> Result<(), Box<dyn StdError + Send + Sync>> {
        if self.count == 0 {
            return Ok(());
        }
        Err(std::io::Error::other(format!(
            "multipart reconciliation completed with {} item failures: {}",
            self.count,
            self.samples.join(" | ")
        ))
        .into())
    }
}

fn multipart_reconciliation_action(
    object_key: &str,
    upload_id: &str,
    intents: &[MultipartIntent],
    now: SystemTime,
) -> MultipartReconciliationAction {
    if intents.iter().any(|intent| {
        active_multipart_status(&intent.status)
            && intent
                .upload_id
                .as_deref()
                .is_some_and(|known| known == upload_id)
    }) {
        return MultipartReconciliationAction::Keep;
    }

    if let Some(intent) = intents.iter().find(|intent| {
        intent.status == "initializing"
            && intent.upload_id.is_none()
            && intent.protected_until > now
            && intent_source_matches_key(intent.source, object_key)
    }) {
        return MultipartReconciliationAction::Adopt(intent.source);
    }

    if intents
        .iter()
        .any(|intent| active_multipart_status(&intent.status) && intent.protected_until > now)
    {
        return MultipartReconciliationAction::Keep;
    }

    MultipartReconciliationAction::Abort
}

fn active_multipart_status(status: &str) -> bool {
    matches!(
        status,
        "initializing" | "pending" | "completing" | "aborting"
    )
}

fn intent_source_matches_key(source: MultipartIntentSource, object_key: &str) -> bool {
    match source {
        MultipartIntentSource::File => object_key.contains("/files/"),
        MultipartIntentSource::Vault => object_key.contains("/vault/"),
    }
}

async fn run_bounded_storage_tasks<Items, Item, Operation, OperationFuture, Output>(
    items: Items,
    concurrency: usize,
    operation: Operation,
) -> Vec<Output>
where
    Items: IntoIterator<Item = Item>,
    Operation: FnMut(Item) -> OperationFuture,
    OperationFuture: Future<Output = Output>,
{
    stream::iter(items)
        .map(operation)
        .buffer_unordered(concurrency.max(1))
        .collect()
        .await
}

async fn run_reconciliation_abort_page<Items, Item, Operation, OperationFuture, Error>(
    items: Items,
    concurrency: usize,
    metrics: &Metrics,
    failures: &mut ReconciliationFailures,
    operation: Operation,
) where
    Items: IntoIterator<Item = Item>,
    Operation: FnMut(Item) -> OperationFuture,
    OperationFuture: Future<Output = Result<(), Error>>,
    Error: fmt::Display,
{
    let outcomes = run_bounded_storage_tasks(items, concurrency, operation).await;
    for outcome in outcomes {
        if let Err(error) = outcome {
            metrics.record_maintenance_item_failure("multipart reconciliation abort");
            failures.record(error.to_string());
        }
    }
}

struct StorageDeletionJob {
    id: i64,
    object_key: String,
    multipart_upload_id: Option<String>,
    discover_multipart: bool,
    attempts: i32,
    lease_token: String,
}

async fn finish_storage_deletion_job(
    db: &Database,
    job: StorageDeletionJob,
    deletion_result: Result<(), StorageError>,
) -> Result<(), Box<dyn StdError + Send + Sync>> {
    let StorageDeletionJob {
        id,
        object_key,
        multipart_upload_id,
        attempts,
        lease_token,
        ..
    } = job;
    match deletion_result {
        Ok(()) => {
            let mut client = db.get().await?;
            let transaction = client.transaction().await?;
            let current = transaction
                .query_opt(
                    "SELECT multipart_upload_id FROM storage_deletion_jobs WHERE id = $1 AND lease_token = $2 FOR UPDATE",
                    &[&id, &lease_token],
                )
                .await?;
            let Some(current) = current else {
                return Ok(());
            };
            let current_multipart_upload_id: Option<String> = current.get("multipart_upload_id");
            if current_multipart_upload_id != multipart_upload_id {
                transaction
                    .execute(
                        "UPDATE storage_deletion_jobs SET available_at = now(), locked_until = NULL, lease_token = NULL WHERE id = $1 AND lease_token = $2",
                        &[&id, &lease_token],
                    )
                    .await?;
                transaction.commit().await?;
                return Ok(());
            }
            transaction
                .execute(
                    "UPDATE file_uploads SET status = 'aborted' WHERE object_key = $1 AND status = 'aborting'",
                    &[&object_key],
                )
                .await?;
            transaction
                .execute(
                    "UPDATE vault_uploads SET status = 'aborted' WHERE object_key = $1 AND status = 'aborting'",
                    &[&object_key],
                )
                .await?;
            transaction
                .execute(COMPLETE_MIGRATION_CLEANUP_QUERY, &[&object_key])
                .await?;
            transaction
                .execute(
                    "DELETE FROM storage_deletion_jobs WHERE id = $1 AND lease_token = $2",
                    &[&id, &lease_token],
                )
                .await?;
            transaction.commit().await?;
        }
        Err(error) => {
            let delay_seconds = retry_delay_seconds(attempts);
            let error_message = error.to_string().chars().take(500).collect::<String>();
            db.execute(
                "
                    UPDATE storage_deletion_jobs
                    SET attempts = attempts + 1,
                        available_at = now() + ($3::bigint * interval '1 second'),
                        locked_until = NULL,
                        lease_token = NULL,
                        dead_lettered_at = CASE
                          WHEN attempts + 1 >= $4 THEN now()
                          ELSE dead_lettered_at
                        END,
                        last_error = $5
                    WHERE id = $1 AND lease_token = $2
                ",
                &[
                    &id,
                    &lease_token,
                    &delay_seconds,
                    &MAINTENANCE_DEAD_LETTER_ATTEMPTS,
                    &error_message,
                ],
            )
            .await?;
        }
    }
    Ok(())
}

async fn run_with_storage_job_lease<OperationFuture>(
    db: &Database,
    job_id: i64,
    lease_token: &str,
    operation: OperationFuture,
) -> Result<(), StorageError>
where
    OperationFuture: Future<Output = Result<(), StorageError>>,
{
    let mut operation = Box::pin(operation);
    let mut heartbeat = interval_at(
        Instant::now() + STORAGE_JOB_HEARTBEAT_INTERVAL,
        STORAGE_JOB_HEARTBEAT_INTERVAL,
    );
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        match select(operation, Box::pin(heartbeat.tick())).await {
            Either::Left((outcome, _)) => return outcome,
            Either::Right((_, pending_operation)) => {
                operation = pending_operation;
                let renewed = db
                    .execute(
                        "
                            UPDATE storage_deletion_jobs
                            SET locked_until = now() + ($3::bigint * interval '1 second')
                            WHERE id = $1
                              AND lease_token = $2
                              AND dead_lettered_at IS NULL
                        ",
                        &[&job_id, &lease_token, &STORAGE_JOB_LEASE_SECONDS],
                    )
                    .await
                    .map_err(|error| {
                        storage_message(format!("could not renew storage deletion lease: {error}"))
                    })?;
                if renewed != 1 {
                    return Err(storage_message("storage deletion lease ownership was lost"));
                }
            }
        }
    }
}

async fn process_deletion_jobs(
    db: &Database,
    storage: &Storage,
    storage_concurrency: usize,
) -> Result<bool, Box<dyn StdError + Send + Sync>> {
    let jobs = db
        .query(
            CLAIM_STORAGE_DELETION_JOBS_QUERY,
            &[&STORAGE_JOB_LEASE_SECONDS],
        )
        .await?
        .into_iter()
        .map(|job| StorageDeletionJob {
            id: job.get("id"),
            object_key: job.get("object_key"),
            multipart_upload_id: job.get("multipart_upload_id"),
            discover_multipart: job.get("discover_multipart"),
            attempts: job.get("attempts"),
            lease_token: job.get("lease_token"),
        })
        .collect::<Vec<_>>();

    let did_work = !jobs.is_empty();
    let (bulk_jobs, individual_jobs): (Vec<_>, Vec<_>) = jobs.into_iter().partition(|job| {
        !job.discover_multipart
            && job.multipart_upload_id.is_none()
            && storage.supports_bulk_delete(&job.object_key)
    });
    let bulk_keys = bulk_jobs
        .iter()
        .map(|job| job.object_key.clone())
        .collect::<Vec<_>>();
    let bulk_results = storage.delete_objects(&bulk_keys).await;
    let bulk_outcomes = run_bounded_storage_tasks(
        bulk_jobs.into_iter().zip(bulk_results),
        storage_concurrency,
        |(job, result)| finish_storage_deletion_job(db, job, result),
    )
    .await;
    let individual_outcomes =
        run_bounded_storage_tasks(individual_jobs, storage_concurrency, |job| async move {
            let object_key = job.object_key.clone();
            let multipart_upload_id = job.multipart_upload_id.clone();
            let discover_multipart = job.discover_multipart;
            let deletion_result =
                run_with_storage_job_lease(db, job.id, &job.lease_token, async move {
                    if discover_multipart {
                        storage.abort_multipart_uploads_for_key(&object_key).await?;
                    } else if let Some(multipart_upload_id) = multipart_upload_id.as_deref() {
                        storage
                            .abort_multipart(&object_key, multipart_upload_id)
                            .await?;
                    }
                    storage.delete_object(&object_key).await
                })
                .await;
            finish_storage_deletion_job(db, job, deletion_result).await
        })
        .await;
    for outcome in bulk_outcomes.into_iter().chain(individual_outcomes) {
        outcome?;
    }

    Ok(did_work)
}

async fn reconcile_file_upload_completions(
    db: &Database,
    storage: &Storage,
) -> Result<bool, Box<dyn StdError + Send + Sync>> {
    let uploads = claim_file_upload_completions(db, 25).await?;
    let did_work = !uploads.is_empty();

    for upload in uploads {
        let metadata = match storage
            .maintenance_object_metadata(&upload.object_key)
            .await
        {
            Ok(metadata) => metadata,
            Err(error) if error.is_not_found() && upload.expires_at <= SystemTime::now() => {
                transition_file_upload_to_cleanup(
                    db,
                    &upload.id,
                    &upload.owner_id,
                    &upload.object_key,
                    upload.multipart_upload_id.as_deref(),
                    &["completing"],
                    Some(&upload.completion_lease_token),
                )
                .await?;
                continue;
            }
            Err(error) => {
                let delay = completion_retry_delay_seconds(upload.completion_attempts);
                log::warn!(
                    "upload completion {} will retry in {delay}s: {error}",
                    upload.id
                );
                defer_file_upload_completion(
                    db,
                    &upload.id,
                    &upload.owner_id,
                    &upload.completion_lease_token,
                    &error.to_string(),
                    delay,
                )
                .await?;
                continue;
            }
        };

        if !file_upload_metadata_matches(&upload, &metadata) {
            transition_file_upload_to_cleanup(
                db,
                &upload.id,
                &upload.owner_id,
                &upload.object_key,
                upload.multipart_upload_id.as_deref(),
                &["completing"],
                Some(&upload.completion_lease_token),
            )
            .await?;
            continue;
        }

        match finalize_file_upload_record(db, &upload, &metadata, storage.presign_seconds()).await {
            Ok(
                FileUploadFinalizeOutcome::Completed
                | FileUploadFinalizeOutcome::AlreadyCompleted
                | FileUploadFinalizeOutcome::Missing
                | FileUploadFinalizeOutcome::StateChanged,
            ) => {}
            Ok(FileUploadFinalizeOutcome::ReplacementMismatch) => {
                transition_file_upload_to_cleanup(
                    db,
                    &upload.id,
                    &upload.owner_id,
                    &upload.object_key,
                    upload.multipart_upload_id.as_deref(),
                    &["completing"],
                    Some(&upload.completion_lease_token),
                )
                .await?;
            }
            Err(error) => {
                let delay = completion_retry_delay_seconds(upload.completion_attempts);
                log::warn!(
                    "upload completion {} database finalization will retry in {delay}s: {error}",
                    upload.id
                );
                defer_file_upload_completion(
                    db,
                    &upload.id,
                    &upload.owner_id,
                    &upload.completion_lease_token,
                    &error.to_string(),
                    delay,
                )
                .await?;
            }
        }
    }

    Ok(did_work)
}

async fn expire_abandoned_uploads(
    db: &Database,
    _storage: &Storage,
) -> Result<bool, Box<dyn StdError + Send + Sync>> {
    let uploads = db.query(CLAIM_EXPIRED_FILE_UPLOADS_QUERY, &[]).await?;
    let did_work = !uploads.is_empty();

    for upload in uploads {
        let id: String = upload.get("id");

        let mut client = db.get().await?;
        let transaction = client.transaction().await?;
        transaction
            .execute(
                "
                    WITH transitioned AS (
                      UPDATE file_uploads
                      SET status = 'aborting',
                          expires_at = now() + interval '24 hours'
                      WHERE id = $1
                        AND status IN ('initializing', 'pending', 'aborting')
                      RETURNING object_key, multipart_upload_id, upload_mode, write_expires_at
                    )
                    INSERT INTO storage_deletion_jobs (
                      object_key,
                      multipart_upload_id,
                      available_at
                    )
                    SELECT
                      object_key,
                      multipart_upload_id,
                      CASE
                        WHEN upload_mode = 'single'
                          THEN GREATEST(COALESCE(write_expires_at, now()), now())
                        ELSE now()
                      END
                    FROM transitioned
                    ON CONFLICT (object_key) DO UPDATE SET
                      multipart_upload_id = COALESCE(
                        EXCLUDED.multipart_upload_id,
                        storage_deletion_jobs.multipart_upload_id
                      ),
                      available_at = GREATEST(
                        storage_deletion_jobs.available_at,
                        EXCLUDED.available_at
                      )
                ",
                &[&id],
            )
            .await?;
        transaction.commit().await?;
    }

    Ok(did_work)
}

async fn expire_invitations_batch(db: &Database) -> Result<bool, Box<dyn StdError + Send + Sync>> {
    let affected = db
        .execute(
            "
            WITH expired AS (
              SELECT id
              FROM invitations
              WHERE status = 'pending' AND expires_at <= now()
              ORDER BY expires_at
              LIMIT 100
              FOR UPDATE SKIP LOCKED
            )
            UPDATE invitations
            SET status = 'expired'
            FROM expired
            WHERE invitations.id = expired.id
        ",
            &[],
        )
        .await?;

    Ok(affected > 0)
}

async fn expire_sessions_batches(db: &Database) -> Result<bool, Box<dyn StdError + Send + Sync>> {
    let mut did_work = false;
    for _ in 0..SESSION_EXPIRY_BATCHES_PER_TICK {
        let deleted = db
            .execute(
                "
                    WITH expired AS (
                      SELECT id
                      FROM sessions
                      WHERE expires_at <= now()
                      ORDER BY expires_at, id
                      LIMIT $1
                      FOR UPDATE SKIP LOCKED
                    )
                    DELETE FROM sessions
                    USING expired
                    WHERE sessions.id = expired.id
                ",
                &[&SESSION_EXPIRY_BATCH_SIZE],
            )
            .await?;
        did_work |= deleted > 0;

        if deleted < SESSION_EXPIRY_BATCH_SIZE as u64 {
            break;
        }
    }

    Ok(did_work)
}

fn retry_delay_seconds(attempts: i32) -> i64 {
    let mut sample = [0_u8; 8];
    if getrandom::fill(&mut sample).is_err() {
        let fallback = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_le_bytes();
        sample.copy_from_slice(&fallback[..8]);
    }
    retry_delay_seconds_from_sample(attempts, u64::from_le_bytes(sample))
}

fn retry_delay_seconds_from_sample(attempts: i32, sample: u64) -> i64 {
    let exponent = u32::try_from(attempts.clamp(0, 16)).unwrap_or_default();
    let ceiling = RETRY_DELAY_FLOOR_SECONDS
        .saturating_mul(1_i64.checked_shl(exponent).unwrap_or(i64::MAX))
        .min(RETRY_DELAY_CAP_SECONDS);
    let window = u64::try_from(ceiling - RETRY_DELAY_FLOOR_SECONDS).unwrap_or_default();
    RETRY_DELAY_FLOOR_SECONDS + i64::try_from(sample % (window + 1)).unwrap_or_default()
}

async fn reconcile_counters(
    db: &Database,
    metrics: &Metrics,
) -> Result<bool, Box<dyn StdError + Send + Sync>> {
    let mut client = db.get().await?;
    let transaction = client.transaction().await?;
    let lock_acquired: bool = transaction
        .query_one(
            "SELECT pg_try_advisory_xact_lock($1)",
            &[&COUNTER_RECONCILIATION_LOCK_ID],
        )
        .await?
        .get(0);
    if !lock_acquired {
        transaction.rollback().await?;
        return Ok(false);
    }
    let mut last_owner_id = String::new();
    let mut rows_scanned = 0_u64;
    let mut rows_updated = 0_u64;
    loop {
        let row = transaction
            .query_one(
                RECONCILE_USER_COUNTERS_PAGE_QUERY,
                &[&last_owner_id, &COUNTER_RECONCILIATION_BATCH_SIZE],
            )
            .await?;
        let scanned: i64 = row.get("scanned");
        let updated: i64 = row.get("updated");
        rows_scanned = rows_scanned.saturating_add(u64::try_from(scanned).unwrap_or_default());
        rows_updated = rows_updated.saturating_add(u64::try_from(updated).unwrap_or_default());
        if scanned < COUNTER_RECONCILIATION_BATCH_SIZE {
            break;
        }
        let Some(next_owner_id) = row.get::<_, Option<String>>("next_owner_id") else {
            return Err(
                storage_message("counter reconciliation page omitted its owner cursor").into(),
            );
        };
        if next_owner_id <= last_owner_id {
            return Err(
                storage_message("counter reconciliation owner cursor did not advance").into(),
            );
        }
        last_owner_id = next_owner_id;
    }
    let admin_updated = transaction
        .execute(RECONCILE_ADMIN_COUNTERS_QUERY, &[])
        .await?;
    rows_scanned = rows_scanned.saturating_add(1);
    rows_updated = rows_updated.saturating_add(admin_updated);
    transaction.commit().await?;
    metrics.record_counter_reconciliation(rows_scanned, rows_updated);

    Ok(rows_updated > 0)
}

fn required(value: Option<String>, label: &str) -> Result<String, StorageError> {
    value.ok_or_else(|| storage_message(format!("{label} is required for S3 storage")))
}

fn presigning_config(seconds: u64) -> Result<PresigningConfig, StorageError> {
    PresigningConfig::expires_in(Duration::from_secs(seconds)).map_err(storage_error)
}

fn storage_error(error: impl fmt::Display) -> StorageError {
    StorageError {
        message: error.to_string(),
        not_found: false,
    }
}

fn storage_message(message: impl Into<String>) -> StorageError {
    StorageError {
        message: message.into(),
        not_found: false,
    }
}

fn storage_io_error(error: std::io::Error) -> StorageError {
    StorageError {
        not_found: error.kind() == std::io::ErrorKind::NotFound,
        message: error.to_string(),
    }
}

fn safe_local_path(root: &Path, object_key: &str) -> Option<PathBuf> {
    if object_key.is_empty()
        || object_key.starts_with('/')
        || object_key
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        return None;
    }

    Some(
        object_key
            .split('/')
            .fold(root.to_path_buf(), |path, segment| path.join(segment)),
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use aws_smithy_runtime_api::client::interceptors::context::{Input, InterceptorContext};
    use aws_smithy_runtime_api::client::runtime_components::RuntimeComponentsBuilder;
    use aws_smithy_runtime_api::http::Request as SmithyRequest;

    use super::*;

    fn source_between<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
        let start = source.find(start).expect("start marker should exist");
        let remainder = &source[start..];
        let end = remainder.find(end).expect("end marker should exist");
        &remainder[..end]
    }

    #[test]
    fn upload_expiry_claims_stay_aligned_with_global_partial_indexes() {
        assert!(
            CLAIM_EXPIRED_FILE_UPLOADS_QUERY
                .contains("status IN ('initializing', 'pending', 'aborting')")
        );
        assert!(
            CLAIM_EXPIRED_VAULT_UPLOADS_QUERY
                .contains("status IN ('initializing', 'pending', 'completing', 'aborting')")
        );
        for query in [
            CLAIM_EXPIRED_FILE_UPLOADS_QUERY,
            CLAIM_EXPIRED_VAULT_UPLOADS_QUERY,
        ] {
            assert!(query.contains("ORDER BY expires_at, id"));
            assert!(query.contains("LIMIT 25"));
            assert!(query.contains("FOR UPDATE SKIP LOCKED"));
        }

        let auth_schema = include_str!("../../database/init/001_auth.sql");
        assert!(auth_schema.contains("file_uploads_global_expiry_idx"));
        let vault_schema = include_str!("../../database/init/002_e2ee.sql");
        assert!(vault_schema.contains("vault_uploads_global_expiry_idx"));
    }

    #[test]
    fn vault_expiry_discovers_unknown_provider_sessions_before_terminalizing() {
        let source = include_str!("storage.rs");
        let expiry = source_between(
            source,
            "async fn expire_abandoned_vault_uploads(",
            "async fn reconcile_orphaned_multipart_uploads(",
        );
        let discovery = expiry
            .find("abort_multipart_uploads_for_key(object_key)")
            .expect("vault expiry must discover provider sessions after a crash window");
        let deletion = expiry
            .find("delete_object(object_key)")
            .expect("vault expiry must remove an uploaded object");
        let terminal = expiry
            .find("SET status = 'aborted'")
            .expect("vault expiry must eventually terminalize its intent");

        assert!(discovery < deletion && deletion < terminal);
    }

    #[test]
    fn migration_cleanup_acknowledgement_stays_on_its_partial_index() {
        assert!(COMPLETE_MIGRATION_CLEANUP_QUERY.contains("legacy_object_key = $1"));
        assert!(COMPLETE_MIGRATION_CLEANUP_QUERY.contains("state = 'cleanup_queued'"));

        let vault_schema = include_str!("../../database/init/002_e2ee.sql");
        assert!(vault_schema.contains("vault_migrations_cleanup_object_idx"));
    }

    #[test]
    fn trash_expiry_is_bounded_leaf_first_and_queues_object_deletion() {
        assert!(EXPIRE_TRASH_BATCH_QUERY.contains("users.trash_retention_days"));
        assert!(EXPIRE_TRASH_BATCH_QUERY.contains("files.state = 'trashed'"));
        assert!(EXPIRE_TRASH_BATCH_QUERY.contains("NOT EXISTS"));
        assert!(EXPIRE_TRASH_BATCH_QUERY.contains("children.parent_id = files.id"));
        assert!(EXPIRE_TRASH_BATCH_QUERY.contains("LIMIT $1"));
        assert!(EXPIRE_TRASH_BATCH_QUERY.contains("FOR UPDATE OF files SKIP LOCKED"));
        assert!(EXPIRE_TRASH_BATCH_QUERY.contains("INSERT INTO storage_deletion_jobs"));
        assert!(EXPIRE_TRASH_BATCH_QUERY.contains("targets.write_expires_at"));
        assert!(EXPIRE_TRASH_BATCH_QUERY.contains("DELETE FROM files"));

        let worker = MAINTENANCE_SCHEDULES
            .iter()
            .find(|schedule| schedule.worker == MaintenanceWorker::TrashExpiry)
            .expect("trash expiry schedule should exist");
        assert_eq!(worker.interval, Duration::from_secs(10));
        assert!(MaintenanceWorker::TrashExpiry.accepts_notification("files"));
        assert!(MaintenanceWorker::TrashExpiry.accepts_notification("users"));
    }

    #[actix_web::test]
    async fn maintenance_bulkheads_keep_running_when_one_task_stalls() {
        let workers = MAINTENANCE_SCHEDULES
            .iter()
            .map(|schedule| schedule.worker)
            .collect::<HashSet<_>>();
        assert_eq!(workers.len(), MAINTENANCE_SCHEDULES.len());

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let stalled = tokio::spawn(run_periodic_task(
            Duration::from_secs(0),
            Duration::from_secs(60),
            shutdown_rx.clone(),
            || async { std::future::pending::<()>().await },
        ));
        let completed_runs = Arc::new(AtomicUsize::new(0));
        let completed_runs_for_task = Arc::clone(&completed_runs);
        let active = tokio::spawn(run_periodic_task(
            Duration::from_secs(0),
            Duration::from_millis(2),
            shutdown_rx,
            move || {
                let completed_runs = Arc::clone(&completed_runs_for_task);
                async move {
                    completed_runs.fetch_add(1, Ordering::SeqCst);
                }
            },
        ));

        tokio::time::timeout(Duration::from_millis(250), async {
            while completed_runs.load(Ordering::SeqCst) < 3 {
                sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("the independent maintenance task should keep meeting its interval");

        shutdown_tx
            .send(true)
            .expect("maintenance shutdown receiver should remain active");
        tokio::time::timeout(Duration::from_millis(250), stalled)
            .await
            .expect("the stalled task should stop on shutdown")
            .expect("the stalled task should not panic");
        tokio::time::timeout(Duration::from_millis(250), active)
            .await
            .expect("the active task should stop on shutdown")
            .expect("the active task should not panic");
    }

    #[test]
    fn empty_maintenance_queues_back_off_by_more_than_tenfold_without_due_time_drift() {
        let base = Duration::from_secs(10);
        let maximum = Duration::from_secs(5 * 60);
        let mut idle = base;
        let mut delay = base;
        for _ in 0..8 {
            (idle, delay) = adaptive_maintenance_delay(
                idle,
                base,
                maximum,
                MaintenanceIteration {
                    did_work: false,
                    next_due: None,
                },
            );
        }
        assert_eq!(delay, maximum);
        let fixed_queries_per_day = 86_400 / base.as_secs();
        let adaptive_queries_per_day = 2 * 86_400 / maximum.as_secs();
        assert!(fixed_queries_per_day >= adaptive_queries_per_day * 10);

        let (_, due_delay) = adaptive_maintenance_delay(
            maximum,
            base,
            maximum,
            MaintenanceIteration {
                did_work: false,
                next_due: Some(Duration::ZERO),
            },
        );
        assert_eq!(due_delay, base);
    }

    #[actix_web::test]
    async fn maintenance_notifications_reset_idle_backoff_immediately() {
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let (notification_tx, notification_rx) = broadcast::channel(4);
        let runs = Arc::new(AtomicUsize::new(0));
        let runs_for_task = Arc::clone(&runs);
        let task = tokio::spawn(run_adaptive_task(
            MaintenanceWorker::StorageDeletion,
            Duration::from_secs(60),
            Duration::from_secs(10),
            Duration::from_secs(300),
            shutdown_rx,
            notification_rx,
            move || {
                let runs = Arc::clone(&runs_for_task);
                let shutdown_tx = shutdown_tx.clone();
                async move {
                    runs.fetch_add(1, Ordering::SeqCst);
                    let _ = shutdown_tx.send(true);
                    MaintenanceIteration::worked()
                }
            },
        ));

        notification_tx
            .send("storage_deletion_jobs".to_owned())
            .expect("the adaptive worker should be listening");
        tokio::time::timeout(Duration::from_millis(250), task)
            .await
            .expect("the notification should bypass the idle delay")
            .expect("the adaptive worker should not panic");
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn maintenance_retry_policy_is_fenced_jittered_and_dead_lettered() {
        assert_eq!(retry_delay_seconds_from_sample(0, 0), 10);
        assert_eq!(retry_delay_seconds_from_sample(1, 10), 20);
        assert!(retry_delay_seconds_from_sample(100, u64::MAX) <= 3_600);

        let source = include_str!("storage.rs");
        assert!(source.contains("lease_token = gen_random_uuid()::text"));
        assert!(source.contains("AND lease_token = $2"));
        assert!(source.contains("run_with_storage_job_lease("));
        assert!(source.contains("STORAGE_JOB_HEARTBEAT_INTERVAL"));
        assert!(source.contains("MAINTENANCE_DEAD_LETTER_ATTEMPTS"));
        assert_eq!(
            S3RequestPolicy::Maintenance.retry_config().max_attempts(),
            3
        );
        assert_eq!(
            S3RequestPolicy::Maintenance
                .timeout_config()
                .operation_timeout(),
            Some(Duration::from_secs(60))
        );
        assert!(CLAIM_STORAGE_DELETION_JOBS_QUERY.contains("), claimed_jobs AS ("));
        assert!(!CLAIM_STORAGE_DELETION_JOBS_QUERY.contains(")\n    ), claimed_jobs"));
    }

    #[test]
    fn s3_request_and_maintenance_policies_bound_every_timeout_and_retry() {
        let request = S3RequestPolicy::Request.timeout_config();
        assert_eq!(request.connect_timeout(), Some(Duration::from_secs(3)));
        assert_eq!(request.read_timeout(), Some(Duration::from_secs(10)));
        assert_eq!(
            request.operation_attempt_timeout(),
            Some(Duration::from_secs(15))
        );
        assert_eq!(request.operation_timeout(), Some(Duration::from_secs(30)));
        assert_eq!(S3RequestPolicy::Request.retry_config().max_attempts(), 2);

        let maintenance = S3RequestPolicy::Maintenance.timeout_config();
        assert_eq!(maintenance.connect_timeout(), Some(Duration::from_secs(5)));
        assert_eq!(maintenance.read_timeout(), Some(Duration::from_secs(20)));
        assert_eq!(
            maintenance.operation_attempt_timeout(),
            Some(Duration::from_secs(20))
        );
        assert_eq!(
            maintenance.operation_timeout(),
            Some(Duration::from_secs(60))
        );
        assert_eq!(
            S3RequestPolicy::Maintenance.retry_config().max_attempts(),
            3
        );
    }

    #[test]
    fn s3_retry_interceptor_counts_only_attempts_after_the_first() {
        let config = Config::from_env().expect("test configuration should load");
        let metrics = Metrics::new(&config);
        let interceptor = S3RetryMetricsInterceptor {
            metrics: metrics.clone(),
            policy: S3RequestPolicy::Request,
        };
        let mut context = InterceptorContext::new(Input::erase(()));
        context.set_request(SmithyRequest::empty());
        let context = BeforeTransmitInterceptorContextRef::from(&context);
        let runtime_components = RuntimeComponentsBuilder::for_tests()
            .build()
            .expect("test runtime components should build");
        let mut config_bag = ConfigBag::base();
        for attempts in [1, 2, 3] {
            config_bag
                .interceptor_state()
                .store_put(RequestAttempts::new(attempts));
            interceptor
                .read_before_attempt(&context, &runtime_components, &mut config_bag)
                .expect("retry metrics must not affect request execution");
        }
        let rendered = metrics.render(&[]);
        assert!(rendered.contains("aeralyth_s3_retry_attempts_total{policy=\"request\"} 2"));
    }

    #[test]
    fn lifecycle_backstop_is_scoped_safe_and_reduces_global_sweeps() {
        let rule = multipart_lifecycle_rule(7).expect("the lifecycle rule should build");
        assert_eq!(rule.id(), Some(MULTIPART_LIFECYCLE_RULE_ID));
        assert_eq!(rule.status(), &ExpirationStatus::Enabled);
        assert_eq!(
            rule.filter().and_then(LifecycleRuleFilter::prefix),
            Some(STORAGE_OBJECT_PREFIX)
        );
        assert_eq!(
            rule.abort_incomplete_multipart_upload()
                .and_then(AbortIncompleteMultipartUpload::days_after_initiation),
            Some(7)
        );
        let unrelated = LifecycleRule::builder()
            .id("retain-existing-rule")
            .filter(LifecycleRuleFilter::builder().prefix("archive/").build())
            .status(ExpirationStatus::Disabled)
            .build()
            .expect("the unrelated lifecycle rule should build");
        let (merged, changed) =
            merge_multipart_lifecycle_rule(vec![unrelated.clone()], rule.clone());
        assert!(changed);
        assert!(merged.contains(&unrelated));
        assert!(merged.contains(&rule));
        let (idempotent, changed) = merge_multipart_lifecycle_rule(merged.clone(), rule);
        assert!(!changed);
        assert_eq!(idempotent, merged);
        let base = MAINTENANCE_SCHEDULES
            .iter()
            .copied()
            .find(|schedule| schedule.worker == MaintenanceWorker::MultipartReconciliation)
            .expect("multipart reconciliation schedule should exist");
        assert_eq!(base.interval, Duration::from_secs(60 * 60));
        assert_eq!(
            effective_maintenance_schedule(base, true).interval,
            LIFECYCLE_BACKED_RECONCILIATION_INTERVAL
        );
        assert_eq!(
            effective_maintenance_schedule(base, false).interval,
            base.interval
        );
    }

    #[test]
    fn counter_reconciliation_detects_drift_in_owner_pages_before_writing() {
        assert!(RECONCILE_USER_COUNTERS_PAGE_QUERY.contains("WHERE id > $1"));
        assert!(RECONCILE_USER_COUNTERS_PAGE_QUERY.contains("LIMIT $2"));
        assert!(RECONCILE_USER_COUNTERS_PAGE_QUERY.contains("shared_counts AS MATERIALIZED"));
        assert!(RECONCILE_USER_COUNTERS_PAGE_QUERY.contains("shared_files.entry_type = 'file'"));
        assert!(!RECONCILE_USER_COUNTERS_PAGE_QUERY.contains("file_shares.counts_toward_shared"));
        assert!(RECONCILE_USER_COUNTERS_PAGE_QUERY.contains("drifted AS MATERIALIZED"));
        assert!(RECONCILE_USER_COUNTERS_PAGE_QUERY.contains("IS DISTINCT FROM"));
        assert!(RECONCILE_USER_COUNTERS_PAGE_QUERY.contains("FROM drifted"));
        assert!(
            RECONCILE_USER_COUNTERS_PAGE_QUERY.contains("counters.xmin = drifted.counter_xmin")
        );
        assert!(RECONCILE_USER_COUNTERS_PAGE_QUERY.contains("ON CONFLICT (owner_id) DO NOTHING"));
        assert!(RECONCILE_ADMIN_COUNTERS_QUERY.contains("IS DISTINCT FROM"));
        assert!(RECONCILE_ADMIN_COUNTERS_QUERY.contains("counters.xmin = drifted.counter_xmin"));

        let schedule = MAINTENANCE_SCHEDULES
            .iter()
            .find(|schedule| schedule.worker == MaintenanceWorker::CounterReconciliation)
            .expect("counter reconciliation schedule should exist");
        assert_eq!(schedule.interval, Duration::from_secs(24 * 60 * 60));
    }

    #[test]
    fn partitioned_counter_reconciliation_uses_one_leader_connection() {
        let source = include_str!("storage.rs");
        let reconciliation = source_between(source, "async fn reconcile_counters(", "fn required(");
        assert!(reconciliation.contains("pg_try_advisory_xact_lock"));
        assert!(reconciliation.contains("transaction\n            .query_one("));
        assert!(reconciliation.contains("RECONCILE_USER_COUNTERS_PAGE_QUERY"));
        assert!(reconciliation.contains("RECONCILE_ADMIN_COUNTERS_QUERY"));
        assert!(reconciliation.contains("record_counter_reconciliation"));
        assert!(!reconciliation.contains("db.execute("));
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn storage_deletion_claim_query_prepares_in_postgres() {
        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
        let (client, connection) = tokio_postgres::connect(&database_url, NoTls)
            .await
            .expect("postgres should be available");
        tokio::spawn(async move {
            connection
                .await
                .expect("postgres connection should remain healthy");
        });
        client
            .prepare(CLAIM_STORAGE_DELETION_JOBS_QUERY)
            .await
            .expect("the storage deletion claim query should prepare");
        client
            .prepare(EXPIRE_TRASH_BATCH_QUERY)
            .await
            .expect("the trash expiry query should prepare");
    }

    #[actix_web::test]
    #[ignore = "requires a PostgreSQL test database"]
    async fn trash_expiry_executes_leaf_first_and_queues_file_objects() {
        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
        let (client, connection) = tokio_postgres::connect(&database_url, NoTls)
            .await
            .expect("postgres should be available");
        tokio::spawn(async move {
            connection
                .await
                .expect("postgres connection should remain healthy");
        });
        client
            .batch_execute(
                "CREATE TEMP TABLE users (
                   id TEXT PRIMARY KEY,
                   trash_retention_days INTEGER NOT NULL
                 );
                 CREATE TEMP TABLE files (
                   id TEXT PRIMARY KEY,
                   owner_id TEXT NOT NULL,
                   storage_name TEXT NOT NULL,
                   entry_type TEXT NOT NULL,
                   state TEXT NOT NULL,
                   trashed_at TIMESTAMPTZ,
                   parent_id TEXT REFERENCES files(id) ON DELETE CASCADE
                 );
                 CREATE TEMP TABLE file_uploads (
                   file_id TEXT,
                   status TEXT,
                   upload_mode TEXT,
                   write_expires_at TIMESTAMPTZ
                 );
                 CREATE TEMP TABLE storage_deletion_jobs (
                   object_key TEXT PRIMARY KEY,
                   available_at TIMESTAMPTZ NOT NULL
                 );
                 INSERT INTO users (id, trash_retention_days)
                 VALUES ('usr_trash_expiry', 1);
                 INSERT INTO files (
                   id, owner_id, storage_name, entry_type, state, trashed_at, parent_id
                 ) VALUES
                   ('folder', 'usr_trash_expiry', 'folder', 'folder', 'trashed',
                    now() - interval '2 days', NULL),
                   ('file', 'usr_trash_expiry', 'object-key', 'file', 'trashed',
                    now() - interval '2 days', 'folder');",
            )
            .await
            .expect("trash expiry fixtures should initialize");

        let first: i64 = client
            .query_one(EXPIRE_TRASH_BATCH_QUERY, &[&TRASH_EXPIRY_BATCH_SIZE])
            .await
            .expect("expired leaf should delete")
            .get("deleted");
        let second: i64 = client
            .query_one(EXPIRE_TRASH_BATCH_QUERY, &[&TRASH_EXPIRY_BATCH_SIZE])
            .await
            .expect("newly empty parent should delete")
            .get("deleted");
        let remaining: i64 = client
            .query_one("SELECT count(*)::bigint AS count FROM files", &[])
            .await
            .expect("remaining files should count")
            .get("count");
        let queued: i64 = client
            .query_one(
                "SELECT count(*)::bigint AS count FROM storage_deletion_jobs",
                &[],
            )
            .await
            .expect("queued objects should count")
            .get("count");

        assert_eq!((first, second, remaining, queued), (1, 1, 0, 1));
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn counter_reconciliation_queries_prepare_in_postgres() {
        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
        let (client, connection) = tokio_postgres::connect(&database_url, NoTls)
            .await
            .expect("postgres should be available");
        tokio::spawn(async move {
            connection
                .await
                .expect("postgres connection should remain healthy");
        });
        client
            .prepare(RECONCILE_USER_COUNTERS_PAGE_QUERY)
            .await
            .expect("the partitioned user counter query should prepare");
        client
            .prepare(RECONCILE_ADMIN_COUNTERS_QUERY)
            .await
            .expect("the admin drift query should prepare");
    }

    #[actix_web::test]
    async fn reconciliation_continues_after_selected_provider_failures_across_pages() {
        let config = Config::from_env().expect("test configuration should load");
        let metrics = Metrics::new(&config);
        let attempted = Arc::new(AtomicUsize::new(0));
        let mut failures = ReconciliationFailures::default();

        for page in [vec![1, 2, 3], vec![4, 5]] {
            let attempted_for_page = Arc::clone(&attempted);
            run_reconciliation_abort_page(page, 2, &metrics, &mut failures, move |item| {
                let attempted = Arc::clone(&attempted_for_page);
                async move {
                    attempted.fetch_add(1, Ordering::SeqCst);
                    if item == 2 {
                        Err("selected provider failure")
                    } else {
                        Ok(())
                    }
                }
            })
            .await;
        }

        assert_eq!(attempted.load(Ordering::SeqCst), 5);
        let rendered = metrics.render(&[]);
        assert!(rendered.contains(
            "aeralyth_maintenance_item_failures_total{worker=\"multipart reconciliation abort\"} 1"
        ));
        let error = failures
            .finish()
            .expect_err("selected failures must be reported");
        let message = error.to_string();
        assert!(message.contains("1 item failures"));
        assert!(message.contains("selected provider failure"));

        let source = include_str!("storage.rs");
        let sweep = source_between(
            source,
            "async fn sweep_orphaned_multipart_uploads(",
            "#[derive(Default)]\nstruct ReconciliationFailures",
        );
        assert!(sweep.contains("run_reconciliation_abort_page("));
        assert!(sweep.contains("key_marker = next_key_marker"));
    }

    #[actix_web::test]
    async fn storage_provider_work_uses_the_configured_concurrency_bound() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let active_for_tasks = Arc::clone(&active);
        let peak_for_tasks = Arc::clone(&peak);

        let completed = run_bounded_storage_tasks(0..40, 4, move |item| {
            let active = Arc::clone(&active_for_tasks);
            let peak = Arc::clone(&peak_for_tasks);
            async move {
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(current, Ordering::SeqCst);
                sleep(Duration::from_millis(2)).await;
                active.fetch_sub(1, Ordering::SeqCst);
                item
            }
        })
        .await;

        assert_eq!(completed.len(), 40);
        assert_eq!(peak.load(Ordering::SeqCst), 4);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    fn intent(
        source: MultipartIntentSource,
        status: &str,
        upload_id: Option<&str>,
        protected_until: SystemTime,
    ) -> MultipartIntent {
        MultipartIntent {
            source,
            status: status.to_owned(),
            upload_id: upload_id.map(str::to_owned),
            protected_until,
        }
    }

    #[test]
    fn keeps_an_active_vault_upload_after_the_provider_grace_window() {
        let now = UNIX_EPOCH + Duration::from_secs(10_000);
        let intents = [intent(
            MultipartIntentSource::Vault,
            "pending",
            Some("vault-upload-id"),
            now + Duration::from_secs(23 * 60 * 60),
        )];

        assert_eq!(
            multipart_reconciliation_action(
                "users/usr_test/vault/fil_test/object",
                "vault-upload-id",
                &intents,
                now,
            ),
            MultipartReconciliationAction::Keep,
        );
    }

    #[test]
    fn adopts_an_initializing_upload_only_into_its_own_namespace() {
        let now = UNIX_EPOCH + Duration::from_secs(10_000);
        let vault_intent = intent(
            MultipartIntentSource::Vault,
            "initializing",
            None,
            now + Duration::from_secs(60),
        );

        assert_eq!(
            multipart_reconciliation_action(
                "users/usr_test/vault/fil_test/object",
                "provider-id",
                &[vault_intent],
                now,
            ),
            MultipartReconciliationAction::Adopt(MultipartIntentSource::Vault),
        );

        let ambiguous_intent = intent(
            MultipartIntentSource::Vault,
            "initializing",
            None,
            now + Duration::from_secs(60),
        );
        assert_eq!(
            multipart_reconciliation_action(
                "users/usr_test/legacy-object",
                "provider-id",
                &[ambiguous_intent],
                now,
            ),
            MultipartReconciliationAction::Keep,
        );
    }

    #[test]
    fn waits_for_a_live_intent_before_aborting_a_mismatched_provider_upload() {
        let now = UNIX_EPOCH + Duration::from_secs(10_000);
        let live = intent(
            MultipartIntentSource::File,
            "pending",
            Some("different-provider-id"),
            now + Duration::from_secs(60),
        );
        let expired = intent(
            MultipartIntentSource::File,
            "pending",
            Some("different-provider-id"),
            now - Duration::from_secs(1),
        );

        assert_eq!(
            multipart_reconciliation_action(
                "users/usr_test/files/fil_test/object",
                "orphan-id",
                &[live],
                now,
            ),
            MultipartReconciliationAction::Keep,
        );
        assert_eq!(
            multipart_reconciliation_action(
                "users/usr_test/files/fil_test/object",
                "orphan-id",
                &[expired],
                now,
            ),
            MultipartReconciliationAction::Abort,
        );
    }

    #[test]
    fn user_deletion_keeps_object_queueing_and_dependencies_before_finalization() {
        assert_eq!(USER_DELETION_PHASES[0], "file_uploads");
        assert_eq!(USER_DELETION_PHASES[1], "vault_uploads");
        assert_eq!(USER_DELETION_PHASES[2], "vault_object_generations");
        assert_eq!(USER_DELETION_PHASES[3], "vault_migrations");
        assert!(
            USER_DELETION_PHASES
                .iter()
                .position(|phase| *phase == "vault_share_wrappers")
                < USER_DELETION_PHASES
                    .iter()
                    .position(|phase| *phase == "files")
        );
        assert_eq!(USER_DELETION_PHASES.last(), Some(&"finalize"));

        for phase in USER_DELETION_PHASES {
            if matches!(
                *phase,
                "file_uploads"
                    | "vault_uploads"
                    | "vault_object_generations"
                    | "vault_migrations"
                    | "files"
                    | "finalize"
            ) {
                continue;
            }
            assert!(
                user_deletion_statement(phase).is_some(),
                "missing bounded deletion statement for {phase}"
            );
        }
    }
}
