use std::error::Error as StdError;
use std::io;
use std::time::SystemTime;

use crate::db::Database;
use crate::storage::ObjectMetadata;

#[derive(Clone, Debug)]
pub(crate) struct FileUploadRecord {
    pub id: String,
    pub file_id: String,
    pub owner_id: String,
    pub parent_id: Option<String>,
    pub original_name: String,
    pub object_key: String,
    pub mime_type: Option<String>,
    pub size_bytes: i64,
    pub mode: String,
    pub part_size_bytes: Option<i64>,
    pub multipart_upload_id: Option<String>,
    pub status: String,
    pub checksum_sha256: Option<String>,
    pub share_link_id: Option<String>,
    pub replacement_file_id: Option<String>,
    pub expires_at: SystemTime,
    pub completion_attempts: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FileUploadFinalizeOutcome {
    Completed,
    AlreadyCompleted,
    Missing,
    StateChanged,
    ReplacementMismatch,
}

pub(crate) async fn claim_file_upload_completions(
    db: &Database,
    limit: i64,
) -> Result<Vec<FileUploadRecord>, Box<dyn StdError + Send + Sync>> {
    let rows = db
        .query(
            "
                WITH claimed AS (
                  SELECT id
                  FROM file_uploads
                  WHERE status = 'completing'
                    AND completion_available_at <= now()
                    AND (
                      completion_locked_until IS NULL
                      OR completion_locked_until <= now()
                    )
                  ORDER BY completion_available_at, id
                  LIMIT $1
                  FOR UPDATE SKIP LOCKED
                )
                UPDATE file_uploads AS uploads
                SET completion_locked_until = now() + interval '2 minutes'
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
                  uploads.part_size_bytes,
                  uploads.multipart_upload_id,
                  uploads.status,
                  uploads.checksum_sha256,
                  uploads.share_link_id,
                  uploads.replacement_file_id,
                  uploads.expires_at,
                  uploads.completion_attempts
            ",
            &[&limit],
        )
        .await?;

    Ok(rows.into_iter().map(file_upload_from_row).collect())
}

pub(crate) async fn defer_file_upload_completion(
    db: &Database,
    upload_id: &str,
    owner_id: &str,
    error_message: &str,
    delay_seconds: i64,
) -> Result<bool, Box<dyn StdError + Send + Sync>> {
    let error_message = error_message.chars().take(500).collect::<String>();
    let updated = db
        .execute(
            "
                UPDATE file_uploads
                SET completion_attempts = completion_attempts + 1,
                    completion_available_at =
                      now() + ($3::bigint * interval '1 second'),
                    completion_locked_until = NULL,
                    completion_last_error = $4
                WHERE id = $1 AND owner_id = $2 AND status = 'completing'
            ",
            &[&upload_id, &owner_id, &delay_seconds, &error_message],
        )
        .await?;

    Ok(updated == 1)
}

pub(crate) async fn finalize_file_upload_record(
    db: &Database,
    upload: &FileUploadRecord,
    metadata: &ObjectMetadata,
    presign_seconds: u64,
) -> Result<FileUploadFinalizeOutcome, Box<dyn StdError + Send + Sync>> {
    let mut client = db.get().await?;
    let transaction = client.transaction().await?;
    let current = transaction
        .query_opt(
            "SELECT status FROM file_uploads WHERE id = $1 AND owner_id = $2 FOR UPDATE",
            &[&upload.id, &upload.owner_id],
        )
        .await?;
    let Some(current) = current else {
        transaction.commit().await?;
        return Ok(FileUploadFinalizeOutcome::Missing);
    };
    let current_status: String = current.get("status");

    if current_status == "completed" {
        transaction.commit().await?;
        return Ok(FileUploadFinalizeOutcome::AlreadyCompleted);
    }
    if current_status != "completing" {
        transaction.commit().await?;
        return Ok(FileUploadFinalizeOutcome::StateChanged);
    }

    if let Some(replacement_file_id) = upload.replacement_file_id.as_deref() {
        let target = if upload.share_link_id.is_some() {
            transaction
                .query_opt(
                    "
                        SELECT storage_name
                        FROM files
                        WHERE id = $1 AND owner_id = $2 AND entry_type = 'file'
                          AND state = 'active' AND e2ee_state IN ('legacy', 'staged')
                        FOR UPDATE
                    ",
                    &[&replacement_file_id, &upload.owner_id],
                )
                .await?
        } else {
            transaction
                .query_opt(
                    "
                        SELECT storage_name
                        FROM files
                        WHERE id = $1 AND owner_id = $2 AND entry_type = 'file'
                          AND state = 'active' AND e2ee_state IN ('legacy', 'staged')
                          AND parent_id IS NOT DISTINCT FROM $3
                          AND lower(original_name) = lower($4)
                        FOR UPDATE
                    ",
                    &[
                        &replacement_file_id,
                        &upload.owner_id,
                        &upload.parent_id,
                        &upload.original_name,
                    ],
                )
                .await?
        };
        let Some(target) = target else {
            transaction.rollback().await?;
            return Ok(FileUploadFinalizeOutcome::ReplacementMismatch);
        };
        let previous_storage_name: String = target.get("storage_name");
        let previous_object_key = if previous_storage_name.contains('/') {
            previous_storage_name
        } else {
            format!("{}/{}", upload.owner_id, previous_storage_name)
        };
        let presign_seconds = i64::try_from(presign_seconds)
            .map_err(|_| io::Error::other("invalid signature lifetime"))?;
        transaction
            .execute(
                "
                    INSERT INTO storage_deletion_jobs (object_key, available_at)
                    VALUES ($1, now() + ($2::bigint * interval '1 second'))
                    ON CONFLICT (object_key) DO UPDATE SET
                      available_at = GREATEST(
                        storage_deletion_jobs.available_at,
                        EXCLUDED.available_at
                      )
                ",
                &[&previous_object_key, &presign_seconds],
            )
            .await?;
        transaction
            .execute(
                "
                    UPDATE files
                    SET original_name = $1,
                        storage_name = $2,
                        mime_type = $3,
                        size_bytes = $4,
                        checksum_sha256 = $5,
                        object_etag = $6,
                        updated_at = now()
                    WHERE id = $7 AND owner_id = $8
                ",
                &[
                    &upload.original_name,
                    &upload.object_key,
                    &upload.mime_type,
                    &upload.size_bytes,
                    &metadata.checksum_sha256,
                    &metadata.etag,
                    &replacement_file_id,
                    &upload.owner_id,
                ],
            )
            .await?;
    } else {
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
                    &upload.file_id,
                    &upload.owner_id,
                    &upload.original_name,
                    &upload.object_key,
                    &upload.mime_type,
                    &upload.size_bytes,
                    &upload.parent_id,
                    &metadata.checksum_sha256,
                    &metadata.etag,
                ],
            )
            .await?;
    }
    transaction
        .execute(
            "
                UPDATE file_uploads
                SET status = 'completed',
                    completed_at = now(),
                    completion_checksum_sha256 = $3,
                    completion_etag = $4,
                    completion_verified_at = now(),
                    completion_locked_until = NULL,
                    completion_last_error = NULL
                WHERE id = $1 AND owner_id = $2 AND status = 'completing'
            ",
            &[
                &upload.id,
                &upload.owner_id,
                &metadata.checksum_sha256,
                &metadata.etag,
            ],
        )
        .await?;
    transaction.commit().await?;

    Ok(FileUploadFinalizeOutcome::Completed)
}

