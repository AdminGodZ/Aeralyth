use std::collections::HashMap;
use std::error::Error as StdError;
use std::fmt;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
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
use tokio::sync::{OwnedSemaphorePermit, Semaphore, broadcast, mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::{Instant, MissedTickBehavior, interval_at, sleep};
use tokio_postgres::{AsyncMessage, NoTls};

use crate::config::Config;
use crate::db::{Database, execute_cached, query_cached, query_one_cached, query_opt_cached};
use crate::e2ee::{UPLOAD_PART_BYTES, uses_vault_multipart_upload};
use crate::observability::Metrics;
use crate::upload_completion::{
    FileUploadFinalizeOutcome, UploadClaimCursor, claim_file_upload_completions,
    completion_retry_delay_seconds, defer_file_upload_completion, file_upload_metadata_matches,
    finalize_file_upload_record, lock_upload_claim_owners, transition_file_upload_to_cleanup,
};

const MULTIPART_SWEEP_PAGES_PER_TICK: usize = 4;
const MULTIPART_PREPARE_BATCH_SIZE: usize = 64;
const MULTIPART_SWEEP_LEASE_SECONDS: i64 = 120;
const COUNTER_RECONCILIATION_LOCK_ID: i64 = 4_133_797_884_291_002;
const STORAGE_OBJECT_PREFIX: &str = "users/";
const USER_DELETION_BATCH_SIZE: i64 = 500;
const USER_DELETION_BATCHES_PER_TICK: usize = 32;
const SESSION_EXPIRY_BATCH_SIZE: i64 = 1_000;
const SESSION_EXPIRY_BATCHES_PER_TICK: usize = 4;
const TRASH_EXPIRY_BATCH_SIZE: i32 = 500;
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

const COUNTER_RECONCILIATION_BATCH_SIZE: i64 = 500;
const STORAGE_JOB_LEASE_SECONDS: i64 = 5 * 60;
const STORAGE_DELETION_BULK_CLAIM_SIZE: i64 = 500;
const S3_DELETE_OBJECTS_MAX_KEYS: usize = 1_000;
// Bulk-claimed jobs have no lease heartbeat, so a claim (plus the per-job
// claim's bulk-eligible jobs) should fit one DeleteObjects request instead of
// queueing behind its own chunks.
const _: () = assert!(STORAGE_DELETION_BULK_CLAIM_SIZE as usize <= S3_DELETE_OBJECTS_MAX_KEYS);
const STORAGE_JOB_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);
const MAINTENANCE_DEAD_LETTER_ATTEMPTS: i32 = 12;
const RETRY_DELAY_FLOOR_SECONDS: i64 = 10;
const RETRY_DELAY_CAP_SECONDS: i64 = 60 * 60;
const CANDIDATE_EXPIRED_VAULT_UPLOADS_QUERY: &str = "
    WITH due AS MATERIALIZED (
      SELECT id, owner_id, expires_at
      FROM vault_uploads
      WHERE status IN ('initializing', 'pending', 'completing', 'aborting')
        AND expires_at <= $4::timestamptz
        AND (expires_at, id) > (
          COALESCE($2::timestamptz, '-infinity'::timestamptz), COALESCE($3::text, '')
        )
      ORDER BY expires_at, id
      LIMIT $1
    )
    SELECT id, owner_id, expires_at FROM due ORDER BY expires_at, id
";
const CANDIDATE_EXPIRED_FILE_UPLOADS_QUERY: &str = "
    WITH due AS MATERIALIZED (
      SELECT id, owner_id, expires_at
      FROM file_uploads
      WHERE status IN ('initializing', 'pending', 'aborting')
        AND expires_at <= $4::timestamptz
        AND (expires_at, id) > (
          COALESCE($2::timestamptz, '-infinity'::timestamptz), COALESCE($3::text, '')
        )
      ORDER BY expires_at, id
      LIMIT $1
    )
    SELECT id, owner_id, expires_at FROM due ORDER BY expires_at, id
";
const CLAIM_EXPIRED_VAULT_UPLOADS_QUERY: &str = "
    WITH claimed AS (
      SELECT id
      FROM vault_uploads AS uploads
      WHERE id = ANY($1::text[]) AND owner_id = ANY($2::text[])
        AND status IN ('initializing', 'pending', 'completing', 'aborting')
        AND expires_at <= now()
        AND NOT EXISTS (
          SELECT 1 FROM tree_operation_jobs AS jobs
          WHERE jobs.owner_id = uploads.owner_id AND jobs.status IN ('pending', 'running')
            AND (
              tree_operation_ancestor(uploads.node_id, uploads.owner_id, jobs.root_id)
              OR tree_operation_ancestor(uploads.parent_id, uploads.owner_id, jobs.root_id)
            )
        )
      ORDER BY expires_at, id
      LIMIT 25
      FOR UPDATE SKIP LOCKED
    )
    UPDATE vault_uploads AS uploads
    SET status = 'aborting',
        expires_at = CASE WHEN uploads.write_expires_at > now()
          THEN uploads.write_expires_at ELSE now() + interval '5 minutes' END
    FROM claimed
    WHERE uploads.id = claimed.id
    RETURNING uploads.id, uploads.owner_id, uploads.object_key,
              uploads.multipart_upload_id, uploads.write_expires_at
";
const CLAIM_EXPIRED_FILE_UPLOADS_QUERY: &str = "
    WITH claimed AS (
      SELECT id
      FROM file_uploads AS uploads
      WHERE id = ANY($1::text[]) AND owner_id = ANY($2::text[])
        AND status IN ('initializing', 'pending', 'aborting')
        AND expires_at <= now()
        AND NOT EXISTS (
          SELECT 1 FROM tree_operation_jobs AS jobs
          WHERE jobs.owner_id = uploads.owner_id AND jobs.status IN ('pending', 'running')
            AND (
              tree_operation_ancestor(uploads.file_id, uploads.owner_id, jobs.root_id)
              OR tree_operation_ancestor(uploads.parent_id, uploads.owner_id, jobs.root_id)
              OR tree_operation_ancestor(uploads.replacement_file_id, uploads.owner_id, jobs.root_id)
              OR EXISTS (
                SELECT 1 FROM share_links AS links WHERE links.id = uploads.share_link_id
                  AND tree_operation_ancestor(links.root_file_id, uploads.owner_id, jobs.root_id)
              )
            )
        )
      ORDER BY expires_at, id
      LIMIT 25
      FOR UPDATE SKIP LOCKED
    ), transitioned AS (
    UPDATE file_uploads AS uploads
    SET status = 'aborting', expires_at = now() + interval '24 hours'
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
      uploads.checksum_sha256,
      uploads.write_expires_at
    ), queued AS (
      INSERT INTO storage_deletion_jobs (object_key, multipart_upload_id, available_at)
      SELECT object_key, multipart_upload_id,
        CASE WHEN upload_mode = 'single'
          THEN GREATEST(COALESCE(write_expires_at, now()), now())
          ELSE now()
        END
      FROM transitioned
      ON CONFLICT (object_key) DO UPDATE SET
        multipart_upload_id = COALESCE(
          EXCLUDED.multipart_upload_id, storage_deletion_jobs.multipart_upload_id
        ),
        available_at = GREATEST(storage_deletion_jobs.available_at, EXCLUDED.available_at)
      RETURNING object_key
    )
    SELECT transitioned.* FROM transitioned
    WHERE (SELECT count(*) FROM queued) >= 0
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
// Plain single-object jobs need only one bulk provider call, so they are claimed
// in larger batches. Multipart aborts, provider-session discovery, and objects
// outside the bulk-delete prefix stay on the per-job claim below.
const CLAIM_BULK_STORAGE_DELETION_JOBS_QUERY: &str = "
    WITH claimed AS (
      SELECT jobs.id
      FROM storage_deletion_jobs AS jobs
      WHERE jobs.available_at <= now()
        AND jobs.dead_lettered_at IS NULL
        AND (jobs.locked_until IS NULL OR jobs.locked_until < now())
        AND jobs.multipart_upload_id IS NULL
        AND starts_with(jobs.object_key, $2)
        AND NOT EXISTS (
          SELECT 1
          FROM vault_uploads
          WHERE vault_uploads.object_key = jobs.object_key
            AND vault_uploads.upload_mode = 'multipart'
            AND vault_uploads.status IN ('aborting', 'aborted')
            AND vault_uploads.multipart_upload_id IS NULL
        )
      ORDER BY jobs.id
      LIMIT $3
      FOR UPDATE OF jobs SKIP LOCKED
    )
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
      jobs.lease_token,
      false AS discover_multipart
";
// Set-based equivalent of the success branch of `finish_storage_deletion_job`:
// only jobs still held under the caller's lease are touched, a job whose
// multipart upload changed since the claim is released for another pass, and
// the rest are deleted together with their upload and migration bookkeeping.
const FINISH_STORAGE_DELETION_BATCH_QUERY: &str = "
    WITH finished_input AS (
      SELECT *
      FROM unnest($1::bigint[], $2::text[], $3::text[])
        AS finished_input(id, lease_token, multipart_upload_id)
    ), held AS MATERIALIZED (
      SELECT
        jobs.id,
        jobs.lease_token,
        jobs.multipart_upload_id IS NOT DISTINCT FROM finished_input.multipart_upload_id
          AS unchanged
      FROM storage_deletion_jobs AS jobs
      JOIN finished_input
        ON finished_input.id = jobs.id
       AND finished_input.lease_token = jobs.lease_token
      ORDER BY jobs.id
      FOR UPDATE OF jobs
    ), released AS (
      UPDATE storage_deletion_jobs AS jobs
      SET available_at = now(), locked_until = NULL, lease_token = NULL
      FROM held
      WHERE jobs.id = held.id
        AND jobs.lease_token = held.lease_token
        AND NOT held.unchanged
      RETURNING jobs.id
    ), finished AS (
      DELETE FROM storage_deletion_jobs AS jobs
      USING held
      WHERE jobs.id = held.id
        AND jobs.lease_token = held.lease_token
        AND held.unchanged
      RETURNING jobs.object_key
    ), aborted_file_uploads AS (
      UPDATE file_uploads
      SET status = 'aborted'
      WHERE object_key IN (SELECT object_key FROM finished) AND status = 'aborting'
      RETURNING 1
    ), aborted_vault_uploads AS (
      UPDATE vault_uploads
      SET status = 'aborted'
      WHERE object_key IN (SELECT object_key FROM finished) AND status = 'aborting'
      RETURNING 1
    ), completed_migrations AS (
      UPDATE vault_migrations
      SET state = 'complete', updated_at = now()
      WHERE legacy_object_key IN (SELECT object_key FROM finished)
        AND state = 'cleanup_queued'
      RETURNING 1
    )
    SELECT
      (SELECT count(*) FROM finished)::bigint AS finished,
      (SELECT count(*) FROM released)::bigint AS released
