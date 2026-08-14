use std::collections::HashMap;
use std::error::Error as StdError;
use std::fmt;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aws_config::BehaviorVersion;
use aws_credential_types::Credentials;
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::types::{ChecksumAlgorithm, ChecksumMode, CompletedMultipartUpload, CompletedPart};
use aws_types::region::Region;
use futures_util::future::{Either, select};
use serde::Serialize;
use tokio::sync::watch;
use tokio::task::JoinSet;
use tokio::time::{Instant, MissedTickBehavior, interval_at, sleep};

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
const STORAGE_OBJECT_PREFIX: &str = "users/";
const USER_DELETION_BATCH_SIZE: i64 = 500;
const USER_DELETION_BATCHES_PER_TICK: usize = 32;
const SESSION_EXPIRY_BATCH_SIZE: i64 = 1_000;
const SESSION_EXPIRY_BATCHES_PER_TICK: usize = 4;
const MAINTENANCE_RESTART_DELAY: Duration = Duration::from_secs(1);
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
    MultipartReconciliation,
    CounterReconciliation,
}

#[derive(Clone, Copy, Debug)]
struct MaintenanceSchedule {
    worker: MaintenanceWorker,
    initial_delay: Duration,
    interval: Duration,
}

const MAINTENANCE_SCHEDULES: &[MaintenanceSchedule] = &[
    MaintenanceSchedule {
        worker: MaintenanceWorker::UserDeletion,
        initial_delay: Duration::from_secs(0),
        interval: Duration::from_secs(10),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::StorageDeletion,
        initial_delay: Duration::from_secs(1),
        interval: Duration::from_secs(10),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::UploadFinalization,
        initial_delay: Duration::from_secs(0),
        interval: Duration::from_secs(1),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::LegacyUploadExpiry,
        initial_delay: Duration::from_secs(2),
        interval: Duration::from_secs(10),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::VaultUploadExpiry,
        initial_delay: Duration::from_secs(3),
        interval: Duration::from_secs(10),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::InvitationExpiry,
        initial_delay: Duration::from_secs(4),
        interval: Duration::from_secs(10),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::SessionExpiry,
        initial_delay: Duration::from_secs(5),
        interval: Duration::from_secs(10),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::MultipartReconciliation,
        initial_delay: Duration::from_secs(0),
        interval: Duration::from_secs(60 * 60),
    },
    MaintenanceSchedule {
        worker: MaintenanceWorker::CounterReconciliation,
        initial_delay: Duration::from_secs(5),
        interval: Duration::from_secs(60 * 60),
    },
];

