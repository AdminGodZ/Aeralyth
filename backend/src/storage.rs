use std::error::Error as StdError;
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use aws_config::BehaviorVersion;
use aws_credential_types::Credentials;
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::types::{
    ChecksumAlgorithm, ChecksumMode, CompletedMultipartUpload, CompletedPart,
};
use aws_types::region::Region;
use serde::Serialize;
use tokio::time::{MissedTickBehavior, interval};

use crate::config::Config;
use crate::db::Database;

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
        let secret_access_key = required(
            config.s3_secret_access_key.clone(),
            "S3 secret access key",
        )?;
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
        })
    }

    pub fn backend_name(&self) -> &'static str {
        match self {
            Self::Local { .. } => "local",
            Self::S3 { .. } => "s3",
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

    pub async fn presign_single_upload(
        &self,
        object_key: &str,
        content_type: &str,
        checksum_sha256: &str,
    ) -> Result<String, StorageError> {
        let Self::S3 {
            client,
            bucket,
            presign_seconds,
            ..
        } = self
        else {
            return Err(storage_message("single-object presigning requires S3 storage"));
        };
        let request = client
            .put_object()
            .bucket(bucket)
            .key(object_key)
            .content_type(content_type)
            .checksum_sha256(checksum_sha256)
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
        let request = client
            .upload_part()
            .bucket(bucket)
            .key(object_key)
            .upload_id(multipart_upload_id)
            .part_number(part_number)
            .checksum_sha256(checksum_sha256)
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

        client
            .abort_multipart_upload()
            .bucket(bucket)
            .key(object_key)
            .upload_id(multipart_upload_id)
            .send()
            .await
            .map_err(storage_error)?;

        Ok(())
    }

    pub async fn object_metadata(&self, object_key: &str) -> Result<ObjectMetadata, StorageError> {
        match self {
            Self::Local { .. } => {
                let path = self
                    .local_path(object_key)
                    .ok_or_else(|| storage_message("invalid local object key"))?;
                let metadata = tokio::fs::metadata(path).await.map_err(|error| {
                    storage_io_error(error)
                })?;
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
    let mut reconciliation_ticks = 0_u16;

    loop {
        maintenance_interval.tick().await;

        if let Err(error) = process_deletion_jobs(&db, &storage).await {
            log::error!("storage deletion worker failed: {error}");
        }
        if let Err(error) = expire_abandoned_uploads(&db, &storage).await {
            log::error!("abandoned upload cleanup failed: {error}");
        }
        if let Err(error) = expire_invitations_batch(&db).await {
            log::error!("invitation expiry worker failed: {error}");
        }

        reconciliation_ticks = reconciliation_ticks.saturating_add(1);
        if reconciliation_ticks >= 360 {
            reconciliation_ticks = 0;
            if let Err(error) = reconcile_counters(&db).await {
                log::error!("counter reconciliation failed: {error}");
            }
        }
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
                let _ = storage
                    .abort_multipart(&object_key, multipart_upload_id)
                    .await;
            }
            storage.delete_object(&object_key).await
        }
        .await;

        match deletion_result {
            Ok(()) => {
                db.execute("DELETE FROM storage_deletion_jobs WHERE id = $1", &[&id])
                    .await?;
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
                  WHERE status IN ('pending', 'completing') AND expires_at <= now()
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
        let multipart_upload_id: Option<String> = upload.get("multipart_upload_id");

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

        let cleanup_result = async {
            if let Some(multipart_upload_id) = multipart_upload_id.as_deref() {
                let _ = storage
                    .abort_multipart(&object_key, multipart_upload_id)
                    .await;
            }
            storage.delete_object(&object_key).await
        }
        .await;

        match cleanup_result {
            Ok(()) => {
                db.execute(
                    "UPDATE file_uploads SET status = 'aborted' WHERE id = $1 AND status IN ('pending', 'completing')",
                    &[&id],
                )
                .await?;
            }
            Err(error) => {
                log::warn!("could not clean abandoned upload {id}: {error}");
            }
        }
    }

    Ok(())
}

async fn expire_invitations_batch(
    db: &Database,
) -> Result<(), Box<dyn StdError + Send + Sync>> {
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

    Some(object_key.split('/').fold(root.to_path_buf(), |path, segment| {
        path.join(segment)
    }))
}