";
// Set-based equivalent of the failure branch of `finish_storage_deletion_job`.
const FAIL_STORAGE_DELETION_BATCH_QUERY: &str = "
    UPDATE storage_deletion_jobs AS jobs
    SET attempts = jobs.attempts + 1,
        available_at = now() + (failed.delay_seconds * interval '1 second'),
        locked_until = NULL,
        lease_token = NULL,
        dead_lettered_at = CASE
          WHEN jobs.attempts + 1 >= $5 THEN now()
          ELSE jobs.dead_lettered_at
        END,
        last_error = failed.last_error
    FROM unnest($1::bigint[], $2::text[], $3::bigint[], $4::text[])
      AS failed(id, lease_token, delay_seconds, last_error)
    WHERE jobs.id = failed.id AND jobs.lease_token = failed.lease_token
";
const COMPLETE_MIGRATION_CLEANUP_QUERY: &str = "
    UPDATE vault_migrations
    SET state = 'complete', updated_at = now()
    WHERE legacy_object_key = $1 AND state = 'cleanup_queued'
";
const EXPIRE_TRASH_BATCH_QUERY: &str = "SELECT expire_trash_batch($1) AS deleted";
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
        interval: Duration::from_secs(1),
        maximum_interval: Duration::from_secs(5 * 60),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::MultipartReconciliation,
        initial_delay: Duration::from_secs(0),
        interval: Duration::from_secs(2),
        maximum_interval: Duration::from_secs(60),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::CounterReconciliation,
        initial_delay: Duration::from_secs(30 * 60),
        interval: Duration::from_secs(24 * 60 * 60),
        maximum_interval: Duration::from_secs(24 * 60 * 60),
    },
];

fn effective_maintenance_schedule(
    schedule: MaintenanceSchedule,
    _lifecycle_backstop_enabled: bool,
) -> MaintenanceSchedule {
    // The durable sweep cursor stores its next full-scan deadline. The worker
    // still wakes promptly to resume a segment or reclaim an interrupted abort.
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
        maintenance_budget: Arc<Semaphore>,
        namespace: String,
        metrics: Metrics,
        bucket: String,
        legacy_root: PathBuf,
        presign_seconds: u64,
        multipart_threshold_bytes: u64,
        multipart_part_bytes: u64,
        multipart_orphan_grace_seconds: u64,
        lifecycle_backstop_enabled: bool,
    },
}

pub struct MaintenanceProviderPermit {
    _permit: OwnedSemaphorePermit,
    metrics: Metrics,
}

