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
    ParentUnavailable,
    Deferred,
}

// Position and fixed eligibility cutoff for one finite sweep. Keeping the
// cutoff prevents continuous new arrivals from starving older fenced work.
pub(crate) type UploadClaimCursor = tokio::sync::Mutex<Option<(SystemTime, String, SystemTime)>>;

pub(crate) const UPLOAD_CLAIM_OWNERS_QUERY: &str = "
    WITH candidates AS MATERIALIZED (
      SELECT owner_id FROM tree_operation_owners WHERE owner_id = ANY($1)
    ), admitted AS MATERIALIZED (
      SELECT owner_id FROM candidates
      WHERE pg_try_advisory_xact_lock_shared(hashtextextended('aeralyth:tree-operation:' || owner_id, 0))
    )
    SELECT owners.owner_id FROM admitted
    JOIN tree_operation_owners AS owners ON owners.owner_id = admitted.owner_id
    ORDER BY owners.owner_id FOR SHARE OF owners SKIP LOCKED
";

/// Acquire publication fences before upload row locks. The caller supplies only
/// a bounded candidate batch; advisory locks must never be evaluated over a queue
/// scan before its LIMIT. A publishing owner is skipped instead of blocking peers.
pub(crate) async fn lock_upload_claim_owners(
    transaction: &tokio_postgres::Transaction<'_>,
    owner_ids: &[String],
) -> Result<Vec<String>, tokio_postgres::Error> {
    let rows = transaction
        .query(UPLOAD_CLAIM_OWNERS_QUERY, &[&owner_ids])
        .await?;
    Ok(rows.into_iter().map(|row| row.get("owner_id")).collect())
}

