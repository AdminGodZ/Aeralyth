use std::collections::HashMap;
use std::error::Error as StdError;
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aws_config::BehaviorVersion;
use aws_credential_types::Credentials;
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::types::{ChecksumAlgorithm, ChecksumMode, CompletedMultipartUpload, CompletedPart};
use aws_types::region::Region;
use serde::Serialize;
use tokio::time::{MissedTickBehavior, interval};

use crate::config::Config;
use crate::db::Database;
use crate::e2ee::UPLOAD_PART_BYTES;

const MULTIPART_RECONCILIATION_LOCK_ID: i64 = 4_133_797_884_291_001;
const STORAGE_OBJECT_PREFIX: &str = "users/";

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

        if size_bytes >= UPLOAD_PART_BYTES {
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

    pub async fn complete_multipart(
        &self,
        object_key: &str,
        multipart_upload_id: &str,
        parts: &[UploadedPart],
    ) -> Result<(), StorageError> {
        let Self::S3 { client, bucket, .. } = self else {
            return Ok(());
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

        client
            .complete_multipart_upload()
            .bucket(bucket)
            .key(object_key)
            .upload_id(multipart_upload_id)
            .multipart_upload(multipart)
            .send()
            .await
            .map_err(storage_error)?;

        Ok(())
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

pub async fn run_maintenance(db: Database, storage: Storage) {
    let mut maintenance_interval = interval(Duration::from_secs(10));
    maintenance_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut reconciliation_ticks = 359_u16;

    loop {
        maintenance_interval.tick().await;

        if let Err(error) = process_deletion_jobs(&db, &storage).await {
            log::error!("storage deletion worker failed: {error}");
        }
        if let Err(error) = expire_abandoned_uploads(&db, &storage).await {
            log::error!("abandoned upload cleanup failed: {error}");
        }
        if let Err(error) = expire_abandoned_vault_uploads(&db, &storage).await {
            log::error!("abandoned encrypted upload cleanup failed: {error}");
        }
        if let Err(error) = expire_invitations_batch(&db).await {
            log::error!("invitation expiry worker failed: {error}");
        }

        reconciliation_ticks = reconciliation_ticks.saturating_add(1);
        if reconciliation_ticks >= 360 {
            reconciliation_ticks = 0;
            if let Err(error) = reconcile_orphaned_multipart_uploads(&db, &storage).await {
                log::error!("multipart upload reconciliation failed: {error}");
            }
            if let Err(error) = reconcile_counters(&db).await {
                log::error!("counter reconciliation failed: {error}");
            }
        }
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
                    "SELECT object_key, status, multipart_upload_id FROM file_uploads WHERE object_key = ANY($1)",
                    &[&object_keys],
                )
                .await?
        };
        let intents = intent_rows
            .into_iter()
            .map(|row| {
                (
                    row.get::<_, String>("object_key"),
                    (
                        row.get::<_, String>("status"),
                        row.get::<_, Option<String>>("multipart_upload_id"),
                    ),
                )
            })
            .collect::<HashMap<_, _>>();

        for upload in page.uploads {
            if upload.initiated_epoch_seconds > cutoff {
                continue;
            }

            if let Some((status, Some(known_upload_id))) = intents.get(&upload.object_key)
                && matches!(status.as_str(), "pending" | "completing" | "aborting")
                && known_upload_id == &upload.upload_id
            {
                continue;
            }

            if matches!(
                intents.get(&upload.object_key),
                Some((status, None)) if status == "initializing"
            ) {
                let adopted = client
                    .execute(
                        "UPDATE file_uploads SET multipart_upload_id = $1, status = 'pending', expires_at = now() + interval '24 hours' WHERE object_key = $2 AND status = 'initializing' AND multipart_upload_id IS NULL",
                        &[&upload.upload_id, &upload.object_key],
                    )
                    .await?;

                if adopted == 1 {
                    log::warn!(
                        "adopted multipart upload {} for durable intent {}",
                        upload.upload_id,
                        upload.object_key
                    );
                    continue;
                }

                let known_after_race = client
                    .query_opt(
                        "SELECT 1 FROM file_uploads WHERE object_key = $1 AND multipart_upload_id = $2 AND status IN ('pending', 'completing', 'aborting') LIMIT 1",
                        &[&upload.object_key, &upload.upload_id],
                    )
                    .await?
                    .is_some();

                if known_after_race {
                    continue;
                }
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

async fn expire_abandoned_uploads(
    db: &Database,
    storage: &Storage,
) -> Result<(), Box<dyn StdError + Send + Sync>> {
    let uploads = db
        .query(
            "
                WITH claimed AS (
                  SELECT id
                  FROM file_uploads
                  WHERE status IN ('initializing', 'pending', 'completing', 'aborting')
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
        let status: String = upload.get("status");
        let object_key: String = upload.get("object_key");

        if status == "completing" {
            let expected_size: i64 = upload.get("size_bytes");
            let expected_checksum: Option<String> = upload.get("checksum_sha256");
            let upload_mode: String = upload.get("upload_mode");

            let metadata = match storage.object_metadata(&object_key).await {
                Ok(metadata) => Some(metadata),
                Err(error) if error.is_not_found() => None,
                Err(error) => {
                    log::warn!(
                        "could not verify finalizing upload {id}; reconciliation will retry: {error}"
                    );
                    continue;
                }
            };

            if let Some(metadata) = metadata {
                let size_matches = u64::try_from(expected_size).ok() == Some(metadata.size_bytes);
                let checksum_matches = upload_mode != "single"
                    || expected_checksum.as_deref() == metadata.checksum_sha256.as_deref();

                if size_matches && checksum_matches {
                    let mut client = db.get().await?;
                    let transaction = client.transaction().await?;
                    let current = transaction
                        .query_opt(
                            "SELECT status FROM file_uploads WHERE id = $1 FOR UPDATE",
                            &[&id],
                        )
                        .await?;

                    if current
                        .as_ref()
                        .is_none_or(|row| row.get::<_, String>("status") != "completing")
                    {
                        transaction.commit().await?;
                        continue;
                    }

                    let file_id: String = upload.get("file_id");
                    let owner_id: String = upload.get("owner_id");
                    let parent_id: Option<String> = upload.get("parent_id");
                    let original_name: String = upload.get("original_name");
                    let mime_type: Option<String> = upload.get("mime_type");
                    transaction
                        .execute(
                            "
                                INSERT INTO files (
                                  id,
                                  owner_id,
                                  original_name,
                                  storage_name,
                                  mime_type,
                                  size_bytes,
                                  entry_type,
                                  parent_id,
                                  checksum_sha256,
                                  object_etag
                                )
                                VALUES ($1, $2, $3, $4, $5, $6, 'file', $7, $8, $9)
                                ON CONFLICT (id) DO NOTHING
                            ",
                            &[
                                &file_id,
                                &owner_id,
                                &original_name,
                                &object_key,
                                &mime_type,
                                &expected_size,
                                &parent_id,
                                &metadata.checksum_sha256,
                                &metadata.etag,
                            ],
                        )
                        .await?;
                    transaction
                        .execute(
                            "UPDATE file_uploads SET status = 'completed', completed_at = now() WHERE id = $1 AND status = 'completing'",
                            &[&id],
                        )
                        .await?;
                    transaction.commit().await?;
                    continue;
                }
            }
        }

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
                        AND status IN ('initializing', 'pending', 'completing', 'aborting')
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
            SET total_users = (SELECT count(*) FROM users),
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