impl Drop for MaintenanceProviderPermit {
    fn drop(&mut self) {
        self.metrics.maintenance_provider_finished();
    }
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

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MultipartIntentSource {
    File,
    Vault,
}

#[cfg(test)]
#[derive(Debug)]
struct MultipartIntent {
    source: MultipartIntentSource,
    status: String,
    upload_id: Option<String>,
    protected_until: SystemTime,
}

#[cfg(test)]
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
        let namespace = format!("{endpoint}|{bucket}");
        let maintenance_s3_config = aws_sdk_s3::config::Builder::from(&shared_config)
            .endpoint_url(endpoint)
            .force_path_style(config.s3_force_path_style)
            .timeout_config(S3RequestPolicy::Maintenance.timeout_config())
            .retry_config(S3RequestPolicy::Maintenance.retry_config())
            .interceptor(S3RetryMetricsInterceptor {
                metrics: metrics.clone(),
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
            maintenance_budget: Arc::new(Semaphore::new(
                config.storage_maintenance_concurrency.max(1),
            )),
            namespace,
            metrics,
            bucket,
            legacy_root: PathBuf::from(&config.storage_path),
            presign_seconds: config.storage_presign_seconds,
            multipart_threshold_bytes: config.storage_multipart_threshold_bytes,
            multipart_part_bytes: config.storage_multipart_part_bytes,
            multipart_orphan_grace_seconds: config.storage_multipart_orphan_grace_seconds,
            lifecycle_backstop_enabled: config.s3_abort_incomplete_multipart_days.is_some(),
        })
    }

    /// Each permit covers exactly one provider operation, including its SDK retries.
    /// All maintenance workers and bucket scans share this fair FIFO budget. Interactive
    /// requests use their own client/admission, so cleanup cannot occupy their capacity.
    pub async fn maintenance_provider_permit(&self) -> Option<MaintenanceProviderPermit> {
        let Self::S3 {
            maintenance_budget,
            metrics,
            ..
        } = self
        else {
            return None;
        };
        let permit = Arc::clone(maintenance_budget)
            .acquire_owned()
            .await
            .expect("maintenance provider budget remains open");
        metrics.maintenance_provider_started();
        Some(MaintenanceProviderPermit {
            _permit: permit,
            metrics: metrics.clone(),
        })
    }

    fn reconciliation_namespace(&self) -> String {
        match self {
            Self::S3 { namespace, .. } => namespace.clone(),
            Self::Local { .. } => "local".to_owned(),
        }
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
        let _provider_permit = self.maintenance_provider_permit().await;
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
        let _provider_permit = self.maintenance_provider_permit().await;
        self.abort_multipart_admitted(object_key, multipart_upload_id)
            .await
    }

    async fn abort_multipart_admitted(
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
                let _provider_permit = if policy == S3RequestPolicy::Maintenance {
                    self.maintenance_provider_permit().await
                } else {
                    None
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

                let _provider_permit = self.maintenance_provider_permit().await;
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

    fn bulk_delete_available(&self) -> bool {
        matches!(self, Self::S3 { .. })
    }

    fn supports_bulk_delete(&self, object_key: &str) -> bool {
        self.bulk_delete_available() && object_key.starts_with(STORAGE_OBJECT_PREFIX)
    }

    pub async fn delete_objects(&self, object_keys: &[String]) -> Vec<Result<(), StorageError>> {
        if object_keys.is_empty() {
            return Vec::new();
        }
        if object_keys.len() > S3_DELETE_OBJECTS_MAX_KEYS
            || !object_keys.iter().all(|key| self.supports_bulk_delete(key))
        {
            let message = if object_keys.len() > S3_DELETE_OBJECTS_MAX_KEYS {
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
        let _provider_permit = self.maintenance_provider_permit().await;
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
    let upload_claim_cursor = Arc::new(UploadClaimCursor::new(None));
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
            let upload_claim_cursor = Arc::clone(&upload_claim_cursor);
            async move {
                let started = Instant::now();
                let outcome = schedule
                    .worker
                    .run(
                        &db,
                        &storage,
                        &metrics,
                        storage_concurrency,
                        &upload_claim_cursor,
                    )
                    .await;
                let success = outcome.is_ok();
                let iteration = match outcome {
                    Ok(true) => MaintenanceIteration::Worked,
                    Ok(false) => match schedule.worker.next_due_delay(&db).await {
                        Ok(next_due) => MaintenanceIteration::Idle { next_due },
                        Err(error) => {
                            log::error!(
                                "{} maintenance next-due query failed: {error}",
                                schedule.worker.label()
                            );
                            MaintenanceIteration::Failed
                        }
                    },
                    Err(error) => {
                        log::error!(
                            "{} maintenance worker failed: {error}",
                            schedule.worker.label()
                        );
                        MaintenanceIteration::Failed
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
enum MaintenanceIteration {
    Worked,
    // Failures retry at the base interval instead of immediately, so an
    // unavailable database or provider cannot turn a worker into a hot loop.
    Failed,
    Idle { next_due: Option<Duration> },
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
        let notified = match select(
            Box::pin(wait_for_shutdown(shutdown.clone())),
            Box::pin(select(
                Box::pin(sleep(next_delay)),
                Box::pin(wait_for_maintenance_notification(
                    &mut notifications,
                    worker,
                )),
            )),
        )
        .await
        {
            Either::Left(_) => break,
            Either::Right((Either::Left(_), _)) => false,
            Either::Right((Either::Right(_), _)) => true,
        };
        // Every queued notification was committed before this run starts, so
        // the run already observes its change. A burst therefore costs one run.
        if drain_maintenance_notifications(&mut notifications, worker) || notified {
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
        (idle_interval, next_delay) = adaptive_maintenance_delay(
            worker,
            idle_interval,
            base_interval,
            maximum_interval,
            iteration,
        );
    }
}

fn adaptive_maintenance_delay(
    worker: MaintenanceWorker,
    idle_interval: Duration,
    base_interval: Duration,
    maximum_interval: Duration,
    iteration: MaintenanceIteration,
) -> (Duration, Duration) {
    match iteration {
        // Queue workers claim bounded batches, so more of a backlog may already
        // be due. Rerun now instead of relying on the claim to notify this
        // worker again; draining folds such self-notifications into one run.
        MaintenanceIteration::Worked if worker.drains_backlog() => (base_interval, Duration::ZERO),
        MaintenanceIteration::Worked | MaintenanceIteration::Failed => {
            (base_interval, base_interval)
        }
        MaintenanceIteration::Idle { next_due } => {
            let idle_interval = idle_interval
                .checked_mul(2)
                .unwrap_or(maximum_interval)
                .min(maximum_interval);
            let next_delay = next_due.map_or(idle_interval, |due| {
                idle_interval.min(due.max(base_interval))
            });
            (idle_interval, next_delay)
        }
    }
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

/// Discards every queued notification and reports whether one concerned this
/// worker. A lagged receiver lost messages, so it counts as concerning it.
fn drain_maintenance_notifications(
    notifications: &mut broadcast::Receiver<String>,
    worker: MaintenanceWorker,
) -> bool {
    let mut notified = false;
    loop {
        match notifications.try_recv() {
            Ok(payload) => notified |= worker.accepts_notification(&payload),
            Err(broadcast::error::TryRecvError::Lagged(_)) => notified = true,
            Err(broadcast::error::TryRecvError::Empty | broadcast::error::TryRecvError::Closed) => {
                return notified;
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

    /// Reconciliation sweeps pace their provider listings and full-table
    /// scans by their interval, even after a run that found something to fix.
    const fn drains_backlog(self) -> bool {
        !matches!(
            self,
            Self::MultipartReconciliation | Self::CounterReconciliation
        )
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
                "SELECT MIN(next_due_at) AS next_at FROM trash_expiry_owners WHERE next_due_at IS NOT NULL"
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
        upload_claim_cursor: &UploadClaimCursor,
    ) -> Result<bool, Box<dyn StdError + Send + Sync>> {
        match self {
            Self::UserDeletion => process_user_deletion_jobs(db).await,
            Self::StorageDeletion => process_deletion_jobs(db, storage, storage_concurrency).await,
            Self::UploadFinalization => {
                reconcile_file_upload_completions(db, storage, upload_claim_cursor).await
            }
            Self::LegacyUploadExpiry => expire_abandoned_uploads(db, upload_claim_cursor).await,
            Self::VaultUploadExpiry => {
                expire_abandoned_vault_uploads(
                    db,
                    storage,
                    storage_concurrency,
                    upload_claim_cursor,
                )
                .await
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
    let Some(job) = query_opt_cached(
        &transaction,
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
        execute_cached(&transaction, "UPDATE user_deletion_jobs SET locked_until = NULL, lease_token = NULL WHERE user_id = $1 AND lease_token = $2",
                &[&user_id, &lease_token],
            )
            .await?;
        transaction.commit().await?;
        return Ok(());
    }

    if phase == "finalize" {
        let user = query_opt_cached(
            &transaction,
            "SELECT id FROM users WHERE id = $1 AND status = 'deleting' FOR UPDATE",
            &[&user_id],
        )
        .await?;
        if user.is_none() {
            execute_cached(
                &transaction,
                "DELETE FROM user_deletion_jobs WHERE user_id = $1",
                &[&user_id],
            )
            .await?;
            transaction.commit().await?;
            return Ok(());
        }
        let residual_objects: bool = query_one_cached(
            &transaction,
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
            execute_cached(&transaction, "UPDATE user_deletion_jobs SET phase = 'file_uploads', locked_until = NULL, lease_token = NULL, updated_at = now() WHERE user_id = $1 AND lease_token = $2",
                    &[&user_id, &lease_token],
                )
                .await?;
        } else {
            execute_cached(
                &transaction,
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
    execute_cached(
        &transaction,
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
    transaction: &deadpool_postgres::Transaction<'_>,
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
            execute_cached(transaction, statement, &[&user_id, &batch_size]).await
        }
    }
}

async fn deletion_query_count(
    transaction: &deadpool_postgres::Transaction<'_>,
    statement: &str,
    user_id: &str,
    batch_size: i64,
) -> Result<u64, tokio_postgres::Error> {
    let row = query_one_cached(transaction, statement, &[&user_id, &batch_size]).await?;
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
    owner_id: String,
    object_key: Option<String>,
    multipart_upload_id: Option<String>,
    write_expires_at: Option<SystemTime>,
}

async fn claim_expired_uploads(
    db: &Database,
    candidate_query: &str,
    claim_query: &str,
    cursor: &UploadClaimCursor,
) -> Result<Vec<tokio_postgres::Row>, Box<dyn StdError + Send + Sync>> {
    let mut cursor = cursor.lock().await;
    let mut next_cursor = cursor.clone();
    let mut client = db.get().await?;
    let transaction = client.transaction().await?;
    // New arrivals belong to the next sweep. Otherwise a perpetually busy queue
    // could keep extending this scan and prevent previously fenced rows behind
    // the cursor from ever being reconsidered.
    let sweep_cutoff = if let Some((_, _, cutoff)) = next_cursor.as_ref() {
        *cutoff
    } else {
        query_one_cached(&transaction, "SELECT clock_timestamp() AS cutoff", &[])
            .await?
            .get::<_, SystemTime>("cutoff")
    };
    let mut uploads = Vec::new();
    for _ in 0..4 {
        let remaining = 25 - uploads.len() as i64;
        if remaining == 0 {
            break;
        }
        // Page the raw due index before ancestry checks or lock attempts. Keep
        // the position across worker ticks so a fenced prefix cannot repeatedly
        // consume the entire turn and starve healthy uploads later in the queue.
        let candidates = query_cached(
            &transaction,
            candidate_query,
            &[
                &remaining,
                &next_cursor.as_ref().map(|(expires_at, _, _)| *expires_at),
                &next_cursor.as_ref().map(|(_, id, _)| id.as_str()),
                &sweep_cutoff,
            ],
        )
        .await?;
        if candidates.is_empty() {
            next_cursor = None;
            break;
        }
        let end_of_queue = candidates.len() < remaining as usize;
        let last = candidates.last().expect("nonempty expiry candidate page");
        next_cursor = Some((last.get("expires_at"), last.get("id"), sweep_cutoff));
        let upload_ids = candidates
            .iter()
            .map(|row| row.get::<_, String>("id"))
            .collect::<Vec<_>>();
        let mut owner_ids = candidates
            .iter()
            .map(|row| row.get::<_, String>("owner_id"))
            .collect::<Vec<_>>();
        owner_ids.sort_unstable();
        owner_ids.dedup();
        let admitted_owners = lock_upload_claim_owners(&transaction, &owner_ids).await?;
        // A new statement sees fences published since candidate selection.
        // Owner advisory + version locks precede upload row locks and remain
        // held until both the lease and cleanup queue insertion commit.
        if !admitted_owners.is_empty() {
            uploads.extend(
                query_cached(&transaction, claim_query, &[&upload_ids, &admitted_owners]).await?,
            );
        }
        if end_of_queue {
            next_cursor = None;
            break;
        }
    }
    transaction.commit().await?;
    *cursor = next_cursor;
    Ok(uploads)
}

async fn expire_abandoned_vault_uploads(
    db: &Database,
    storage: &Storage,
    storage_concurrency: usize,
    cursor: &UploadClaimCursor,
) -> Result<bool, Box<dyn StdError + Send + Sync>> {
    let uploads = claim_expired_uploads(
        db,
        CANDIDATE_EXPIRED_VAULT_UPLOADS_QUERY,
        CLAIM_EXPIRED_VAULT_UPLOADS_QUERY,
        cursor,
    )
    .await?
    .into_iter()
    .map(|upload| ExpiredVaultUpload {
        id: upload.get("id"),
        owner_id: upload.get("owner_id"),
        object_key: upload.get("object_key"),
        multipart_upload_id: upload.get("multipart_upload_id"),
        write_expires_at: upload.get("write_expires_at"),
    })
    .collect::<Vec<_>>();

    let outcomes = run_bounded_storage_tasks(uploads, storage_concurrency, |upload| async move {
        let ExpiredVaultUpload {
            id,
            owner_id,
            object_key,
            multipart_upload_id,
            write_expires_at,
        } = upload;

        if write_expires_at.is_some_and(|expires_at| expires_at > SystemTime::now()) {
            // The claim already extended the lease past this write authorization.
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
                let mut client = db.get().await?;
                let transaction = client.transaction().await?;
                let admitted_owners =
                    lock_upload_claim_owners(&transaction, &[owner_id]).await?;
                if !admitted_owners.is_empty() {
                    execute_cached(&transaction, "WITH ready AS (
                              SELECT id FROM vault_uploads AS uploads
                              WHERE id = $1 AND owner_id = ANY($2::text[]) AND status = 'aborting'
                                AND NOT EXISTS (
                                  SELECT 1 FROM tree_operation_jobs AS jobs
                                  WHERE jobs.owner_id = uploads.owner_id
                                    AND jobs.status IN ('pending', 'running')
                                    AND (
                                      tree_operation_ancestor(uploads.node_id, uploads.owner_id, jobs.root_id)
                                      OR tree_operation_ancestor(uploads.parent_id, uploads.owner_id, jobs.root_id)
                                    )
                                )
                              FOR UPDATE SKIP LOCKED
                            )
                            UPDATE vault_uploads AS uploads SET status = 'aborted'
                            FROM ready WHERE uploads.id = ready.id",
                            &[&id, &admitted_owners],
                        )
                        .await?;
                }
                transaction.commit().await?;
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
    let namespace = storage.reconciliation_namespace();
    let mut did_work =
        process_orphan_abort_claims(db, storage, metrics, &namespace, storage_concurrency).await?;
    let lease = db
        .query_opt(
            "INSERT INTO multipart_reconciliation_progress (namespace, lease_token, lease_until)
         VALUES ($1, gen_random_uuid()::text, now() + ($2::bigint * interval '1 second'))
         ON CONFLICT (namespace) DO UPDATE SET lease_token = gen_random_uuid()::text,
           lease_until = now() + ($2::bigint * interval '1 second'), updated_at = now()
         WHERE multipart_reconciliation_progress.next_scan_at <= now()
           AND (multipart_reconciliation_progress.lease_until IS NULL
             OR multipart_reconciliation_progress.lease_until <= now())
         RETURNING lease_token, key_marker, upload_id_marker",
            &[&namespace, &MULTIPART_SWEEP_LEASE_SECONDS],
        )
        .await?;
    let Some(lease) = lease else {
        return Ok(did_work);
    };
    let token: String = lease.get("lease_token");
    let key_marker: Option<String> = lease.get("key_marker");
    let upload_id_marker: Option<String> = lease.get("upload_id_marker");
    // The owned pooled client used by each Database query has already been returned.
    // The durable token, rather than a session lock, fences every checkpoint.
    let result = sweep_orphaned_multipart_uploads(
        db,
        storage,
        &namespace,
        &token,
        key_marker,
        upload_id_marker,
        grace_seconds,
    )
    .await;
    let cooldown = if result.is_err() { 30_i64 } else { 0_i64 };
    db.execute(
        "UPDATE multipart_reconciliation_progress SET lease_token = NULL, lease_until = NULL,
           next_scan_at = GREATEST(next_scan_at, now() + ($3::bigint * interval '1 second'))
         WHERE namespace = $1 AND lease_token = $2",
        &[&namespace, &token, &cooldown],
    )
    .await?;
    did_work |= result?;
    Ok(did_work)
}

async fn sweep_orphaned_multipart_uploads(
    db: &Database,
    storage: &Storage,
    namespace: &str,
    token: &str,
    mut key_marker: Option<String>,
    mut upload_id_marker: Option<String>,
    grace_seconds: u64,
) -> Result<bool, Box<dyn StdError + Send + Sync>> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let cutoff = i64::try_from(now.saturating_sub(grace_seconds)).unwrap_or(i64::MAX);
    let started = Instant::now();
    for _ in 0..MULTIPART_SWEEP_PAGES_PER_TICK {
        let renewed = db
            .execute(
                "UPDATE multipart_reconciliation_progress
             SET lease_until = now() + ($3::bigint * interval '1 second')
             WHERE namespace = $1 AND lease_token = $2 AND lease_until > now()",
                &[&namespace, &token, &MULTIPART_SWEEP_LEASE_SECONDS],
            )
            .await?;
        if renewed != 1 {
            return Err(storage_message("multipart reconciliation lease was lost").into());
        }
        let page = storage
            .multipart_upload_page(
                STORAGE_OBJECT_PREFIX,
                key_marker.as_deref(),
                upload_id_marker.as_deref(),
            )
            .await?;
        if page.next_key_marker.is_some()
            && page.next_key_marker == key_marker
            && page.next_upload_id_marker == upload_id_marker
        {
            return Err(storage_message(
                "S3 multipart listing returned unchanged pagination markers",
            )
            .into());
        }
        let candidates = page
            .uploads
            .into_iter()
            .filter(|upload| upload.initiated_epoch_seconds <= cutoff)
            .collect::<Vec<_>>();
        // Prepare and hand off 64 candidates at a time. The SQL function adopts
        // live intents and durably fences true orphans under their object locks.
        for group in candidates.chunks(MULTIPART_PREPARE_BATCH_SIZE) {
            let keys = group
                .iter()
                .map(|item| item.object_key.clone())
                .collect::<Vec<_>>();
            let ids = group
                .iter()
                .map(|item| item.upload_id.clone())
                .collect::<Vec<_>>();
            db.query_one(
                "SELECT prepare_multipart_orphan_group($1, $2, $3, $4)",
                &[&namespace, &token, &keys, &ids],
            )
            .await?;
        }
        let next_key_marker = page.next_key_marker;
        let next_upload_id_marker = page.next_upload_id_marker;
        let completed = next_key_marker.is_none();
        let next_scan_seconds = if completed {
            if storage.lifecycle_backstop_enabled() {
                24 * 60 * 60_i64
            } else {
                60 * 60_i64
            }
        } else {
            0_i64
        };
        let checkpointed = db
            .execute(
                "UPDATE multipart_reconciliation_progress
             SET key_marker = $3, upload_id_marker = $4, updated_at = now(),
                 next_scan_at = now() + ($5::bigint * interval '1 second')
             WHERE namespace = $1 AND lease_token = $2 AND lease_until > now()",
                &[
                    &namespace,
                    &token,
                    &next_key_marker,
                    &next_upload_id_marker,
                    &next_scan_seconds,
                ],
            )
            .await?;
        if checkpointed != 1 {
            return Err(storage_message("multipart reconciliation lease was lost").into());
        }
        key_marker = next_key_marker;
        upload_id_marker = next_upload_id_marker;
        if completed || started.elapsed() >= Duration::from_secs(15) {
            break;
        }
    }
    Ok(true)
}

async fn process_orphan_abort_claims(
    db: &Database,
    storage: &Storage,
    metrics: &Metrics,
    namespace: &str,
    concurrency: usize,
) -> Result<bool, Box<dyn StdError + Send + Sync>> {
    let rows = db
        .query(
            "WITH selected AS (
           SELECT namespace, object_key, upload_id FROM multipart_orphan_abort_claims
           WHERE namespace = $1 AND next_attempt_at <= now()
             AND (lease_until IS NULL OR lease_until <= now())
           ORDER BY next_attempt_at, object_key, upload_id LIMIT $2 FOR UPDATE SKIP LOCKED
         ) UPDATE multipart_orphan_abort_claims AS claims
         SET lease_token = gen_random_uuid()::text, lease_until = now() + interval '120 seconds'
         FROM selected WHERE claims.namespace = selected.namespace
           AND claims.object_key = selected.object_key AND claims.upload_id = selected.upload_id
         RETURNING claims.object_key, claims.upload_id, claims.lease_token",
            &[
                &namespace,
                &i64::try_from(concurrency.clamp(1, 64)).unwrap_or(64),
            ],
        )
        .await?;
    let did_work = !rows.is_empty();
    let outcomes = run_bounded_storage_tasks(rows, concurrency, |row| async move {
        let object_key: String = row.get("object_key");
        let upload_id: String = row.get("upload_id");
        let lease_token: String = row.get("lease_token");
        // Queue waiting never consumes a DB connection or a claim's provider window.
        // Renew after admission and verify that no replacement worker owns this item.
        let _provider_permit = storage.maintenance_provider_permit().await;
        let renewed = db.execute(
            "UPDATE multipart_orphan_abort_claims SET lease_until = now() + interval '120 seconds'
             WHERE namespace = $1 AND object_key = $2 AND upload_id = $3 AND lease_token = $4",
            &[&namespace, &object_key, &upload_id, &lease_token],
        ).await?;
        if renewed != 1 { return Ok::<(), Box<dyn StdError + Send + Sync>>(()); }
        let result = storage.abort_multipart_admitted(&object_key, &upload_id).await;
        drop(_provider_permit);
        match result {
            Ok(()) => { db.execute(
                "DELETE FROM multipart_orphan_abort_claims
                 WHERE namespace = $1 AND object_key = $2 AND upload_id = $3 AND lease_token = $4",
                &[&namespace, &object_key, &upload_id, &lease_token],
            ).await?; }
            Err(error) => {
                metrics.record_maintenance_item_failure("multipart reconciliation abort");
                db.execute(
                    "UPDATE multipart_orphan_abort_claims SET attempts = attempts + 1,
                       lease_token = NULL, lease_until = NULL,
                       next_attempt_at = now() + (LEAST(3600, 30 * power(2, LEAST(attempts, 7))) * interval '1 second')
                     WHERE namespace = $1 AND object_key = $2 AND upload_id = $3 AND lease_token = $4",
                    &[&namespace, &object_key, &upload_id, &lease_token],
                ).await?;
                tracing::warn!(%error, "multipart orphan abort deferred");
            }
        }
        Ok(())
    }).await;
    for outcome in outcomes {
        outcome?;
    }
    Ok(did_work)
}

#[cfg(test)]
#[derive(Default)]
struct ReconciliationFailures {
    count: usize,
    samples: Vec<String>,
}

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
fn active_multipart_status(status: &str) -> bool {
    matches!(
        status,
        "initializing" | "pending" | "completing" | "aborting"
    )
}

#[cfg(test)]
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

#[cfg(test)]
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
            let current = query_opt_cached(&transaction, "SELECT multipart_upload_id FROM storage_deletion_jobs WHERE id = $1 AND lease_token = $2 FOR UPDATE",
                    &[&id, &lease_token],
                )
                .await?;
            let Some(current) = current else {
                return Ok(());
            };
            let current_multipart_upload_id: Option<String> = current.get("multipart_upload_id");
            if current_multipart_upload_id != multipart_upload_id {
                execute_cached(&transaction, "UPDATE storage_deletion_jobs SET available_at = now(), locked_until = NULL, lease_token = NULL WHERE id = $1 AND lease_token = $2",
                        &[&id, &lease_token],
                    )
                    .await?;
                transaction.commit().await?;
                return Ok(());
            }
            execute_cached(&transaction, "UPDATE file_uploads SET status = 'aborted' WHERE object_key = $1 AND status = 'aborting'",
                    &[&object_key],
                )
                .await?;
            execute_cached(&transaction, "UPDATE vault_uploads SET status = 'aborted' WHERE object_key = $1 AND status = 'aborting'",
                    &[&object_key],
                )
                .await?;
            execute_cached(
                &transaction,
                COMPLETE_MIGRATION_CLEANUP_QUERY,
                &[&object_key],
            )
            .await?;
            execute_cached(
                &transaction,
                "DELETE FROM storage_deletion_jobs WHERE id = $1 AND lease_token = $2",
                &[&id, &lease_token],
            )
            .await?;
            transaction.commit().await?;
        }
        Err(error) => {
            let delay_seconds = retry_delay_seconds(attempts);
            let error_message = storage_deletion_error_message(&error);
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

fn storage_deletion_error_message(error: &StorageError) -> String {
    error.to_string().chars().take(500).collect()
}

/// Finalizes a batch of bulk deletions with one statement for the successes
/// and one for the failures, with the same lease fencing and bookkeeping as
/// `finish_storage_deletion_job`.
async fn finish_storage_deletion_batch(
    db: &Database,
    outcomes: Vec<(StorageDeletionJob, Result<(), StorageError>)>,
) -> Result<(), Box<dyn StdError + Send + Sync>> {
    let mut finished_ids = Vec::new();
    let mut finished_lease_tokens = Vec::new();
    let mut finished_multipart_upload_ids = Vec::new();
    let mut failed_ids = Vec::new();
    let mut failed_lease_tokens = Vec::new();
    let mut failed_delay_seconds = Vec::new();
    let mut failed_errors = Vec::new();
    for (job, deletion_result) in outcomes {
        match deletion_result {
            Ok(()) => {
                finished_ids.push(job.id);
                finished_lease_tokens.push(job.lease_token);
                finished_multipart_upload_ids.push(job.multipart_upload_id);
            }
            Err(error) => {
                failed_ids.push(job.id);
                failed_lease_tokens.push(job.lease_token);
                failed_delay_seconds.push(retry_delay_seconds(job.attempts));
                failed_errors.push(storage_deletion_error_message(&error));
            }
        }
    }
    if !finished_ids.is_empty() {
        db.query_one(
            FINISH_STORAGE_DELETION_BATCH_QUERY,
            &[
                &finished_ids,
                &finished_lease_tokens,
                &finished_multipart_upload_ids,
            ],
        )
        .await?;
    }
    if !failed_ids.is_empty() {
        db.execute(
            FAIL_STORAGE_DELETION_BATCH_QUERY,
            &[
                &failed_ids,
                &failed_lease_tokens,
                &failed_delay_seconds,
                &failed_errors,
                &MAINTENANCE_DEAD_LETTER_ATTEMPTS,
            ],
        )
        .await?;
    }
    Ok(())
}

fn bulk_delete_chunks<Item>(items: Vec<Item>) -> Vec<Vec<Item>> {
    let mut items = items.into_iter().peekable();
    let mut chunks = Vec::new();
    while items.peek().is_some() {
        chunks.push(items.by_ref().take(S3_DELETE_OBJECTS_MAX_KEYS).collect());
    }
    chunks
}

async fn claim_storage_deletion_jobs(
    db: &Database,
    query: &str,
    params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
) -> Result<Vec<StorageDeletionJob>, Box<dyn StdError + Send + Sync>> {
    Ok(db
        .query(query, params)
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
        .collect())
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
    let mut jobs = if storage.bulk_delete_available() {
        claim_storage_deletion_jobs(
            db,
            CLAIM_BULK_STORAGE_DELETION_JOBS_QUERY,
            &[
                &STORAGE_JOB_LEASE_SECONDS,
                &STORAGE_OBJECT_PREFIX,
                &STORAGE_DELETION_BULK_CLAIM_SIZE,
            ],
        )
        .await?
    } else {
        Vec::new()
    };
    jobs.extend(
        claim_storage_deletion_jobs(
            db,
            CLAIM_STORAGE_DELETION_JOBS_QUERY,
            &[&STORAGE_JOB_LEASE_SECONDS],
        )
        .await?,
    );

    let did_work = !jobs.is_empty();
    let (bulk_jobs, individual_jobs): (Vec<_>, Vec<_>) = jobs.into_iter().partition(|job| {
        !job.discover_multipart
            && job.multipart_upload_id.is_none()
            && storage.supports_bulk_delete(&job.object_key)
    });
    let bulk_outcomes = run_bounded_storage_tasks(
        bulk_delete_chunks(bulk_jobs),
        storage_concurrency,
        |jobs| async move {
            let keys = jobs
                .iter()
                .map(|job| job.object_key.clone())
                .collect::<Vec<_>>();
            let results = storage.delete_objects(&keys).await;
            jobs.into_iter().zip(results).collect::<Vec<_>>()
        },
    )
    .await;
    let bulk_finished =
        finish_storage_deletion_batch(db, bulk_outcomes.into_iter().flatten().collect()).await;
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
    bulk_finished?;
    for outcome in individual_outcomes {
        outcome?;
    }

    Ok(did_work)
}

async fn reconcile_file_upload_completions(
    db: &Database,
    storage: &Storage,
    cursor: &UploadClaimCursor,
) -> Result<bool, Box<dyn StdError + Send + Sync>> {
    let uploads = claim_file_upload_completions(db, 25, cursor).await?;
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
                | FileUploadFinalizeOutcome::StateChanged
                | FileUploadFinalizeOutcome::ParentUnavailable
                | FileUploadFinalizeOutcome::Deferred,
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
    cursor: &UploadClaimCursor,
) -> Result<bool, Box<dyn StdError + Send + Sync>> {
    let uploads = claim_expired_uploads(
        db,
        CANDIDATE_EXPIRED_FILE_UPLOADS_QUERY,
        CLAIM_EXPIRED_FILE_UPLOADS_QUERY,
        cursor,
    )
    .await?;
    Ok(!uploads.is_empty())
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
    let lock_acquired: bool = query_one_cached(
        &transaction,
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
        let row = query_one_cached(
            &transaction,
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
    let admin_updated = execute_cached(&transaction, RECONCILE_ADMIN_COUNTERS_QUERY, &[]).await?;
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
        let migration = include_str!("../../database/init/034_indexed_trash_expiry.sql");
        assert!(EXPIRE_TRASH_BATCH_QUERY.contains("expire_trash_batch($1)"));
        assert!(migration.contains("FOR SHARE OF users SKIP LOCKED"));
        assert!(migration.contains("files_trash_leaf_owner_due_idx"));
        assert!(migration.contains("trash_expiry_owners_due_idx"));
        assert!(migration.contains("children.parent_id = files.id"));
        assert!(migration.contains("FOR UPDATE OF files SKIP LOCKED"));
        assert!(migration.contains("INSERT INTO storage_deletion_jobs"));
        assert!(migration.contains("targets.write_expires_at"));

        let worker = MAINTENANCE_SCHEDULES
            .iter()
            .find(|schedule| schedule.worker == MaintenanceWorker::TrashExpiry)
            .expect("trash expiry schedule should exist");
        assert_eq!(worker.interval, Duration::from_secs(1));
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
                MaintenanceWorker::StorageDeletion,
                idle,
                base,
                maximum,
                MaintenanceIteration::Idle { next_due: None },
            );
        }
        assert_eq!(delay, maximum);
        let fixed_queries_per_day = 86_400 / base.as_secs();
        let adaptive_queries_per_day = 2 * 86_400 / maximum.as_secs();
        assert!(fixed_queries_per_day >= adaptive_queries_per_day * 10);

        let (_, due_delay) = adaptive_maintenance_delay(
            MaintenanceWorker::StorageDeletion,
            maximum,
            base,
            maximum,
            MaintenanceIteration::Idle {
                next_due: Some(Duration::ZERO),
            },
        );
        assert_eq!(due_delay, base);
    }

    #[test]
    fn busy_maintenance_queues_rerun_at_once_but_failures_wait() {
        let base = Duration::from_secs(10);
        let maximum = Duration::from_secs(5 * 60);
        let delay = |worker, iteration| {
            adaptive_maintenance_delay(worker, maximum, base, maximum, iteration)
        };
        assert_eq!(
            delay(
                MaintenanceWorker::StorageDeletion,
                MaintenanceIteration::Worked
            ),
            (base, Duration::ZERO)
        );
        assert_eq!(
            delay(
                MaintenanceWorker::StorageDeletion,
                MaintenanceIteration::Failed
            ),
            (base, base)
        );
        // Reconciliation sweeps pace their provider and full-table scans.
        assert_eq!(
            delay(
                MaintenanceWorker::MultipartReconciliation,
                MaintenanceIteration::Worked
            ),
            (base, base)
        );
        assert_eq!(
            delay(
                MaintenanceWorker::CounterReconciliation,
                MaintenanceIteration::Worked
            ),
            (base, base)
        );
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
                    MaintenanceIteration::Worked
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

    #[actix_web::test]
    async fn maintenance_notification_bursts_coalesce_into_one_run() {
        const BURST: usize = 64;
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let (notification_tx, notification_rx) = broadcast::channel(256);
        let runs = Arc::new(AtomicUsize::new(0));
        let runs_for_task = Arc::clone(&runs);
        let notification_tx_for_task = notification_tx.clone();
        // Commits that land before the first run, interleaved with other tables.
        for _ in 0..BURST {
            notification_tx
                .send("vault_uploads".to_owned())
                .expect("the adaptive worker should be subscribed");
            notification_tx
                .send("sessions".to_owned())
                .expect("the adaptive worker should be subscribed");
        }
        let task = tokio::spawn(run_adaptive_task(
            MaintenanceWorker::VaultUploadExpiry,
            Duration::from_secs(60),
            Duration::from_secs(10),
            Duration::from_secs(300),
            shutdown_rx,
            notification_rx,
            move || {
                let runs = Arc::clone(&runs_for_task);
                let notification_tx = notification_tx_for_task.clone();
                async move {
                    if runs.fetch_add(1, Ordering::SeqCst) == 0 {
                        // Commits that land while the first run is in progress.
                        for _ in 0..BURST {
                            let _ = notification_tx.send("vault_uploads".to_owned());
                        }
                    }
                    MaintenanceIteration::Idle { next_due: None }
                }
            },
        ));

        tokio::time::timeout(Duration::from_millis(250), async {
            while runs.load(Ordering::SeqCst) < 2 {
                sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("notifications during a run should trigger one follow-up run");
        sleep(Duration::from_millis(50)).await;
        assert_eq!(
            runs.load(Ordering::SeqCst),
            2,
            "each burst of {BURST} notifications should cost exactly one run"
        );

        shutdown_tx
            .send(true)
            .expect("maintenance shutdown receiver should remain active");
        tokio::time::timeout(Duration::from_millis(250), task)
            .await
            .expect("the adaptive worker should stop on shutdown")
            .expect("the adaptive worker should not panic");
    }

    #[actix_web::test]
    async fn busy_maintenance_queues_keep_draining_without_notifications() {
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let (_notification_tx, notification_rx) = broadcast::channel(4);
        let runs = Arc::new(AtomicUsize::new(0));
        let runs_for_task = Arc::clone(&runs);
        let task = tokio::spawn(run_adaptive_task(
            MaintenanceWorker::StorageDeletion,
            Duration::ZERO,
            Duration::from_secs(10),
            Duration::from_secs(300),
            shutdown_rx,
            notification_rx,
            move || {
                let runs = Arc::clone(&runs_for_task);
                let shutdown_tx = shutdown_tx.clone();
                async move {
                    if runs.fetch_add(1, Ordering::SeqCst) < 3 {
                        return MaintenanceIteration::Worked;
                    }
                    let _ = shutdown_tx.send(true);
                    MaintenanceIteration::Idle { next_due: None }
                }
            },
        ));

        tokio::time::timeout(Duration::from_millis(250), task)
            .await
            .expect("a run that did work should not wait out the base interval")
            .expect("the adaptive worker should not panic");
        assert_eq!(runs.load(Ordering::SeqCst), 4);
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
        assert_eq!(base.interval, Duration::from_secs(2));
        assert_eq!(
            effective_maintenance_schedule(base, true).interval,
            Duration::from_secs(2)
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
        assert!(reconciliation.contains("query_one_cached(\n            &transaction,"));
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
        for query in [
            CLAIM_STORAGE_DELETION_JOBS_QUERY,
            CLAIM_BULK_STORAGE_DELETION_JOBS_QUERY,
            FINISH_STORAGE_DELETION_BATCH_QUERY,
            FAIL_STORAGE_DELETION_BATCH_QUERY,
        ] {
            client
                .prepare(query)
                .await
                .expect("the storage deletion queries should prepare");
        }
        client
            .prepare(EXPIRE_TRASH_BATCH_QUERY)
            .await
            .expect("the trash expiry query should prepare");
    }

    #[test]
    fn bulk_storage_deletion_claims_only_plain_objects_in_provider_sized_batches() {
        let query = CLAIM_BULK_STORAGE_DELETION_JOBS_QUERY;
        for fence in [
            "jobs.available_at <= now()",
            "jobs.dead_lettered_at IS NULL",
            "(jobs.locked_until IS NULL OR jobs.locked_until < now())",
            "jobs.multipart_upload_id IS NULL",
            "starts_with(jobs.object_key, $2)",
            "vault_uploads.multipart_upload_id IS NULL",
            "ORDER BY jobs.id",
            "LIMIT $3",
            "FOR UPDATE OF jobs SKIP LOCKED",
            "lease_token = gen_random_uuid()::text",
        ] {
            assert!(query.contains(fence), "bulk claim lost {fence}");
        }

        for query in [
            FINISH_STORAGE_DELETION_BATCH_QUERY,
            FAIL_STORAGE_DELETION_BATCH_QUERY,
        ] {
            assert!(query.contains("lease_token = "));
            assert!(query.contains("unnest("));
        }
        assert!(
            FINISH_STORAGE_DELETION_BATCH_QUERY
                .contains("legacy_object_key IN (SELECT object_key FROM finished)")
        );
        assert!(FINISH_STORAGE_DELETION_BATCH_QUERY.contains("state = 'cleanup_queued'"));
    }

    #[test]
    fn bulk_deletion_chunks_never_exceed_the_provider_key_limit() {
        assert!(bulk_delete_chunks(Vec::<usize>::new()).is_empty());
        let chunks = bulk_delete_chunks((0..2_501).collect::<Vec<_>>());
        assert_eq!(
            chunks.iter().map(Vec::len).collect::<Vec<_>>(),
            [1_000, 1_000, 501]
        );
        assert!(
            chunks.into_iter().flatten().eq(0..2_501),
            "chunking must keep every job exactly once and in order"
        );
    }

    type DeleteObjectsRequests = Arc<std::sync::Mutex<Vec<Vec<String>>>>;

    /// An S3 endpoint that accepts every request but reports a per-key
    /// `AccessDenied` for bulk-deleted keys containing `denied`.
    fn partially_failing_s3() -> (
        Storage,
        DeleteObjectsRequests,
        actix_web::dev::ServerHandle,
        actix_web::rt::task::JoinHandle<std::io::Result<()>>,
    ) {
        use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
        let requests = DeleteObjectsRequests::default();
        let observed = Arc::clone(&requests);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = HttpServer::new(move || {
            let observed = Arc::clone(&observed);
            App::new().default_service(web::to(move |request: HttpRequest, body: web::Bytes| {
                let observed = Arc::clone(&observed);
                async move {
                    if !request.query_string().contains("delete") {
                        return HttpResponse::NoContent().finish();
                    }
                    let body = String::from_utf8_lossy(&body);
                    let keys = body
                        .split("<Key>")
                        .skip(1)
                        .filter_map(|entry| entry.split("</Key>").next())
                        .map(str::to_owned)
                        .collect::<Vec<_>>();
                    let errors = keys
                        .iter()
                        .filter(|key| key.contains("denied"))
                        .map(|key| format!(
                            "<Error><Key>{key}</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error>"
                        ))
                        .collect::<String>();
                    observed.lock().unwrap().push(keys);
                    HttpResponse::Ok().content_type("application/xml").body(format!(
                        "<DeleteResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">{errors}</DeleteResult>"
                    ))
                }
            }))
        })
        .workers(1)
        .listen(listener)
        .unwrap()
        .run();
        let handle = server.handle();
        let task = actix_web::rt::spawn(server);
        let client = aws_sdk_s3::Client::from_conf(
            aws_sdk_s3::config::Builder::new()
                .behavior_version_latest()
                .region(Region::new("us-east-1"))
                .credentials_provider(Credentials::new("test", "test", None, None, "test"))
                .endpoint_url(endpoint.clone())
                .force_path_style(true)
                .build(),
        );
        let config = Config::from_env().unwrap();
        let storage = Storage::S3 {
            client: client.clone(),
            maintenance_client: client,
            maintenance_budget: Arc::new(Semaphore::new(4)),
            namespace: endpoint,
            metrics: Metrics::new(&config),
            bucket: "test".to_owned(),
            legacy_root: PathBuf::new(),
            presign_seconds: 60,
            multipart_threshold_bytes: 1,
            multipart_part_bytes: 1,
            multipart_orphan_grace_seconds: 1,
            lifecycle_backstop_enabled: false,
        };
        (storage, requests, handle, task)
    }

    #[actix_web::test]
    async fn bulk_deletion_reports_partial_per_key_failures() {
        let (storage, requests, handle, task) = partially_failing_s3();
        let keys = [
            "users/test/files/first",
            "users/test/files/denied",
            "users/test/files/second",
        ]
        .map(str::to_owned);

        let results = storage.delete_objects(&keys).await;

        assert!(results[0].is_ok() && results[2].is_ok());
        let failure = results[1].as_ref().unwrap_err().to_string();
        assert!(failure.contains("AccessDenied"), "{failure}");
        assert_eq!(*requests.lock().unwrap(), [keys.to_vec()]);
        handle.stop(true).await;
        task.await.unwrap().unwrap();
    }

    async fn storage_deletion_test_database(owner: &str) -> Database {
        let config = Config::from_env().unwrap();
        let db = Database::create(
            &config.database_url,
            crate::db::DatabasePoolSettings {
                role: crate::db::PoolRole::Maintenance,
                max_size: 2,
                min_size: 1,
                checkout_queue_capacity: 4,
                wait_timeout: Duration::from_secs(2),
                max_lifetime: Duration::from_secs(1800),
                lifetime_jitter: Duration::ZERO,
            },
            Metrics::new(&config),
        )
        .await
        .unwrap();
        clean_storage_deletion_fixtures(&db, owner).await;
        db.execute(
            "INSERT INTO users(id,username,password_hash,role) VALUES($1,$1,'unused','user')",
            &[&owner],
        )
        .await
        .unwrap();
        db
    }

    async fn clean_storage_deletion_fixtures(db: &Database, owner: &str) {
        db.execute(
            "DELETE FROM storage_deletion_jobs WHERE starts_with(object_key, 'users/' || $1 || '/')",
            &[&owner],
        )
        .await
        .unwrap();
        db.execute("DELETE FROM users WHERE id = $1", &[&owner])
            .await
            .unwrap();
    }

    /// Seeds one lane of claimed jobs covering every finalization branch and
    /// returns them with the outcome the provider reported for each.
    async fn seed_storage_deletion_lane(
        db: &Database,
        owner: &str,
        lane: &str,
    ) -> Vec<(StorageDeletionJob, Result<(), StorageError>)> {
        let prefix = format!("users/{owner}/{lane}");
        db.execute(
            "INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type)
             VALUES('fil_' || $1 || '_' || $2, $1, 'migrated', $3 || '/legacy', 0, 'file')",
            &[&owner, &lane, &prefix],
        )
        .await
        .unwrap();
        db.execute(
            "INSERT INTO vault_migrations(node_id,owner_id,legacy_object_key,state)
             VALUES('fil_' || $1 || '_' || $2, $1, $3 || '/migration', 'cleanup_queued')",
            &[&owner, &lane, &prefix],
        )
        .await
        .unwrap();
        db.execute(
            "INSERT INTO vault_uploads(
               id,node_id,owner_id,entry_type,generation_number,generation_id,object_key,
               ciphertext_length,chunk_count,upload_mode,status
             ) VALUES(
               'vup_' || $1 || '_' || $2, 'nod_' || $1 || '_' || $2, $1, 'file', 1,
               decode(md5($3), 'hex'), $3 || '/vault', 1, 1, 'single', 'aborting'
             )",
            &[&owner, &lane, &prefix],
        )
        .await
        .unwrap();
        db.execute(
            "INSERT INTO file_uploads(id,file_id,owner_id,original_name,object_key,size_bytes,upload_mode,status,expires_at)
             SELECT 'upl_' || $1 || '_' || $2 || '_' || scenario, 'fil_future_' || $1 || '_' || $2 || '_' || scenario,
               $1, scenario, $3 || '/' || scenario, 1, 'single', 'aborting', now() + interval '1 hour'
             FROM unnest(ARRAY['done','changed','stale','failed','dead','failed-stale']) AS scenario",
            &[&owner, &lane, &prefix],
        )
        .await
        .unwrap();
        // Upload creation reserves usage in the application, not in a trigger.
        db.execute(
            "UPDATE user_storage_usage
             SET pending_uploads = (
               SELECT count(*) FROM file_uploads WHERE owner_id = $1 AND status = 'aborting'
             ) + (
               SELECT count(*) FROM vault_uploads WHERE owner_id = $1 AND status = 'aborting'
             )
             WHERE owner_id = $1",
            &[&owner],
        )
        .await
        .unwrap();
        // (scenario, current multipart id, attempts, held token, token the worker presents, outcome)
        let scenarios = [
            ("done", None, 0, "ours", "ours", true),
            ("vault", None, 0, "ours", "ours", true),
            ("migration", None, 0, "ours", "ours", true),
            (
                "changed",
                Some("upload-arrived-after-claim"),
                0,
                "ours",
                "ours",
                true,
            ),
            ("stale", None, 0, "theirs", "ours", true),
            ("failed", None, 3, "ours", "ours", false),
            (
                "dead",
                None,
                MAINTENANCE_DEAD_LETTER_ATTEMPTS - 1,
                "ours",
                "ours",
                false,
            ),
            ("failed-stale", None, 0, "theirs", "ours", false),
        ];
        let mut outcomes = Vec::new();
        for (scenario, multipart_upload_id, attempts, held, presented, succeeded) in scenarios {
            let object_key = format!("{prefix}/{scenario}");
            let id: i64 = db
                .query_one(
                    "INSERT INTO storage_deletion_jobs(object_key,multipart_upload_id,attempts,locked_until,lease_token)
                     VALUES($1,$2,$3,now() + interval '5 minutes',$4) RETURNING id",
                    &[&object_key, &multipart_upload_id, &attempts, &format!("{lane}-{held}")],
                )
                .await
                .unwrap()
                .get("id");
            outcomes.push((
                StorageDeletionJob {
                    id,
                    object_key,
                    multipart_upload_id: None,
                    discover_multipart: false,
                    attempts,
                    lease_token: format!("{lane}-{presented}"),
                },
                if succeeded {
                    Ok(())
                } else {
                    Err(storage_message("provider refused the deletion"))
                },
            ));
        }
        outcomes
    }

    type StorageDeletionState = (
        String,
        bool,
        Option<i32>,
        Option<String>,
        Option<bool>,
        Option<bool>,
        Option<bool>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );

    async fn storage_deletion_lane_state(
        db: &Database,
        owner: &str,
        lane: &str,
    ) -> Vec<StorageDeletionState> {
        db.query(
            "SELECT scenario,
               jobs.id IS NOT NULL AS job_exists,
               jobs.attempts,
               replace(jobs.lease_token, $2 || '-', '') AS lease_token,
               jobs.locked_until IS NULL AS unlocked,
               jobs.available_at > now() AS delayed,
               jobs.dead_lettered_at IS NOT NULL AS dead_lettered,
               jobs.last_error,
               file_uploads.status AS file_status,
               vault_uploads.status AS vault_status,
               vault_migrations.state AS migration_state
             FROM unnest(ARRAY['done','vault','migration','changed','stale','failed','dead','failed-stale'])
               AS scenario
             LEFT JOIN storage_deletion_jobs AS jobs
               ON jobs.object_key = 'users/' || $1 || '/' || $2 || '/' || scenario
             LEFT JOIN file_uploads
               ON file_uploads.object_key = 'users/' || $1 || '/' || $2 || '/' || scenario
             LEFT JOIN vault_uploads
               ON vault_uploads.object_key = 'users/' || $1 || '/' || $2 || '/' || scenario
             LEFT JOIN vault_migrations
               ON vault_migrations.legacy_object_key = 'users/' || $1 || '/' || $2 || '/' || scenario
             ORDER BY scenario",
            &[&owner, &lane],
        )
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.get(0),
                row.get(1),
                row.get(2),
                row.get(3),
                row.get(4),
                row.get(5),
                row.get(6),
                row.get(7),
                row.get(8),
                row.get(9),
                row.get(10),
            )
        })
        .collect()
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn batched_storage_deletion_finalization_matches_per_object_finalization() {
        let owner = "usr_deletion_batch_equivalence";
        let db = storage_deletion_test_database(owner).await;
        let per_object = seed_storage_deletion_lane(&db, owner, "per-object").await;
        let batched = seed_storage_deletion_lane(&db, owner, "batched").await;

        for (job, outcome) in per_object {
            finish_storage_deletion_job(&db, job, outcome)
                .await
                .unwrap();
        }
        finish_storage_deletion_batch(&db, batched).await.unwrap();

        let expected = storage_deletion_lane_state(&db, owner, "per-object").await;
        let actual = storage_deletion_lane_state(&db, owner, "batched").await;
        assert_eq!(actual, expected);

        let by_scenario = actual
            .iter()
            .map(|state| (state.0.as_str(), state))
            .collect::<HashMap<_, _>>();
        for finished in ["done", "vault", "migration"] {
            assert!(!by_scenario[finished].1, "{finished} job should be deleted");
        }
        assert_eq!(by_scenario["done"].8.as_deref(), Some("aborted"));
        assert_eq!(by_scenario["vault"].9.as_deref(), Some("aborted"));
        assert_eq!(by_scenario["migration"].10.as_deref(), Some("complete"));
        let changed = by_scenario["changed"];
        assert!(changed.1 && changed.3.is_none() && changed.4 == Some(true));
        assert_eq!(changed.8.as_deref(), Some("aborting"));
        let failed = by_scenario["failed"];
        assert_eq!(
            (failed.2, failed.3.as_deref(), failed.5, failed.6),
            (Some(4), None, Some(true), Some(false))
        );
        assert_eq!(failed.7.as_deref(), Some("provider refused the deletion"));
        assert_eq!(by_scenario["dead"].6, Some(true));

        clean_storage_deletion_fixtures(&db, owner).await;
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn batched_storage_deletion_never_finalizes_a_stale_lease() {
        let owner = "usr_deletion_batch_fencing";
        let db = storage_deletion_test_database(owner).await;
        let outcomes = seed_storage_deletion_lane(&db, owner, "fenced").await;
        let before = storage_deletion_lane_state(&db, owner, "fenced").await;
        // Another worker re-claimed every job after our lease expired.
        db.execute(
            "UPDATE storage_deletion_jobs SET lease_token = 'fenced-theirs'
             WHERE starts_with(object_key, 'users/' || $1 || '/fenced/')",
            &[&owner],
        )
        .await
        .unwrap();

        finish_storage_deletion_batch(&db, outcomes).await.unwrap();

        let after = storage_deletion_lane_state(&db, owner, "fenced").await;
        assert_eq!(after.len(), before.len());
        for (before, after) in before.iter().zip(&after) {
            assert_eq!(after.3.as_deref(), Some("theirs"), "{}", after.0);
            assert_eq!(
                (
                    &after.0, after.1, after.2, after.4, after.5, after.6, &after.7
                ),
                (
                    &before.0, before.1, before.2, before.4, before.5, before.6, &before.7
                ),
            );
            assert_eq!(
                (&after.8, &after.9, &after.10),
                (&before.8, &before.9, &before.10)
            );
        }

        clean_storage_deletion_fixtures(&db, owner).await;
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn deletion_worker_bulk_deletes_and_records_partial_provider_failures() {
        let owner = "usr_deletion_batch_worker";
        let db = storage_deletion_test_database(owner).await;
        let (storage, requests, handle, task) = partially_failing_s3();
        let prefix = format!("users/{owner}/files");
        db.execute(
            "INSERT INTO storage_deletion_jobs(object_key, multipart_upload_id)
             SELECT $1 || '/' || name, CASE WHEN name = 'multipart' THEN 'upload-1' END
             FROM unnest(ARRAY['first','denied','second','multipart']) AS name",
            &[&prefix],
        )
        .await
        .unwrap();

        while process_deletion_jobs(&db, &storage, 4).await.unwrap() {}

        let remaining = db
            .query(
                "SELECT object_key, attempts, lease_token IS NULL AS released, last_error
                 FROM storage_deletion_jobs WHERE starts_with(object_key, $1) ORDER BY object_key",
                &[&prefix],
            )
            .await
            .unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(
            remaining[0].get::<_, String>("object_key"),
            format!("{prefix}/denied")
        );
        assert_eq!(remaining[0].get::<_, i32>("attempts"), 1);
        assert!(remaining[0].get::<_, bool>("released"));
        assert!(
            remaining[0]
                .get::<_, String>("last_error")
                .contains("AccessDenied")
        );
        let bulk_keys = requests.lock().unwrap().concat();
        assert!(!bulk_keys.iter().any(|key| key.ends_with("/multipart")));
        for name in ["first", "denied", "second"] {
            assert!(bulk_keys.contains(&format!("{prefix}/{name}")));
        }

        clean_storage_deletion_fixtures(&db, owner).await;
        handle.stop(true).await;
        task.await.unwrap().unwrap();
    }

    #[actix_web::test]
    #[ignore = "requires a PostgreSQL test database"]
    async fn trash_expiry_executes_leaf_first_and_queues_file_objects() {
        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
        let (mut client, connection) = tokio_postgres::connect(&database_url, NoTls)
            .await
            .expect("postgres should be available");
        tokio::spawn(async move {
            connection
                .await
                .expect("postgres connection should remain healthy");
        });
        let transaction = client
            .transaction()
            .await
            .expect("transaction should begin");
        transaction
            .batch_execute(
                "INSERT INTO users (id, username, password_hash, role, trash_retention_minutes)
                 VALUES ('usr_trash_expiry', 'trash_expiry_integration', 'test-only', 'user', 1);
                 INSERT INTO files (
                   id, owner_id, original_name, storage_name, size_bytes,
                   entry_type, state, trashed_at, parent_id
                 ) VALUES
                   ('fil_expiry_folder', 'usr_trash_expiry', 'folder', 'expiry-folder', 0,
                    'folder', 'trashed', now() - interval '61 seconds', NULL),
                   ('fil_expiry_file', 'usr_trash_expiry', 'file', 'expiry-object', 1,
                    'file', 'trashed', now() - interval '61 seconds', 'fil_expiry_folder'),
                   ('fil_expiry_fresh', 'usr_trash_expiry', 'fresh', 'expiry-fresh', 1,
                    'file', 'trashed', now() - interval '30 seconds', NULL),
                   ('fil_expiry_restored', 'usr_trash_expiry', 'restored', 'expiry-restored', 1,
                    'file', 'active', now() - interval '61 seconds', NULL);",
            )
            .await
            .expect("trash expiry fixtures should initialize");

        let first: i64 = transaction
            .query_one(EXPIRE_TRASH_BATCH_QUERY, &[&TRASH_EXPIRY_BATCH_SIZE])
            .await
            .expect("expired leaf should delete")
            .get("deleted");
        let second: i64 = transaction
            .query_one(EXPIRE_TRASH_BATCH_QUERY, &[&TRASH_EXPIRY_BATCH_SIZE])
            .await
            .expect("newly empty parent should delete")
            .get("deleted");
        let remaining: i64 = transaction
            .query_one(
                "SELECT count(*)::bigint AS count FROM files WHERE owner_id = 'usr_trash_expiry'",
                &[],
            )
            .await
            .expect("remaining files should count")
            .get("count");
        let queued: i64 = transaction
            .query_one(
                "SELECT count(*)::bigint AS count FROM storage_deletion_jobs WHERE object_key = 'usr_trash_expiry/expiry-object'",
                &[],
            )
            .await
            .expect("queued objects should count")
            .get("count");

        assert_eq!((first, second, remaining, queued), (1, 1, 2, 1));
        transaction
            .rollback()
            .await
            .expect("fixtures should roll back");
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
            "#[cfg(test)]\n#[derive(Default)]\nstruct ReconciliationFailures",
        );
        assert!(sweep.contains("prepare_multipart_orphan_group("));
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

    #[actix_web::test]
    async fn maintenance_provider_budget_caps_overlapping_workers_and_nested_aborts() {
        use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = (Arc::clone(&active), Arc::clone(&peak), Arc::clone(&calls));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = HttpServer::new(move || {
            let observed = observed.clone();
            App::new().default_service(web::to(move |request: HttpRequest| {
                let (active, peak, calls) = observed.clone();
                async move {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    calls.fetch_add(1, Ordering::SeqCst);
                    sleep(Duration::from_millis(15)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    if request.query_string().contains("uploads") {
                        let entries = (1..=8).map(|id| format!(
                            "<Upload><Key>users/test/files/object</Key><UploadId>upload-{id}</UploadId><Initiated>2020-01-01T00:00:00Z</Initiated></Upload>"
                        )).collect::<String>();
                        HttpResponse::Ok().content_type("application/xml").body(format!(
                            "<ListMultipartUploadsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Bucket>test</Bucket><IsTruncated>false</IsTruncated>{entries}</ListMultipartUploadsResult>"
                        ))
                    } else if request.method() == actix_web::http::Method::HEAD {
                        HttpResponse::Ok().insert_header(("content-length", "1")).finish()
                    } else if request.query_string().contains("delete") {
                        HttpResponse::Ok().content_type("application/xml").body(
                            "<DeleteResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"/>"
                        )
                    } else {
                        HttpResponse::NoContent().finish()
                    }
                }
            }))
        }).workers(1).listen(listener).unwrap().run();
        let handle = server.handle();
        let task = actix_web::rt::spawn(server);
        let client = aws_sdk_s3::Client::from_conf(
            aws_sdk_s3::config::Builder::new()
                .behavior_version_latest()
                .region(Region::new("us-east-1"))
                .credentials_provider(Credentials::new("test", "test", None, None, "test"))
                .endpoint_url(endpoint.clone())
                .force_path_style(true)
                .build(),
        );
        let config = Config::from_env().unwrap();
        let metrics = Metrics::new(&config);
        let storage = Storage::S3 {
            client: client.clone(),
            maintenance_client: client,
            maintenance_budget: Arc::new(Semaphore::new(3)),
            namespace: endpoint,
            metrics: metrics.clone(),
            bucket: "test".to_owned(),
            legacy_root: PathBuf::new(),
            presign_seconds: 60,
            multipart_threshold_bytes: 1,
            multipart_part_bytes: 1,
            multipart_orphan_grace_seconds: 1,
            lifecycle_backstop_enabled: false,
        };
        let objects = vec!["users/test/files/object".to_owned()];
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            futures_util::join!(
                storage.abort_multipart_uploads_for_key(&objects[0]),
                storage.abort_multipart_uploads_for_key(&objects[0]),
                storage.delete_object(&objects[0]),
                storage.delete_objects(&objects),
                storage.maintenance_object_metadata(&objects[0]),
            )
        })
        .await
        .expect("nested admission must not deadlock");
        result.0.unwrap();
        result.1.unwrap();
        result.2.unwrap();
        assert!(result.3.into_iter().all(|outcome| outcome.is_ok()));
        result.4.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 21);
        assert_eq!(peak.load(Ordering::SeqCst), 3);
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert!(
            metrics
                .render(&[])
                .contains("aeralyth_maintenance_provider_in_flight 0")
        );
        handle.stop(true).await;
        task.await.unwrap().unwrap();
    }

    #[actix_web::test]
    async fn slow_multipart_listing_releases_the_only_maintenance_connection() {
        use actix_web::{App, HttpResponse, HttpServer, web};
        if std::env::var("AERALYTH_DATABASE_INTEGRATION_TESTS").as_deref() != Ok("1") {
            return;
        }
        let config = Config::from_env().unwrap();
        let metrics = Metrics::new(&config);
        let db = Database::create(
            &config.database_url,
            crate::db::DatabasePoolSettings {
                role: crate::db::PoolRole::Maintenance,
                max_size: 1,
                min_size: 1,
                checkout_queue_capacity: 4,
                wait_timeout: Duration::from_secs(2),
                max_lifetime: Duration::from_secs(1800),
                lifetime_jitter: Duration::ZERO,
            },
            metrics.clone(),
        )
        .await
        .unwrap();
        let listing_started = Arc::new(tokio::sync::Notify::new());
        let release_listing = Arc::new(tokio::sync::Notify::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = (
            Arc::clone(&listing_started),
            Arc::clone(&release_listing),
            Arc::clone(&calls),
        );
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = HttpServer::new(move || {
            let observed = observed.clone();
            App::new().default_service(web::to(move || {
                let (started, release, calls) = observed.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    started.notify_one();
                    release.notified().await;
                    HttpResponse::Ok().content_type("application/xml").body(
                        "<ListMultipartUploadsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Bucket>test</Bucket><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>"
                    )
                }
            }))
        }).workers(1).listen(listener).unwrap().run();
        let handle = server.handle();
        let server_task = actix_web::rt::spawn(server);
        let client = aws_sdk_s3::Client::from_conf(
            aws_sdk_s3::config::Builder::new()
                .behavior_version_latest()
                .region(Region::new("us-east-1"))
                .credentials_provider(Credentials::new("test", "test", None, None, "test"))
                .endpoint_url(endpoint.clone())
                .force_path_style(true)
                .build(),
        );
        let storage = Storage::S3 {
            client: client.clone(),
            maintenance_client: client,
            maintenance_budget: Arc::new(Semaphore::new(2)),
            namespace: endpoint.clone(),
            metrics: metrics.clone(),
            bucket: "test".to_owned(),
            legacy_root: PathBuf::new(),
            presign_seconds: 60,
            multipart_threshold_bytes: 1,
            multipart_part_bytes: 1,
            multipart_orphan_grace_seconds: 1,
            lifecycle_backstop_enabled: false,
        };
        let operation = {
            let db = db.clone();
            let storage = storage.clone();
            let metrics = metrics.clone();
            actix_web::rt::spawn(async move {
                reconcile_orphaned_multipart_uploads(&db, &storage, &metrics, 2).await
            })
        };
        tokio::time::timeout(Duration::from_secs(2), listing_started.notified())
            .await
            .unwrap();
        let maintenance_read =
            tokio::time::timeout(Duration::from_millis(250), db.query_one("SELECT 1", &[])).await;
        release_listing.notify_one();
        assert_eq!(
            maintenance_read
                .expect("listing must not pin the only maintenance connection")
                .unwrap()
                .get::<_, i32>(0),
            1
        );
        operation.await.unwrap().unwrap();
        assert!(
            !reconcile_orphaned_multipart_uploads(&db, &storage, &metrics, 2)
                .await
                .unwrap()
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "another replica must respect the shared full-scan deadline"
        );
        db.execute(
            "DELETE FROM multipart_reconciliation_progress WHERE namespace=$1",
            &[&endpoint],
        )
        .await
        .unwrap();
        handle.stop(true).await;
        server_task.await.unwrap().unwrap();
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
