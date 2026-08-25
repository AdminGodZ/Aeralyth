use std::error::Error as StdError;
use std::io;
use std::time::SystemTime;

use crate::collection_timestamps::touch_ancestor_collections;
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
    pub completion_lease_token: String,
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
                    AND completion_dead_lettered_at IS NULL
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
                SET completion_locked_until = now() + interval '5 minutes',
                    completion_lease_token = gen_random_uuid()::text
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
                  uploads.completion_attempts,
                  uploads.completion_lease_token
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
    lease_token: &str,
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
                      now() + ($4::bigint * interval '1 second'),
                    completion_locked_until = NULL,
                    completion_lease_token = NULL,
                    completion_dead_lettered_at = CASE
                      WHEN completion_attempts + 1 >= 12 THEN now()
                      ELSE completion_dead_lettered_at
                    END,
                    completion_last_error = $5
                WHERE id = $1
                  AND owner_id = $2
                  AND completion_lease_token = $3
                  AND status = 'completing'
            ",
            &[
                &upload_id,
                &owner_id,
                &lease_token,
                &delay_seconds,
                &error_message,
            ],
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
            "SELECT status, completion_lease_token FROM file_uploads WHERE id = $1 AND owner_id = $2 FOR UPDATE",
            &[&upload.id, &upload.owner_id],
        )
        .await?;
    let Some(current) = current else {
        transaction.commit().await?;
        return Ok(FileUploadFinalizeOutcome::Missing);
    };
    let current_status: String = current.get("status");
    let current_lease_token: Option<String> = current.get("completion_lease_token");

    if current_status == "completed" {
        transaction.commit().await?;
        return Ok(FileUploadFinalizeOutcome::AlreadyCompleted);
    }
    if current_status != "completing"
        || current_lease_token.as_deref() != Some(upload.completion_lease_token.as_str())
    {
        transaction.commit().await?;
        return Ok(FileUploadFinalizeOutcome::StateChanged);
    }

    let parent_folder_id = if let Some(replacement_file_id) = upload.replacement_file_id.as_deref()
    {
        let target = if upload.share_link_id.is_some() {
            transaction
                .query_opt(
                    "
                        SELECT storage_name, parent_id
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
                        SELECT storage_name, parent_id
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
        target.get::<_, Option<String>>("parent_id")
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
        upload.parent_id.clone()
    };
    touch_ancestor_collections(&transaction, parent_folder_id.as_deref(), &upload.owner_id).await?;
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
                    completion_lease_token = NULL,
                    completion_last_error = NULL
                WHERE id = $1
                  AND owner_id = $2
                  AND completion_lease_token = $5
                  AND status = 'completing'
            ",
            &[
                &upload.id,
                &upload.owner_id,
                &metadata.checksum_sha256,
                &metadata.etag,
                &upload.completion_lease_token,
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
    lease_token: Option<&str>,
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
                  SET status = 'aborted',
                      multipart_upload_id = COALESCE($1, multipart_upload_id),
                      expires_at = now() + interval '24 hours',
                      completion_locked_until = NULL,
                      completion_lease_token = NULL
                  WHERE id = $2
                    AND owner_id = $3
                    AND object_key = $4
                    AND status = ANY($5)
                    AND ($6::text IS NULL OR completion_lease_token = $6)
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
                &lease_token,
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

pub(crate) fn completion_retry_delay_seconds(attempts: i32) -> i64 {
    let mut sample = [0_u8; 8];
    if getrandom::fill(&mut sample).is_err() {
        let fallback = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_le_bytes();
        sample.copy_from_slice(&fallback[..8]);
    }
    completion_retry_delay_from_sample(attempts, u64::from_le_bytes(sample))
}

fn completion_retry_delay_from_sample(attempts: i32, sample: u64) -> i64 {
    const FLOOR_SECONDS: i64 = 10;
    const CAP_SECONDS: i64 = 60 * 60;
    let exponent = u32::try_from(attempts.clamp(0, 16)).unwrap_or_default();
    let ceiling = FLOOR_SECONDS
        .saturating_mul(1_i64.checked_shl(exponent).unwrap_or(i64::MAX))
        .min(CAP_SECONDS);
    let window = u64::try_from(ceiling - FLOOR_SECONDS).unwrap_or_default();
    FLOOR_SECONDS + i64::try_from(sample % (window + 1)).unwrap_or_default()
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
        completion_lease_token: row.get("completion_lease_token"),
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::{
        FileUploadRecord, completion_retry_delay_from_sample, file_upload_metadata_matches,
    };
    use crate::storage::ObjectMetadata;

    fn source_between<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
        let start = source.find(start).expect("start marker should exist");
        let remainder = &source[start..];
        let end = remainder.find(end).expect("end marker should exist");
        &remainder[..end]
    }

    #[test]
    fn completion_backoff_uses_full_jitter_with_a_poll_aligned_floor() {
        assert_eq!(completion_retry_delay_from_sample(0, 0), 10);
        assert_eq!(completion_retry_delay_from_sample(1, 0), 10);
        assert_eq!(completion_retry_delay_from_sample(1, 10), 20);
        assert!(completion_retry_delay_from_sample(100, u64::MAX) <= 3_600);
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
            completion_lease_token: "lease".to_owned(),
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

    #[test]
    fn completed_file_uploads_touch_their_parent_collections() {
        let legacy = include_str!("upload_completion.rs");
        let legacy_completion = source_between(
            legacy,
            "pub(crate) async fn finalize_file_upload_record(",
            "pub(crate) async fn transition_file_upload_to_cleanup(",
        );
        assert!(legacy_completion.contains("touch_ancestor_collections("));

        let vault = include_str!("routes/vault.rs");
        let encrypted_completion = source_between(
            vault,
            "async fn publish_record_transaction(",
            "async fn decode_and_verify_node_record(",
        );
        assert!(encrypted_completion.contains("touch_ancestor_collections("));
    }

    #[test]
    fn upload_abort_queues_cleanup_without_waiting_for_provider_io() {
        let files = include_str!("routes/files.rs");
        let file_abort = source_between(
            files,
            "pub async fn abort_upload(",
            "pub async fn download(",
        );
        assert!(file_abort.contains("enqueue_upload_cleanup("));
        assert!(file_abort.contains("HttpResponse::Accepted()"));
        assert!(!file_abort.contains(".abort_multipart("));
        assert!(!file_abort.contains(".delete_object("));

        let vault = include_str!("routes/vault.rs");
        let vault_abort = source_between(
            vault,
            "pub async fn abort_upload(",
            "pub async fn share_plan(",
        );
        assert!(vault_abort.contains("SET status = 'aborted'"));
        assert!(vault_abort.contains("INSERT INTO storage_deletion_jobs"));
        assert!(vault_abort.contains("write_expires_at"));
        assert!(vault_abort.contains("HttpResponse::Accepted()"));
        assert!(!vault_abort.contains(".abort_multipart("));
        assert!(!vault_abort.contains(".delete_object("));

        let vault_init = source_between(
            vault,
            "pub async fn init_upload(",
            "pub async fn presign_content(",
        );
        assert!(vault_init.contains("WITH initialized AS"));
        assert!(vault_init.contains("NOT EXISTS (SELECT 1 FROM initialized)"));
        assert!(vault_init.contains("INSERT INTO storage_deletion_jobs"));
        assert!(vault_init.contains("EXCLUDED.multipart_upload_id"));
        assert!(vault_init.contains("SET status = 'aborted', expires_at = now()"));

        let vault_publish = source_between(
            vault,
            "async fn publish_record_transaction(",
            "async fn decode_and_verify_node_record(",
        );
        assert!(vault_publish.contains("FROM vault_uploads"));
        assert!(vault_publish.contains("FOR UPDATE"));
        assert!(vault_publish.contains("Some(\"pending\" | \"completing\")"));
        assert!(vault_publish.contains("if published != 1"));

        let transition = source_between(
            include_str!("upload_completion.rs"),
            "pub(crate) async fn transition_file_upload_to_cleanup(",
            "#[cfg(test)]",
        );
        assert!(transition.contains("SET status = 'aborted'"));
        assert!(transition.contains("INSERT INTO storage_deletion_jobs"));

        let storage = include_str!("storage.rs");
        let finish_job = source_between(
            storage,
            "async fn finish_storage_deletion_job(",
            "async fn process_deletion_jobs(",
        );
        assert!(finish_job.contains("FOR UPDATE"));
        assert!(finish_job.contains("current_multipart_upload_id != multipart_upload_id"));
        assert!(finish_job.contains("SET available_at = now(), locked_until = NULL"));

        let process_jobs = source_between(
            storage,
            "async fn process_deletion_jobs(",
            "async fn reconcile_file_upload_completions(",
        );
        assert!(process_jobs.contains("discover_multipart"));
        assert!(process_jobs.contains("abort_multipart_uploads_for_key"));
    }
}