pub(crate) async fn transition_file_upload_to_cleanup(
    db: &Database,
    upload_id: &str,
    owner_id: &str,
    object_key: &str,
    multipart_upload_id: Option<&str>,
    from_statuses: &[&str],
) -> Result<bool, Box<dyn StdError + Send + Sync>> {
    let statuses = from_statuses
        .iter()
        .map(|status| (*status).to_owned())
        .collect::<Vec<_>>();
    let transitioned = db
        .query_opt(
            "
                WITH transitioned AS (
                  UPDATE file_uploads
                  SET status = 'aborting',
                      multipart_upload_id = COALESCE($1, multipart_upload_id),
                      expires_at = now() + interval '24 hours',
                      completion_locked_until = NULL
                  WHERE id = $2
                    AND owner_id = $3
                    AND object_key = $4
                    AND status = ANY($5)
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
                RETURNING object_key
            ",
            &[
                &multipart_upload_id,
                &upload_id,
                &owner_id,
                &object_key,
                &statuses,
            ],
        )
        .await?;

    Ok(transitioned.is_some())
}

pub(crate) fn file_upload_metadata_matches(
    upload: &FileUploadRecord,
    metadata: &ObjectMetadata,
) -> bool {
    let size_matches = u64::try_from(upload.size_bytes).ok() == Some(metadata.size_bytes);
    let checksum_matches = upload.mode != "single"
        || upload
            .checksum_sha256
            .as_deref()
            .is_some_and(|expected| metadata.checksum_sha256.as_deref() == Some(expected));

    size_matches && checksum_matches
}

pub(crate) fn completion_retry_delay_seconds(attempts: i32, upload_id: &str) -> i64 {
    let exponent = u32::try_from(attempts.clamp(0, 8)).unwrap_or(0);
    let base = i64::from(2_i32.pow(exponent)).min(240);
    let hash = upload_id.bytes().fold(0_u64, |value, byte| {
        value
            .wrapping_mul(1099511628211)
            .wrapping_add(u64::from(byte))
    });
    let jitter_window = u64::try_from((base / 4).max(1)).unwrap_or(1);
    let jitter = i64::try_from(hash % (jitter_window + 1)).unwrap_or(0);

    (base + jitter).min(300)
}

pub(crate) fn file_upload_from_row(row: tokio_postgres::Row) -> FileUploadRecord {
    FileUploadRecord {
        id: row.get("id"),
        file_id: row.get("file_id"),
        owner_id: row.get("owner_id"),
        parent_id: row.get("parent_id"),
        original_name: row.get("original_name"),
        object_key: row.get("object_key"),
        mime_type: row.get("mime_type"),
        size_bytes: row.get("size_bytes"),
        mode: row.get("upload_mode"),
        part_size_bytes: row.get("part_size_bytes"),
        multipart_upload_id: row.get("multipart_upload_id"),
        status: row.get("status"),
        checksum_sha256: row.get("checksum_sha256"),
        share_link_id: row.get("share_link_id"),
        replacement_file_id: row.get("replacement_file_id"),
        expires_at: row.get("expires_at"),
        completion_attempts: row.get("completion_attempts"),
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::{FileUploadRecord, completion_retry_delay_seconds, file_upload_metadata_matches};
    use crate::storage::ObjectMetadata;

    fn source_between<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
        let start = source.find(start).expect("start marker should exist");
        let remainder = &source[start..];
        let end = remainder.find(end).expect("end marker should exist");
        &remainder[..end]
    }

    #[test]
    fn completion_backoff_is_bounded_and_stable_per_upload() {
        let first = completion_retry_delay_seconds(3, "upload-a");
        assert_eq!(first, completion_retry_delay_seconds(3, "upload-a"));
        assert!((8..=10).contains(&first));
        assert!(completion_retry_delay_seconds(100, "upload-a") <= 300);
    }

    #[test]
    fn single_upload_reconciliation_requires_the_reserved_checksum() {
        let upload = FileUploadRecord {
            id: "upload".to_owned(),
            file_id: "file".to_owned(),
            owner_id: "owner".to_owned(),
            parent_id: None,
            original_name: "file.bin".to_owned(),
            object_key: "object".to_owned(),
            mime_type: None,
            size_bytes: 4,
            mode: "single".to_owned(),
            part_size_bytes: None,
            multipart_upload_id: None,
            status: "completing".to_owned(),
            checksum_sha256: None,
            share_link_id: None,
            replacement_file_id: None,
            expires_at: UNIX_EPOCH + Duration::from_secs(1),
            completion_attempts: 0,
        };
        let metadata = ObjectMetadata {
            size_bytes: 4,
            checksum_sha256: None,
            etag: None,
        };

        assert!(!file_upload_metadata_matches(&upload, &metadata));
    }

    #[test]
    fn successful_multipart_completion_reuses_provider_metadata_without_head() {
        let storage = include_str!("storage.rs");
        let complete_multipart = source_between(
            storage,
            "pub async fn complete_multipart(",
            "pub async fn abort_multipart(",
        );
        assert!(complete_multipart.contains("let output = client"));
        assert!(complete_multipart.contains("Ok(ObjectMetadata"));
        assert!(!complete_multipart.contains("head_object"));

        let files = include_str!("routes/files.rs");
        let complete_upload = source_between(
            files,
            "pub async fn complete_upload(",
            "pub async fn upload_status(",
        );
        assert!(complete_upload.contains(".complete_multipart("));
        assert_eq!(
            complete_upload.matches(".object_metadata(").count(),
            1,
            "only the direct single-object upload path may require HEAD"
        );

        let vault = include_str!("routes/vault.rs");
        let finalize_ciphertext = source_between(
            vault,
            "async fn finalize_ciphertext_object(",
            "fn verify_object_metadata(",
        );
        assert!(
            finalize_ciphertext.contains("Ok(metadata) => completed_metadata = Some(metadata)")
        );
        assert!(finalize_ciphertext.contains("Some(metadata) => metadata"));
    }

    #[test]
    fn upload_status_polling_is_database_only() {
        let files = include_str!("routes/files.rs");
        let status = source_between(
            files,
            "pub async fn upload_status(",
            "fn upload_complete_response(",
        );
        assert!(!status.contains("object_metadata"));
        assert!(!status.contains("finalize_file_upload_record"));

        let completion_worker = include_str!("upload_completion.rs");
        assert!(completion_worker.contains("FOR UPDATE SKIP LOCKED"));
        assert!(completion_worker.contains("completion_locked_until"));
        assert!(completion_worker.contains("completion_last_error"));
    }
}