#[derive(Clone)]
pub enum Storage {
    Local {
        root: PathBuf,
    },
    S3 {
        client: aws_sdk_s3::Client,
        bucket: String,
        legacy_root: PathBuf,
        presign_seconds: u64,
        multipart_threshold_bytes: u64,
        multipart_part_bytes: u64,
        multipart_orphan_grace_seconds: u64,
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
    pub async fn create(config: &Config) -> Result<Self, StorageError> {
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
            .endpoint_url(endpoint)
            .force_path_style(config.s3_force_path_style)
            .build();

        Ok(Self::S3 {
            client: aws_sdk_s3::Client::from_conf(s3_config),
            bucket,
            legacy_root: PathBuf::from(&config.storage_path),
            presign_seconds: config.storage_presign_seconds,
            multipart_threshold_bytes: config.storage_multipart_threshold_bytes,
            multipart_part_bytes: config.storage_multipart_part_bytes,
            multipart_orphan_grace_seconds: config.storage_multipart_orphan_grace_seconds,
        })
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
        let Self::S3 { client, bucket, .. } = self else {
            return Ok(MultipartUploadPage {
                uploads: Vec::new(),
                next_key_marker: None,
                next_upload_id_marker: None,
            });
        };
        let output = client
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
        let Self::S3 { client, bucket, .. } = self else {
            return Ok(());
        };

        let result = client
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
            Self::S3 { client, bucket, .. } => {
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
                client,
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

                client
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
}

pub async fn run_maintenance(
    db: Database,
    storage: Storage,
    metrics: Metrics,
    shutdown: watch::Receiver<bool>,
) {
    let mut supervisors = JoinSet::new();
    for schedule in MAINTENANCE_SCHEDULES.iter().copied() {
        supervisors.spawn(supervise_maintenance_worker(
            schedule,
            db.clone(),
            storage.clone(),
            metrics.clone(),
            shutdown.clone(),
        ));
    }

    while let Some(result) = supervisors.join_next().await {
        if let Err(error) = result {
            log::error!("maintenance supervisor stopped unexpectedly: {error}");
        }
    }
}

async fn supervise_maintenance_worker(
    schedule: MaintenanceSchedule,
    db: Database,
    storage: Storage,
    metrics: Metrics,
    shutdown: watch::Receiver<bool>,
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
) {
    run_periodic_task(
        schedule.initial_delay,
        schedule.interval,
        shutdown,
        move || {
            let db = db.clone();
            let storage = storage.clone();
            let metrics = metrics.clone();
            async move {
                let started = Instant::now();
                let outcome = schedule.worker.run(&db, &storage).await;
                metrics.record_maintenance(
                    schedule.worker.label(),
                    started.elapsed(),
                    outcome.is_ok(),
                );
                if let Err(error) = outcome {
                    log::error!(
                        "{} maintenance worker failed: {error}",
                        schedule.worker.label()
                    );
                }
            }
        },
    )
    .await;
}

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
            Self::MultipartReconciliation => "multipart reconciliation",
            Self::CounterReconciliation => "counter reconciliation",
        }
    }

    async fn run(
        self,
        db: &Database,
        storage: &Storage,
    ) -> Result<(), Box<dyn StdError + Send + Sync>> {
        match self {
            Self::UserDeletion => process_user_deletion_jobs(db).await,
            Self::StorageDeletion => process_deletion_jobs(db, storage).await,
            Self::UploadFinalization => reconcile_file_upload_completions(db, storage).await,
            Self::LegacyUploadExpiry => expire_abandoned_uploads(db, storage).await,
            Self::VaultUploadExpiry => expire_abandoned_vault_uploads(db, storage).await,
            Self::InvitationExpiry => expire_invitations_batch(db).await,
            Self::SessionExpiry => expire_sessions_batches(db).await,
            Self::MultipartReconciliation => {
                reconcile_orphaned_multipart_uploads(db, storage).await
            }
            Self::CounterReconciliation => reconcile_counters(db).await,
        }
    }
}

async fn process_user_deletion_jobs(db: &Database) -> Result<(), Box<dyn StdError + Send + Sync>> {
    for _ in 0..USER_DELETION_BATCHES_PER_TICK {
        let claimed = db
            .query_opt(
                "
                    WITH candidate AS (
                      SELECT user_id
                      FROM user_deletion_jobs
                      WHERE available_at <= now()
                        AND (locked_until IS NULL OR locked_until < now())
                      ORDER BY created_at, user_id
                      LIMIT 1
                      FOR UPDATE SKIP LOCKED
                    )
                    UPDATE user_deletion_jobs AS jobs
                    SET locked_until = now() + interval '2 minutes',
                        updated_at = now()
                    FROM candidate
                    WHERE jobs.user_id = candidate.user_id
                    RETURNING jobs.user_id, jobs.phase
                ",
                &[],
            )
            .await?;
        let Some(claimed) = claimed else {
            break;
        };
        let user_id: String = claimed.get("user_id");
        let phase: String = claimed.get("phase");

        if let Err(error) = process_user_deletion_batch(db, &user_id, &phase).await {
            let error_message = error.to_string().chars().take(500).collect::<String>();
            let attempts = db
                .query_opt(
                    "SELECT attempts FROM user_deletion_jobs WHERE user_id = $1",
                    &[&user_id],
                )
                .await?
                .map(|row| row.get::<_, i32>("attempts"))
                .unwrap_or_default();
            let delay_seconds = retry_delay_seconds(attempts);
            db.execute(
                "
                    UPDATE user_deletion_jobs
                    SET attempts = attempts + 1,
                        available_at = now() + ($2::bigint * interval '1 second'),
                        locked_until = NULL,
                        last_error = $3,
                        updated_at = now()
                    WHERE user_id = $1
                ",
                &[&user_id, &delay_seconds, &error_message],
            )
            .await?;
            return Err(error);
        }
    }

    Ok(())
}