pub(crate) async fn claim_file_upload_completions(
    db: &Database,
    limit: i64,
    cursor: &UploadClaimCursor,
) -> Result<Vec<FileUploadRecord>, Box<dyn StdError + Send + Sync>> {
    let limit = limit.clamp(0, 100);
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut cursor = cursor.lock().await;
    let mut client = db.get().await?;
    let transaction = client.transaction().await?;
    let mut claimed = Vec::new();
    let (mut after_due, mut after_id, sweep_cutoff) = match cursor.as_ref() {
        Some((due, id, cutoff)) => (Some(*due), id.clone(), *cutoff),
        None => (
            None,
            String::new(),
            transaction
                .query_one("SELECT clock_timestamp()", &[])
                .await?
                .get::<_, SystemTime>(0),
        ),
    };
    // Refill around contended owners/rows without an unbounded maintenance turn.
    for _ in 0..4 {
        let remaining = limit - claimed.len() as i64;
        if remaining == 0 {
            break;
        }
        let candidates = transaction.query(
            "SELECT uploads.id, uploads.owner_id, uploads.completion_available_at
             FROM file_uploads AS uploads
             WHERE uploads.status = 'completing'
               AND uploads.completion_dead_lettered_at IS NULL
               AND uploads.completion_available_at <= $4::timestamptz
               AND (uploads.completion_locked_until IS NULL OR uploads.completion_locked_until <= now())
               AND (uploads.completion_available_at, uploads.id) > (COALESCE($2::timestamptz, '-infinity'::timestamptz), $3::text)
             ORDER BY uploads.completion_available_at, uploads.id LIMIT $1",
            &[&remaining, &after_due, &after_id, &sweep_cutoff],
        ).await?;
        if candidates.is_empty() {
            after_due = None;
            after_id.clear();
            break;
        }
        let last = candidates.last().expect("nonempty candidate page");
        after_due = Some(last.get("completion_available_at"));
        after_id = last.get("id");
        let candidate_ids = candidates
            .iter()
            .map(|row| row.get::<_, String>("id"))
            .collect::<Vec<_>>();
        let mut owner_ids = candidates
            .iter()
            .map(|row| row.get::<_, String>("owner_id"))
            .collect::<Vec<_>>();
        owner_ids.sort();
        owner_ids.dedup();
        let locked_owners = lock_upload_claim_owners(&transaction, &owner_ids).await?;
        // This separate statement takes a fresh READ COMMITTED snapshot after
        // the owner fence. A publication that committed during selection is
        // visible here, and no new publication can pass our shared owner locks.
        let rows = transaction.query(
            "WITH claimed AS (
                  SELECT uploads.id FROM file_uploads AS uploads
                  WHERE uploads.id = ANY($1) AND uploads.owner_id = ANY($2)
                    AND uploads.status = 'completing'
                    AND uploads.completion_dead_lettered_at IS NULL
                    AND uploads.completion_available_at <= now()
                    AND (uploads.completion_locked_until IS NULL OR uploads.completion_locked_until <= now())
                    AND NOT EXISTS (
                        SELECT 1 FROM tree_operation_jobs AS job
                        LEFT JOIN share_links AS link ON link.id = uploads.share_link_id
                        WHERE job.owner_id = uploads.owner_id
                          AND job.status IN ('pending', 'running')
                          AND (
                            tree_operation_ancestor(uploads.file_id, uploads.owner_id, job.root_id)
                            OR tree_operation_ancestor(uploads.parent_id, uploads.owner_id, job.root_id)
                            OR tree_operation_ancestor(uploads.replacement_file_id, uploads.owner_id, job.root_id)
                            OR tree_operation_ancestor(link.root_file_id, uploads.owner_id, job.root_id)
                          )
                      )
                  ORDER BY uploads.completion_available_at, uploads.id
                  FOR UPDATE SKIP LOCKED
                )
                UPDATE file_uploads AS uploads
                SET completion_locked_until = now() + interval '5 minutes',
                    completion_lease_token = gen_random_uuid()::text
                FROM claimed
                WHERE uploads.id = claimed.id
                RETURNING uploads.id, uploads.file_id, uploads.owner_id, uploads.parent_id,
                  uploads.original_name, uploads.object_key, uploads.mime_type, uploads.size_bytes,
                  uploads.upload_mode, uploads.part_size_bytes, uploads.multipart_upload_id,
                  uploads.status, uploads.checksum_sha256, uploads.share_link_id,
                  uploads.replacement_file_id, uploads.expires_at, uploads.completion_attempts,
                  uploads.completion_lease_token",
            &[&candidate_ids, &locked_owners],
        ).await?;
        claimed.extend(rows.into_iter().map(file_upload_from_row));
    }
    transaction.commit().await?;
    *cursor = after_due.map(|due| (due, after_id, sweep_cutoff));
    Ok(claimed)
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
    // Acquire the publication fence before the upload row, as tree workers do.
    // Contended owners yield without blocking unrelated completion work.
    let owner_gate: bool = transaction.query_one(
        "SELECT pg_try_advisory_xact_lock_shared(hashtextextended('aeralyth:tree-operation:' || $1::text, 0))",
        &[&upload.owner_id],
    ).await?.get(0);
    if !owner_gate || transaction.query_opt(
        "SELECT version FROM tree_operation_owners WHERE owner_id = $1 FOR SHARE SKIP LOCKED",
        &[&upload.owner_id],
    ).await?.is_none() {
        transaction.rollback().await?;
        drop(client);
        defer_file_upload_for_tree_operation(db, upload).await?;
        return Ok(FileUploadFinalizeOutcome::Deferred);
    }
    // A separate command takes a fresh snapshot after the publication lock.
    let fenced: bool = transaction.query_one(
        "SELECT EXISTS (SELECT 1 FROM tree_operation_jobs AS jobs
         WHERE jobs.owner_id = $1 AND jobs.status IN ('pending', 'running')
           AND (tree_operation_ancestor($2, $1, jobs.root_id)
             OR tree_operation_ancestor($3, $1, jobs.root_id)
             OR tree_operation_ancestor($4, $1, jobs.root_id)
             OR tree_operation_ancestor((SELECT root_file_id FROM share_links WHERE id = $5), $1, jobs.root_id)))",
        &[&upload.owner_id, &upload.file_id, &upload.parent_id, &upload.replacement_file_id, &upload.share_link_id],
    ).await?.get(0);
    if fenced {
        transaction.rollback().await?;
        drop(client);
        defer_file_upload_for_tree_operation(db, upload).await?;
        return Ok(FileUploadFinalizeOutcome::Deferred);
    }
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

    let replacement = if let Some(replacement_file_id) = upload.replacement_file_id.as_deref() {
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
        Some(target)
    } else {
        None
    };
    let parent_folder_id = replacement.as_ref().map_or_else(
        || upload.parent_id.clone(),
        |target| target.get::<_, Option<String>>("parent_id"),
    );
    if let Some(parent_id) = parent_folder_id.as_deref() {
        let parent_gate: bool = transaction.query_one(
            "SELECT pg_try_advisory_xact_lock_shared(hashtextextended('aeralyth:file-parent-lifecycle:' || $1::text, 0))",
            &[&parent_id],
        ).await?.get(0);
        if !parent_gate {
            transaction.rollback().await?;
            drop(client);
            defer_file_upload_for_tree_operation(db, upload).await?;
            return Ok(FileUploadFinalizeOutcome::Deferred);
        }
        let parent = transaction
            .query_opt(
                "SELECT id FROM files WHERE id = $1 AND owner_id = $2
             AND state = 'active' AND entry_type = 'folder' FOR KEY SHARE",
                &[&parent_id, &upload.owner_id],
            )
            .await?;
        if parent.is_none() {
            // Release the reservation and queue provider cleanup atomically.
            // Signed single PUTs retain their existing write deadline.
            transaction
                .query_opt(
                    FILE_UPLOAD_CLEANUP_QUERY,
                    &[
                        &upload.multipart_upload_id,
                        &upload.id,
                        &upload.owner_id,
                        &upload.object_key,
                        &vec!["completing".to_owned()],
                        &Some(upload.completion_lease_token.as_str()),
                    ],
                )
                .await?;
            transaction.commit().await?;
            return Ok(FileUploadFinalizeOutcome::ParentUnavailable);
        }
    }
    if let (Some(target), Some(replacement_file_id)) =
        (replacement, upload.replacement_file_id.as_deref())
    {
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

async fn defer_file_upload_for_tree_operation(
    db: &Database,
    upload: &FileUploadRecord,
) -> Result<(), Box<dyn StdError + Send + Sync>> {
    // This changes bookkeeping only, which the tree fence explicitly permits.
    // Skip a row already held by a finishing worker, and never release its newer lease.
    db.execute(
        "WITH candidate AS (
           SELECT id FROM file_uploads WHERE id=$1 AND owner_id=$2
             AND status='completing' AND completion_lease_token=$3
           FOR UPDATE SKIP LOCKED
         ) UPDATE file_uploads uploads SET completion_available_at=now()+interval '1 second',
           completion_locked_until=NULL, completion_lease_token=NULL,
           completion_last_error='Waiting for a file tree operation'
         FROM candidate WHERE uploads.id=candidate.id AND uploads.completion_lease_token=$3",
        &[&upload.id, &upload.owner_id, &upload.completion_lease_token],
    )
    .await?;
    Ok(())
}