async fn process_user_deletion_batch(
    db: &Database,
    user_id: &str,
    claimed_phase: &str,
) -> Result<(), Box<dyn StdError + Send + Sync>> {
    let mut client = db.get().await?;
    let transaction = client.transaction().await?;
    let Some(job) = transaction
        .query_opt(
            "SELECT phase FROM user_deletion_jobs WHERE user_id = $1 FOR UPDATE",
            &[&user_id],
        )
        .await?
    else {
        transaction.commit().await?;
        return Ok(());
    };
    let phase: String = job.get("phase");
    if phase != claimed_phase {
        transaction
            .execute(
                "UPDATE user_deletion_jobs SET locked_until = NULL WHERE user_id = $1",
                &[&user_id],
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
                    "UPDATE user_deletion_jobs SET phase = 'file_uploads', locked_until = NULL, updated_at = now() WHERE user_id = $1",
                    &[&user_id],
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
                    last_error = NULL,
                    updated_at = now()
                WHERE user_id = $1
            ",
            &[&user_id, &next_phase, &affected],
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

async fn expire_abandoned_vault_uploads(
    db: &Database,
    storage: &Storage,
) -> Result<(), Box<dyn StdError + Send + Sync>> {
    let uploads = db
        .query(
            "
                WITH claimed AS (
                  SELECT id
                  FROM vault_uploads
                  WHERE status IN ('initializing', 'pending', 'completing', 'aborting')
                    AND expires_at <= now()
                  ORDER BY expires_at
                  LIMIT 25
                  FOR UPDATE SKIP LOCKED
                )
                UPDATE vault_uploads AS uploads
                SET status = 'aborting', expires_at = now() + interval '5 minutes'
                FROM claimed
                WHERE uploads.id = claimed.id
                RETURNING uploads.id, uploads.object_key,
                          uploads.multipart_upload_id, uploads.write_expires_at
            ",
            &[],
        )
        .await?;

    for upload in uploads {
        let id: String = upload.get("id");
        let object_key: Option<String> = upload.get("object_key");
        let multipart_upload_id: Option<String> = upload.get("multipart_upload_id");
        let write_expires_at: Option<SystemTime> = upload.get("write_expires_at");

        if write_expires_at.is_some_and(|expires_at| expires_at > SystemTime::now()) {
            db.execute(
                "UPDATE vault_uploads SET expires_at = write_expires_at WHERE id = $1 AND status = 'aborting'",
                &[&id],
            )
            .await?;
            continue;
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
    }

    Ok(())
}

async fn reconcile_orphaned_multipart_uploads(
    db: &Database,
    storage: &Storage,
) -> Result<(), Box<dyn StdError + Send + Sync>> {
    let Some(grace_seconds) = storage.multipart_orphan_grace_seconds() else {
        return Ok(());
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
        return Ok(());
    }

    let sweep_result = sweep_orphaned_multipart_uploads(&client, storage, grace_seconds).await;
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

    sweep_result
}

async fn sweep_orphaned_multipart_uploads(
    client: &deadpool_postgres::Client,
    storage: &Storage,
    grace_seconds: u64,
) -> Result<(), Box<dyn StdError + Send + Sync>> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let cutoff = now.saturating_sub(grace_seconds);
    let cutoff = i64::try_from(cutoff).unwrap_or(i64::MAX);
    let mut key_marker: Option<String> = None;
    let mut upload_id_marker: Option<String> = None;

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
                        "UPDATE vault_uploads SET multipart_upload_id = $1, status = 'pending', expires_at = now() + interval '24 hours' WHERE object_key = $2 AND status = 'initializing' AND multipart_upload_id IS NULL AND expires_at > now()"
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

            storage
                .abort_multipart(&upload.object_key, &upload.upload_id)
                .await?;
            log::warn!(
                "aborted orphaned multipart upload {} for {}",
                upload.upload_id,
                upload.object_key
            );
        }

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

    Ok(())
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

async fn process_deletion_jobs(
    db: &Database,
    storage: &Storage,
) -> Result<(), Box<dyn StdError + Send + Sync>> {
    let jobs = db
        .query(
            "
                WITH claimed AS (
                  SELECT id
                  FROM storage_deletion_jobs
                  WHERE available_at <= now()
                    AND (locked_until IS NULL OR locked_until < now())
                  ORDER BY id
                  LIMIT 25
                  FOR UPDATE SKIP LOCKED
                )
                UPDATE storage_deletion_jobs AS jobs
                SET locked_until = now() + interval '2 minutes'
                FROM claimed
                WHERE jobs.id = claimed.id
                RETURNING
                  jobs.id,
                  jobs.object_key,
                  jobs.multipart_upload_id,
                  jobs.attempts
            ",
            &[],
        )
        .await?;

    for job in jobs {
        let id: i64 = job.get("id");
        let object_key: String = job.get("object_key");
        let multipart_upload_id: Option<String> = job.get("multipart_upload_id");
        let attempts: i32 = job.get("attempts");

        let deletion_result = async {
            if let Some(multipart_upload_id) = multipart_upload_id.as_deref() {
                storage
                    .abort_multipart(&object_key, multipart_upload_id)
                    .await?;
            }
            storage.delete_object(&object_key).await
        }
        .await;

        match deletion_result {
            Ok(()) => {
                let mut client = db.get().await?;
                let transaction = client.transaction().await?;
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
                    .execute(
                        "
                            UPDATE vault_migrations
                            SET state = 'complete', updated_at = now()
                            WHERE legacy_object_key = $1 AND state = 'cleanup_queued'
                        ",
                        &[&object_key],
                    )
                    .await?;
                transaction
                    .execute("DELETE FROM storage_deletion_jobs WHERE id = $1", &[&id])
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
                            available_at = now() + ($2::bigint * interval '1 second'),
                            locked_until = NULL,
                            last_error = $3
                        WHERE id = $1
                    ",
                    &[&id, &delay_seconds, &error_message],
                )
                .await?;
            }
        }
    }

    Ok(())
}

async fn reconcile_file_upload_completions(
    db: &Database,
    storage: &Storage,
) -> Result<(), Box<dyn StdError + Send + Sync>> {
    let uploads = claim_file_upload_completions(db, 25).await?;

    for upload in uploads {
        let metadata = match storage.object_metadata(&upload.object_key).await {
            Ok(metadata) => metadata,
            Err(error) if error.is_not_found() && upload.expires_at <= SystemTime::now() => {
                transition_file_upload_to_cleanup(
                    db,
                    &upload.id,
                    &upload.owner_id,
                    &upload.object_key,
                    upload.multipart_upload_id.as_deref(),
                    &["completing"],
                )
                .await?;
                continue;
            }
            Err(error) => {
                let delay = completion_retry_delay_seconds(upload.completion_attempts, &upload.id);
                log::warn!(
                    "upload completion {} will retry in {delay}s: {error}",
                    upload.id
                );
                defer_file_upload_completion(
                    db,
                    &upload.id,
                    &upload.owner_id,
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
                )
                .await?;
            }
            Err(error) => {
                let delay = completion_retry_delay_seconds(upload.completion_attempts, &upload.id);
                log::warn!(
                    "upload completion {} database finalization will retry in {delay}s: {error}",
                    upload.id
                );
                defer_file_upload_completion(
                    db,
                    &upload.id,
                    &upload.owner_id,
                    &error.to_string(),
                    delay,
                )
                .await?;
            }
        }
    }

    Ok(())
}

async fn expire_abandoned_uploads(
    db: &Database,
    _storage: &Storage,
) -> Result<(), Box<dyn StdError + Send + Sync>> {
    let uploads = db
        .query(
            "
                WITH claimed AS (
                  SELECT id
                  FROM file_uploads
                  WHERE status IN ('initializing', 'pending', 'aborting')
                    AND expires_at <= now()
                  ORDER BY expires_at
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
            ",
            &[],
        )
        .await?;

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

    Ok(())
}

async fn expire_invitations_batch(db: &Database) -> Result<(), Box<dyn StdError + Send + Sync>> {
    db.execute(
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

    Ok(())
}

async fn expire_sessions_batches(db: &Database) -> Result<(), Box<dyn StdError + Send + Sync>> {
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

        if deleted < SESSION_EXPIRY_BATCH_SIZE as u64 {
            break;
        }
    }

    Ok(())
}

fn retry_delay_seconds(attempts: i32) -> i64 {
    let exponent = u32::try_from(attempts.clamp(0, 8)).unwrap_or(0);
    i64::from(2_i32.pow(exponent)).min(300)
}

async fn reconcile_counters(db: &Database) -> Result<(), Box<dyn StdError + Send + Sync>> {
    db.execute(
        "
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
              users.id,
              count(files.id) FILTER (
                WHERE files.state = 'active' AND files.entry_type = 'file'
              ),
              count(files.id) FILTER (
                WHERE files.state = 'active' AND files.entry_type = 'folder'
              ),
              count(files.id) FILTER (
                WHERE files.state = 'active' AND files.entry_type = 'file'
              ),
              count(files.id) FILTER (
                WHERE files.state = 'trashed' AND files.entry_type = 'file'
              ),
              count(files.id) FILTER (
                WHERE files.state = 'active' AND files.favorite
              ),
              (
                SELECT count(*)
                FROM file_shares
                WHERE file_shares.recipient_id = users.id
                  AND file_shares.counts_toward_shared
              ),
              COALESCE(sum(files.size_bytes) FILTER (
                WHERE files.entry_type = 'file'
              ), 0)::bigint,
              now()
            FROM users
            LEFT JOIN files ON files.owner_id = users.id
            GROUP BY users.id
            ON CONFLICT (owner_id) DO UPDATE SET
              total_files = EXCLUDED.total_files,
              total_folders = EXCLUDED.total_folders,
              active_files = EXCLUDED.active_files,
              trashed_files = EXCLUDED.trashed_files,
              favorite_files = EXCLUDED.favorite_files,
              shared_files = EXCLUDED.shared_files,
              used_bytes = EXCLUDED.used_bytes,
              updated_at = now()
        ",
        &[],
    )
    .await?;
    db.execute(
        "
            UPDATE admin_directory_counters
            SET total_users = (SELECT count(*) FROM users WHERE status <> 'deleting'),
                active_users = (
                  SELECT count(*) FROM users WHERE status = 'active'
                ),
                active_admins = (
                  SELECT count(*)
                  FROM users
                  WHERE status = 'active' AND role = 'admin'
                ),
                pending_invitations = (
                  SELECT count(*) FROM invitations WHERE status = 'pending'
                ),
                updated_at = now()
            WHERE singleton = TRUE
        ",
        &[],
    )
    .await?;

    Ok(())
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

    use super::*;

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