const FILE_UPLOAD_CLEANUP_QUERY: &str = "
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
            ";

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
            FILE_UPLOAD_CLEANUP_QUERY,
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

    #[actix_web::test]
    async fn unavailable_parent_aborts_completion_atomically_without_losing_write_lease() {
        if std::env::var("AERALYTH_DATABASE_INTEGRATION_TESTS").as_deref() != Ok("1") {
            return;
        }
        let config = crate::config::Config::from_env().unwrap();
        let db = crate::db::Database::create(
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
            crate::observability::Metrics::new(&config),
        )
        .await
        .unwrap();
        let suffix: String = db
            .query_one("SELECT gen_random_uuid()::text", &[])
            .await
            .unwrap()
            .get(0);
        let owner = format!("usr_finalize_parent_{suffix}");
        let parent = format!("fil_finalize_parent_{suffix}");
        let file = format!("fil_finalize_child_{suffix}");
        let upload_id = format!("upl_finalize_parent_{suffix}");
        let object = format!("{owner}/object");
        db.execute(
            "INSERT INTO users(id,username,password_hash,role) VALUES($1,$1,'test-only','user')",
            &[&owner],
        )
        .await
        .unwrap();
        db.execute("INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type) VALUES($1,$2,'Parent',$1,0,'folder')", &[&parent,&owner]).await.unwrap();
        // Upload initialization reserves capacity before inserting its intent.
        db.execute(
            "UPDATE user_storage_usage SET reserved_bytes=4,pending_uploads=1 WHERE owner_id=$1",
            &[&owner],
        )
        .await
        .unwrap();
        let row = db.query_one("INSERT INTO file_uploads(id,file_id,owner_id,parent_id,original_name,object_key,size_bytes,reservation_bytes,upload_mode,status,completion_lease_token,completion_locked_until,expires_at,write_expires_at)
            VALUES($1,$2,$3,$4,'test.bin',$5,4,4,'single','completing','parent-lease',now()+interval '5 minutes',now()+interval '1 day',now()+interval '30 minutes') RETURNING *",
            &[&upload_id,&file,&owner,&parent,&object]).await.unwrap();
        let upload = super::file_upload_from_row(row);
        let metadata = ObjectMetadata {
            size_bytes: 4,
            checksum_sha256: None,
            etag: None,
        };
        assert_eq!(
            db.query_one(
                "SELECT reserved_bytes FROM user_storage_usage WHERE owner_id=$1",
                &[&owner]
            )
            .await
            .unwrap()
            .get::<_, i64>(0),
            4
        );

        // A concurrent parent lifecycle transaction is transient, never an abort.
        let (mut blocker, connection) =
            tokio_postgres::connect(&config.database_url, tokio_postgres::NoTls)
                .await
                .unwrap();
        let connection_task = tokio::spawn(connection);
        let transaction = blocker.transaction().await.unwrap();
        transaction.query_one("SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:file-parent-lifecycle:' || $1::text,0))", &[&parent]).await.unwrap();
        let contended = tokio::time::timeout(
            Duration::from_secs(1),
            super::finalize_file_upload_record(&db, &upload, &metadata, 900),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(contended, super::FileUploadFinalizeOutcome::Deferred);
        transaction.rollback().await.unwrap();
        drop(blocker);
        connection_task.await.unwrap().unwrap();
        assert_eq!(
            db.query_one("SELECT status FROM file_uploads WHERE id=$1", &[&upload_id])
                .await
                .unwrap()
                .get::<_, String>(0),
            "completing"
        );

        let deferred = db
            .query_one(
                "SELECT completion_lease_token IS NULL AS unlocked,
            completion_available_at <= now()+interval '2 seconds' AS prompt_retry,
            completion_attempts=0 AND completion_dead_lettered_at IS NULL AS retry_preserved
            FROM file_uploads WHERE id=$1",
                &[&upload_id],
            )
            .await
            .unwrap();
        assert!(deferred.get::<_, bool>("unlocked"));
        assert!(deferred.get::<_, bool>("prompt_retry"));
        assert!(deferred.get::<_, bool>("retry_preserved"));
        db.execute(
            "UPDATE file_uploads SET completion_lease_token='parent-lease' WHERE id=$1",
            &[&upload_id],
        )
        .await
        .unwrap();
        db.execute(
            "UPDATE files SET state='trashed',trashed_at=now() WHERE id=$1",
            &[&parent],
        )
        .await
        .unwrap();
        let mut stale = upload.clone();
        stale.completion_lease_token = "stale-lease".to_owned();
        assert_eq!(
            super::finalize_file_upload_record(&db, &stale, &metadata, 900)
                .await
                .unwrap(),
            super::FileUploadFinalizeOutcome::StateChanged
        );
        assert_eq!(
            super::finalize_file_upload_record(&db, &upload, &metadata, 900)
                .await
                .unwrap(),
            super::FileUploadFinalizeOutcome::ParentUnavailable
        );
        let result = db.query_one("SELECT uploads.status, uploads.completion_lease_token IS NULL AS unlocked,
            jobs.available_at >= uploads.write_expires_at AS lease_preserved,
            usage.reserved_bytes, usage.pending_uploads,
            NOT EXISTS(SELECT 1 FROM files WHERE id=$2) AS unpublished
            FROM file_uploads uploads JOIN storage_deletion_jobs jobs ON jobs.object_key=uploads.object_key
            JOIN user_storage_usage usage ON usage.owner_id=uploads.owner_id WHERE uploads.id=$1", &[&upload_id,&file]).await.unwrap();
        assert_eq!(result.get::<_, String>("status"), "aborted");
        assert!(result.get::<_, bool>("unlocked"));
        assert!(result.get::<_, bool>("lease_preserved"));
        assert!(result.get::<_, bool>("unpublished"));
        assert_eq!(result.get::<_, i64>("reserved_bytes"), 0);
        assert_eq!(result.get::<_, i64>("pending_uploads"), 0);
        assert_eq!(
            super::finalize_file_upload_record(&db, &upload, &metadata, 900)
                .await
                .unwrap(),
            super::FileUploadFinalizeOutcome::StateChanged
        );
        db.execute("DELETE FROM users WHERE id=$1", &[&owner])
            .await
            .unwrap();
        db.execute(
            "DELETE FROM storage_deletion_jobs WHERE object_key=$1",
            &[&object],
        )
        .await
        .unwrap();
    }

    #[actix_web::test]
    #[ignore = "requires isolated PostgreSQL with the current migration chain"]
    async fn completion_claim_skips_fenced_and_locked_owners_but_claims_siblings() {
        use crate::config::Config;
        use crate::db::{Database, DatabasePoolSettings, PoolRole};
        use crate::observability::Metrics;

        let cursor = super::UploadClaimCursor::new(None);
        let config = Config::from_env().unwrap();
        let db = Database::create(
            &config.database_url,
            DatabasePoolSettings {
                role: PoolRole::Maintenance,
                max_size: 4,
                min_size: 1,
                checkout_queue_capacity: 8,
                wait_timeout: Duration::from_secs(2),
                max_lifetime: Duration::from_secs(1800),
                lifetime_jitter: Duration::ZERO,
            },
            Metrics::new(&config),
        )
        .await
        .unwrap();
        let owners = vec![
            "usr_completion_claim_a".to_owned(),
            "usr_completion_claim_b".to_owned(),
            "usr_completion_claim_c".to_owned(),
            "usr_completion_claim_d".to_owned(),
        ];
        db.execute("DELETE FROM users WHERE id = ANY($1)", &[&owners])
            .await
            .unwrap();
        db.execute("INSERT INTO users(id,username,password_hash,role) SELECT id,id,'unused','user' FROM unnest($1::text[]) AS t(id)", &[&owners]).await.unwrap();
        db.execute("INSERT INTO files(id,owner_id,original_name,storage_name,entry_type,state,size_bytes)
            VALUES ('fil_completion_claim_root','usr_completion_claim_a','root','root','folder','active',0),
            ('fil_completion_claim_sibling','usr_completion_claim_a','sibling','sibling','folder','active',0)", &[]).await.unwrap();
        db.execute("INSERT INTO file_uploads(id,file_id,owner_id,parent_id,original_name,object_key,size_bytes,upload_mode,status,expires_at,completion_available_at)
            VALUES ('upload_claim_fenced','fil_claim_future_a','usr_completion_claim_a','fil_completion_claim_root','a','claim/a',1,'single','completing',now()+interval '1 hour',now()-interval '10 minutes'),
            ('upload_claim_sibling','fil_claim_future_b','usr_completion_claim_a','fil_completion_claim_sibling','b','claim/b',1,'single','completing',now()+interval '1 hour',now()-interval '9 minutes'),
            ('upload_claim_other','fil_claim_future_c','usr_completion_claim_b',NULL,'c','claim/c',1,'single','completing',now()+interval '1 hour',now()-interval '8 minutes'),
            ('upload_claim_advisory','fil_claim_future_d','usr_completion_claim_c',NULL,'d','claim/d',1,'single','completing',now()+interval '1 hour',now()-interval '11 minutes'),
            ('upload_claim_owner_row','fil_claim_future_e','usr_completion_claim_d',NULL,'e','claim/e',1,'single','completing',now()+interval '1 hour',now()-interval '12 minutes')", &[]).await.unwrap();
        db.execute("INSERT INTO file_uploads(id,file_id,owner_id,parent_id,original_name,object_key,size_bytes,upload_mode,status,expires_at,completion_available_at)
            SELECT 'upload_claim_prefix_'||n, 'fil_claim_prefix_'||n, 'usr_completion_claim_a',
              'fil_completion_claim_root', 'prefix_'||n, 'claim/prefix/'||n, 1, 'single', 'completing',
              now()+interval '1 hour', now()-interval '20 minutes'
            FROM generate_series(1,125) AS t(n)", &[]).await.unwrap();
        db.execute("INSERT INTO tree_operation_jobs(owner_id,root_id,action) VALUES('usr_completion_claim_a','fil_completion_claim_root','trash')", &[]).await.unwrap();
        let mut advisory_client = db.get().await.unwrap();
        let advisory = advisory_client.transaction().await.unwrap();
        advisory.query_one("SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:tree-operation:usr_completion_claim_c',0))", &[]).await.unwrap();
        let mut owner_client = db.get().await.unwrap();
        let owner_lock = owner_client.transaction().await.unwrap();
        owner_lock.query_one("SELECT version FROM tree_operation_owners WHERE owner_id='usr_completion_claim_d' FOR UPDATE", &[]).await.unwrap();

        let prefix = tokio::time::timeout(
            Duration::from_secs(2),
            super::claim_file_upload_completions(&db, 25, &cursor),
        )
        .await
        .expect("one turn must bound its work on a large fenced prefix")
        .unwrap();
        assert!(prefix.is_empty());
        assert!(
            cursor
                .lock()
                .await
                .as_ref()
                .is_some_and(|(_, id, _)| id.starts_with("upload_claim_prefix_")),
            "a bounded turn must preserve its seek position for the next call"
        );
        let records = tokio::time::timeout(
            Duration::from_secs(2),
            super::claim_file_upload_completions(&db, 25, &cursor),
        )
        .await
        .expect("busy owner publication and owner rows must not block other claims")
        .expect("a fenced upload must not abort its peers with SQLSTATE 55000");
        let mut ids = records
            .iter()
            .map(|record| record.id.as_str())
            .collect::<Vec<_>>();
        ids.sort();
        assert_eq!(ids, vec!["upload_claim_other", "upload_claim_sibling"]);
        assert!(
            records
                .iter()
                .all(|record| !record.completion_lease_token.is_empty())
        );
        let unclaimed: i64 = db.query_one("SELECT count(*) FROM file_uploads WHERE id IN ('upload_claim_fenced','upload_claim_advisory','upload_claim_owner_row') AND completion_lease_token IS NULL AND completion_locked_until IS NULL", &[]).await.unwrap().get(0);
        assert_eq!(unclaimed, 3);
        advisory.rollback().await.unwrap();
        owner_lock.rollback().await.unwrap();
        drop(advisory_client);
        drop(owner_client);
        let mut released = Vec::new();
        for _ in 0..2 {
            released.extend(
                super::claim_file_upload_completions(&db, 25, &cursor)
                    .await
                    .unwrap()
                    .into_iter()
                    .map(|record| record.id),
            );
        }
        released.sort();
        assert_eq!(
            released,
            vec!["upload_claim_advisory", "upload_claim_owner_row"]
        );
        // A cursor must also make progress when raw queue rows themselves are
        // locked, so skipping their UPDATE cannot move their due timestamps.
        db.execute("UPDATE tree_operation_jobs SET status='complete', completed_at=now() WHERE owner_id='usr_completion_claim_a'", &[]).await.unwrap();
        let mut rows_client = db.get().await.unwrap();
        let rows_lock = rows_client.transaction().await.unwrap();
        rows_lock
            .query(
                "SELECT id FROM file_uploads WHERE id LIKE 'upload_claim_prefix_%' FOR UPDATE",
                &[],
            )
            .await
            .unwrap();
        *cursor.lock().await = None;
        assert!(
            tokio::time::timeout(
                Duration::from_secs(2),
                super::claim_file_upload_completions(&db, 25, &cursor)
            )
            .await
            .expect("upload row locks must be skipped")
            .unwrap()
            .is_empty()
        );
        let after_locked_prefix = tokio::time::timeout(
            Duration::from_secs(2),
            super::claim_file_upload_completions(&db, 25, &cursor),
        )
        .await
        .expect("the next bounded turn must seek beyond locked rows")
        .unwrap();
        assert_eq!(
            after_locked_prefix
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec!["upload_claim_fenced"]
        );
        rows_lock.rollback().await.unwrap();
        drop(rows_client);
        db.execute("DELETE FROM users WHERE id = ANY($1)", &[&owners])
            .await
            .unwrap();
    }

    #[actix_web::test]
    #[ignore = "requires isolated PostgreSQL with the current migration chain"]
    async fn completion_claim_revisits_unfenced_work_under_continuous_arrivals() {
        use crate::config::Config;
        use crate::db::{Database, DatabasePoolSettings, PoolRole};
        use crate::observability::Metrics;

        let config = Config::from_env().unwrap();
        let db = Database::create(
            &config.database_url,
            DatabasePoolSettings {
                role: PoolRole::Maintenance,
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
        let owners = vec![
            "usr_completion_arrival_a".to_owned(),
            "usr_completion_arrival_b".to_owned(),
        ];
        db.execute("DELETE FROM users WHERE id = ANY($1)", &[&owners])
            .await
            .unwrap();
        db.execute("INSERT INTO users(id,username,password_hash,role) SELECT id,id,'unused','user' FROM unnest($1::text[]) AS t(id)", &[&owners]).await.unwrap();
        db.execute("INSERT INTO files(id,owner_id,original_name,storage_name,entry_type,state,size_bytes) VALUES('fil_completion_arrival_root','usr_completion_arrival_a','root','root','folder','active',0)", &[]).await.unwrap();
        db.execute("INSERT INTO file_uploads(id,file_id,owner_id,parent_id,original_name,object_key,size_bytes,upload_mode,status,expires_at,completion_available_at)
            VALUES('upload_arrival_old','fil_arrival_old','usr_completion_arrival_a','fil_completion_arrival_root','old','arrival/old',1,'single','completing',now()+interval '1 hour',now()-interval '1 hour')", &[]).await.unwrap();
        db.execute("INSERT INTO tree_operation_jobs(owner_id,root_id,action) VALUES('usr_completion_arrival_a','fil_completion_arrival_root','trash')", &[]).await.unwrap();
        let arrival_sql = "INSERT INTO file_uploads(id,file_id,owner_id,original_name,object_key,size_bytes,upload_mode,status,expires_at,completion_available_at)
            SELECT 'upload_arrival_'||$1::text||'_'||n, 'fil_arrival_'||$1::text||'_'||n,
              'usr_completion_arrival_b', 'healthy', 'arrival/'||$1::text||'/'||n,
              1, 'single', 'completing', now()+interval '1 hour', clock_timestamp()
            FROM generate_series(1,25) AS t(n)";
        db.execute(arrival_sql, &[&"initial"]).await.unwrap();
        let cursor = super::UploadClaimCursor::new(None);
        let first = super::claim_file_upload_completions(&db, 25, &cursor)
            .await
            .unwrap();
        assert_eq!(first.len(), 25);
        assert!(first.iter().all(|row| row.id != "upload_arrival_old"));
        assert!(
            cursor.lock().await.is_some(),
            "a full batch retains the sweep position"
        );
        db.execute("UPDATE tree_operation_jobs SET status='complete',completed_at=now() WHERE owner_id='usr_completion_arrival_a'", &[]).await.unwrap();
        let mut revisited = false;
        for tick in 0..3 {
            db.execute(arrival_sql, &[&tick.to_string()]).await.unwrap();
            let rows = super::claim_file_upload_completions(&db, 25, &cursor)
                .await
                .unwrap();
            if rows.iter().any(|row| row.id == "upload_arrival_old") {
                revisited = true;
                break;
            }
        }
        assert!(
            revisited,
            "fresh due arrivals must not indefinitely hide older work behind the cursor"
        );
        db.execute("DELETE FROM users WHERE id = ANY($1)", &[&owners])
            .await
            .unwrap();
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
        assert!(super::FILE_UPLOAD_CLEANUP_QUERY.contains("SET status = 'aborted'"));
        assert!(transition.contains("FILE_UPLOAD_CLEANUP_QUERY"));
        assert!(super::FILE_UPLOAD_CLEANUP_QUERY.contains("INSERT INTO storage_deletion_jobs"));

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
