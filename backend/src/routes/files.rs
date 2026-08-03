use actix_web::http::header::{
    ACCEPT, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, LOCATION,
};
use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use tokio::fs::File as AsyncFile;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::auth::{AuthUser, require_csrf, require_user};
use crate::state::AppState;
use crate::storage::{ObjectMetadata, UploadedPart};

const MAX_UPLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DEFAULT_PAGE_SIZE: usize = 50;
const MAX_PAGE_SIZE: usize = 100;

#[derive(Deserialize)]
pub(crate) struct FilesQuery {
    view: Option<String>,
    folder: Option<String>,
    sort: Option<String>,
    direction: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadInitRequest {
    name: String,
    relative_path: String,
    size_bytes: u64,
    mime_type: Option<String>,
    parent_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadCompleteRequest {
    parts: Vec<CompletedUploadPart>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompletedUploadPart {
    part_number: i32,
    etag: String,
    checksum_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadChecksumRequest {
    checksum_sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadInitResponse {
    upload_id: String,
    mode: String,
    upload_url: Option<String>,
    existing_parts: Vec<crate::storage::UploadPartPlan>,
    part_size_bytes: Option<u64>,
    content_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadUrlResponse {
    url: String,
    content_length: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadCompleteResponse {
    status: String,
    file_id: String,
    location: String,
    poll_url: String,
    retry_after_seconds: u64,
}

#[derive(Deserialize)]
pub(crate) struct ShareForm {
    username: String,
    csrf_token: String,
}

#[derive(Deserialize)]
pub(crate) struct UnshareForm {
    recipient_id: Option<String>,
    csrf_token: String,
}

#[derive(Deserialize)]
pub(crate) struct CsrfForm {
    csrf_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FavoriteResponse {
    favorite: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareResponse {
    recipient_username: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileMutationResponse {
    status: &'static str,
    file_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesResponse {
    view: String,
    entries: Vec<FileEntry>,
    current_folder_id: Option<String>,
    breadcrumbs: Vec<FolderBreadcrumb>,
    summary: FilesSummary,
    storage: StorageStats,
    next_cursor: Option<String>,
    has_more: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesSummary {
    total_files: i64,
    total_folders: i64,
    active_files: i64,
    trashed_files: i64,
    favorite_files: i64,
    shared_files: i64,
    used_bytes: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderBreadcrumb {
    id: String,
    name: String,
    e2ee_state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    id: String,
    name: String,
    kind: String,
    entry_type: String,
    parent_id: Option<String>,
    size_bytes: i64,
    state: String,
    favorite: bool,
    owner_username: Option<String>,
    shared: bool,
    shared_at: Option<String>,
    created_at: String,
    updated_at: String,
    trashed_at: Option<String>,
    e2ee_state: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    storage_path: String,
    total_bytes: u64,
    available_bytes: u64,
    system_used_bytes: u64,
    aeralyth_used_bytes: u64,
}

struct StoredFile {
    id: String,
    owner_id: String,
    original_name: String,
    storage_name: String,
    mime_type: Option<String>,
}

struct UploadRecord {
    id: String,
    file_id: String,
    owner_id: String,
    parent_id: Option<String>,
    original_name: String,
    object_key: String,
    mime_type: Option<String>,
    size_bytes: i64,
    mode: String,
    part_size_bytes: Option<i64>,
    multipart_upload_id: Option<String>,
    status: String,
    checksum_sha256: Option<String>,
}

struct FilePage {
    entries: Vec<FileEntry>,
    next_cursor: Option<String>,
    has_more: bool,
}

struct ListedFile {
    entry: FileEntry,
    rank: i32,
    cursor_name: String,
    cursor_date: String,
}

#[derive(Deserialize, Serialize)]
struct FileCursor {
    view: String,
    folder_id: Option<String>,
    sort: String,
    direction: String,
    rank: i32,
    name: String,
    size: i64,
    date: String,
    id: String,
}

pub async fn list_files(
    state: web::Data<AppState>,
    request: HttpRequest,
    query: web::Query<FilesQuery>,
) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;

    let view = normalize_view(query.view.as_deref());
    let sort = normalize_sort(query.sort.as_deref()).or(Some(if view == "files" {
        "name"
    } else {
        "updated"
    }));
    let direction = normalize_sort_direction(query.direction.as_deref(), sort);
    let current_folder_id = match view {
        "files" => validate_folder(&state, &user, query.folder.as_deref()).await?,
        "shared" => validate_shared_folder(&state, &user, query.folder.as_deref()).await?,
        _ => None,
    };
    let breadcrumbs = if view == "shared" {
        get_shared_breadcrumbs(&state, &user, current_folder_id.as_deref()).await?
    } else {
        get_breadcrumbs(&state, &user, current_folder_id.as_deref()).await?
    };
    let page_size = query
        .limit
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);
    let page = list_entries(
        &state,
        &user,
        view,
        current_folder_id.as_deref(),
        sort,
        direction,
        query.cursor.as_deref(),
        page_size,
    )
    .await?;
    let summary = get_summary(&state, &user).await?;
    let storage = storage_stats(&state, summary.used_bytes);

    Ok(HttpResponse::Ok().json(FilesResponse {
        view: view.to_owned(),
        entries: page.entries,
        current_folder_id,
        breadcrumbs,
        summary,
        storage,
        next_cursor: page.next_cursor,
        has_more: page.has_more,
    }))
}

pub async fn storage(state: web::Data<AppState>, request: HttpRequest) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
    let summary = get_summary(&state, &user).await?;

    Ok(HttpResponse::Ok().json(storage_stats(&state, summary.used_bytes)))
}

pub async fn init_upload(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Json<UploadInitRequest>,
) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
    require_header_csrf(&state, &request).await?;

    if state.config.e2ee_mode.is_enabled() {
        return Ok(HttpResponse::Conflict()
            .body("plaintext uploads are disabled; use the encrypted vault upload API"));
    }

    if body.size_bytes > MAX_UPLOAD_BYTES {
        return Err(error::ErrorPayloadTooLarge("file exceeds the 2 GB limit"));
    }

    let upload_path = sanitize_upload_path(if body.relative_path.trim().is_empty() {
        &body.name
    } else {
        &body.relative_path
    });
    let Some((display_name, folder_names)) = upload_path.split_last() else {
        return Err(error::ErrorBadRequest("invalid upload path"));
    };
    let mut parent_id = validate_folder(&state, &user, body.parent_id.as_deref()).await?;

    for folder_name in folder_names {
        parent_id = Some(ensure_folder(&state, &user, parent_id.as_deref(), folder_name).await?);
    }

    let mime_type = body
        .mime_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(255).collect::<String>());
    let content_type = mime_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    let size_bytes = i64::try_from(body.size_bytes)
        .map_err(|_| error::ErrorPayloadTooLarge("file exceeds the size limit"))?;

    if let Some(existing) = find_resumable_upload(
        &state,
        &user,
        parent_id.as_deref(),
        display_name,
        &mime_type,
        size_bytes,
    )
    .await?
    {
        if existing.status == "initializing" {
            return Ok(HttpResponse::Conflict()
                .body("a matching upload is still being initialized; retry shortly"));
        }
        if existing.status == "completing" {
            return Ok(
                HttpResponse::Conflict().body("a matching upload is already being finalized")
            );
        }

        let existing_parts =
            if let Some(multipart_upload_id) = existing.multipart_upload_id.as_deref() {
                state
                    .storage
                    .uploaded_parts(&existing.object_key, multipart_upload_id)
                    .await
                    .map_err(error::ErrorBadGateway)?
            } else {
                Vec::new()
            };

        let part_size_bytes = if existing.mode == "multipart" {
            Some(upload_part_size(&existing)?)
        } else {
            None
        };

        return Ok(HttpResponse::Ok().json(UploadInitResponse {
            upload_id: existing.id.clone(),
            mode: existing.mode.clone(),
            upload_url: (existing.mode == "local")
                .then(|| format!("/api/files/uploads/{}/content", existing.id)),
            existing_parts,
            part_size_bytes,
            content_type,
        }));
    }

    let reserved_bytes = current_reserved_bytes(&state, &user).await?;
    let requested_total = reserved_bytes
        .checked_add(body.size_bytes)
        .ok_or_else(|| error::ErrorPayloadTooLarge("storage quota exceeded"))?;

    if requested_total > state.config.storage_quota_bytes {
        return Err(error::ErrorPayloadTooLarge("storage quota exceeded"));
    }

    let upload_id = format!("upl_{}", create_storage_name()?);
    let file_id = format!("fil_{}", create_storage_name()?);
    let object_key = format!(
        "users/{}/files/{}/{}",
        user.id,
        file_id,
        create_storage_name()?
    );
    let upload_mode = state.storage.upload_mode(body.size_bytes).to_owned();
    let part_size_bytes = if upload_mode == "multipart" {
        Some(
            i64::try_from(state.config.storage_multipart_part_bytes)
                .map_err(|_| error::ErrorInternalServerError("invalid multipart part size"))?,
        )
    } else {
        None
    };
    let mut client = match state.db.get().await {
        Ok(client) => client,
        Err(database_error) => return Err(error::ErrorInternalServerError(database_error)),
    };
    let transaction = match client.transaction().await {
        Ok(transaction) => transaction,
        Err(database_error) => return Err(error::ErrorInternalServerError(database_error)),
    };
    let counter = match transaction
        .query_one(
            "SELECT used_bytes FROM user_file_counters WHERE owner_id = $1 FOR UPDATE",
            &[&user.id],
        )
        .await
    {
        Ok(counter) => counter,
        Err(database_error) => return Err(error::ErrorInternalServerError(database_error)),
    };
    let pending = match transaction
        .query_one(
            "
                SELECT
                  COALESCE(sum(size_bytes), 0)::bigint AS pending_bytes,
                  count(*)::bigint AS pending_uploads
                FROM file_uploads
                WHERE owner_id = $1
                  AND (
                    (status IN ('initializing', 'pending', 'completing') AND expires_at > now())
                    OR status = 'aborting'
                  )
            ",
            &[&user.id],
        )
        .await
    {
        Ok(pending) => pending,
        Err(database_error) => return Err(error::ErrorInternalServerError(database_error)),
    };
    let used_bytes: i64 = counter.get("used_bytes");
    let pending_bytes: i64 = pending.get("pending_bytes");
    let reserved_bytes = used_bytes.saturating_add(pending_bytes);
    let pending_uploads: i64 = pending.get("pending_uploads");
    let quota_exceeded = u64::try_from(reserved_bytes)
        .ok()
        .and_then(|reserved| reserved.checked_add(body.size_bytes))
        .is_none_or(|reserved| reserved > state.config.storage_quota_bytes);

    if quota_exceeded || pending_uploads >= 20 {
        return if quota_exceeded {
            Err(error::ErrorPayloadTooLarge("storage quota exceeded"))
        } else {
            Err(error::ErrorTooManyRequests("too many uploads are pending"))
        };
    }

    let insert_result = transaction
        .execute(
            "
                INSERT INTO file_uploads (
                  id,
                  file_id,
                  owner_id,
                  parent_id,
                  original_name,
                  object_key,
                  mime_type,
                  size_bytes,
                  upload_mode,
                  part_size_bytes,
                  multipart_upload_id,
                  status,
                  expires_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, 'initializing', now() + interval '24 hours')
            ",
            &[
                &upload_id,
                &file_id,
                &user.id,
                &parent_id,
                &display_name,
                &object_key,
                &mime_type,
                &size_bytes,
                &upload_mode,
                &part_size_bytes,
            ],
        )
        .await;

    if let Err(database_error) = insert_result {
        return Err(error::ErrorInternalServerError(database_error));
    }
    if let Err(commit_error) = transaction.commit().await {
        match state
            .db
            .query_opt(
                "SELECT id FROM file_uploads WHERE id = $1 AND owner_id = $2 LIMIT 1",
                &[&upload_id, &user.id],
            )
            .await
        {
            Ok(Some(_)) => {
                log::warn!(
                    "upload reservation commit returned an error but the row is durable: {commit_error}"
                );
            }
            Ok(None) => {
                return Err(error::ErrorInternalServerError(commit_error));
            }
            Err(reconciliation_error) => {
                log::error!(
                    "could not reconcile ambiguous upload reservation {upload_id}: {reconciliation_error}"
                );
                return Err(error::ErrorInternalServerError(commit_error));
            }
        }
    }

    let prepared = match state
        .storage
        .prepare_upload(
            &upload_id,
            &object_key,
            Some(&content_type),
            body.size_bytes,
        )
        .await
    {
        Ok(prepared) => prepared,
        Err(storage_error) => {
            let grace_seconds =
                i64::try_from(state.config.storage_multipart_orphan_grace_seconds).unwrap_or(3_600);
            let _ = state
                .db
                .execute(
                    "UPDATE file_uploads SET expires_at = now() + ($1::bigint * interval '1 second') WHERE id = $2 AND owner_id = $3 AND status = 'initializing'",
                    &[&grace_seconds, &upload_id, &user.id],
                )
                .await;
            return Err(error::ErrorBadGateway(storage_error));
        }
    };

    let prepared_part_size_bytes = prepared
        .part_size_bytes
        .and_then(|value| i64::try_from(value).ok());

    if prepared.mode != upload_mode || prepared_part_size_bytes != part_size_bytes {
        log::error!(
            "storage upload plan changed while initializing {upload_id}: expected {upload_mode}/{part_size_bytes:?}, got {}/{prepared_part_size_bytes:?}",
            prepared.mode,
        );
        let _ = enqueue_upload_cleanup(
            &state,
            &upload_id,
            &user.id,
            &object_key,
            prepared.multipart_upload_id.as_deref(),
            &["initializing"],
        )
        .await;
        return Err(error::ErrorInternalServerError(
            "storage upload plan changed during initialization",
        ));
    }

    let activated = state
        .db
        .execute(
            "UPDATE file_uploads SET multipart_upload_id = $1, status = 'pending', expires_at = now() + interval '24 hours' WHERE id = $2 AND owner_id = $3 AND status = 'initializing'",
            &[&prepared.multipart_upload_id, &upload_id, &user.id],
        )
        .await;

    match activated {
        Ok(1) => {}
        Ok(_) => {
            let _ = enqueue_upload_cleanup(
                &state,
                &upload_id,
                &user.id,
                &object_key,
                prepared.multipart_upload_id.as_deref(),
                &["initializing"],
            )
            .await;
            return Ok(HttpResponse::Conflict().body("upload initialization was canceled"));
        }
        Err(database_error) => {
            log::error!("could not persist provider upload id for {upload_id}: {database_error}");
            let _ = enqueue_upload_cleanup(
                &state,
                &upload_id,
                &user.id,
                &object_key,
                prepared.multipart_upload_id.as_deref(),
                &["initializing"],
            )
            .await;
            return Err(error::ErrorInternalServerError(database_error));
        }
    }

    Ok(HttpResponse::Created().json(UploadInitResponse {
        upload_id,
        mode: prepared.mode.to_owned(),
        upload_url: prepared.upload_url,
        existing_parts: prepared.parts,
        part_size_bytes: part_size_bytes.and_then(|value| u64::try_from(value).ok()),
        content_type,
    }))
}

pub async fn upload_content(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    mut payload: web::Payload,
) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let Some(upload) = get_upload(&state, &user, &path.into_inner()).await? else {
        return Ok(HttpResponse::NotFound().finish());
    };

    if upload.mode != "local" || upload.status != "pending" {
        return Ok(HttpResponse::Conflict().finish());
    }

    let object_path = state
        .storage
        .local_path(&upload.object_key)
        .ok_or_else(|| error::ErrorNotFound("local upload unavailable"))?;
    let parent = object_path
        .parent()
        .ok_or_else(|| error::ErrorInternalServerError("invalid local object path"))?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(error::ErrorInternalServerError)?;
    let temporary_path = object_path.with_extension(format!("part-{}", upload.id));
    let mut file = AsyncFile::create(&temporary_path)
        .await
        .map_err(error::ErrorInternalServerError)?;
    let expected_bytes = u64::try_from(upload.size_bytes)
        .map_err(|_| error::ErrorInternalServerError("invalid upload size"))?;
    let mut written_bytes = 0_u64;

    while let Some(chunk) = payload.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(payload_error) => {
                drop(file);
                let _ = tokio::fs::remove_file(&temporary_path).await;
                return Err(error::ErrorBadRequest(payload_error));
            }
        };
        written_bytes = written_bytes
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| error::ErrorPayloadTooLarge("upload is too large"))?;

        if written_bytes > expected_bytes || written_bytes > MAX_UPLOAD_BYTES {
            drop(file);
            let _ = tokio::fs::remove_file(&temporary_path).await;
            return Err(error::ErrorPayloadTooLarge("upload is too large"));
        }

        if let Err(write_error) = file.write_all(&chunk).await {
            drop(file);
            let _ = tokio::fs::remove_file(&temporary_path).await;
            return Err(error::ErrorInternalServerError(write_error));
        }
    }

    if let Err(flush_error) = file.flush().await {
        drop(file);
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error::ErrorInternalServerError(flush_error));
    }
    drop(file);

    if written_bytes != expected_bytes {
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error::ErrorBadRequest(
            "uploaded byte count does not match declaration",
        ));
    }

    if let Err(rename_error) = tokio::fs::rename(&temporary_path, &object_path).await {
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error::ErrorInternalServerError(rename_error));
    }

    Ok(HttpResponse::NoContent().finish())
}

pub async fn presign_upload_content(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    body: web::Json<UploadChecksumRequest>,
) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let Some(upload) = get_upload(&state, &user, &path.into_inner()).await? else {
        return Ok(HttpResponse::NotFound().finish());
    };

    if upload.mode != "single" || upload.status != "pending" {
        return Ok(HttpResponse::Conflict().finish());
    }

    let checksum = validate_sha256_checksum(&body.checksum_sha256)?;
    let content_length = u64::try_from(upload.size_bytes)
        .map_err(|_| error::ErrorInternalServerError("invalid upload size"))?;
    let write_lifetime_seconds = i64::try_from(state.config.storage_presign_seconds)
        .ok()
        .and_then(|seconds| seconds.checked_add(60))
        .ok_or_else(|| error::ErrorInternalServerError("invalid upload signature lifetime"))?;
    let checksum_reserved = state
        .db
        .execute(
            "UPDATE file_uploads SET checksum_sha256 = $1, write_expires_at = GREATEST(COALESCE(write_expires_at, now()), now() + ($4::bigint * interval '1 second')) WHERE id = $2 AND owner_id = $3 AND status = 'pending' AND (checksum_sha256 IS NULL OR checksum_sha256 = $1)",
            &[&checksum, &upload.id, &user.id, &write_lifetime_seconds],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    if checksum_reserved != 1 {
        return Ok(HttpResponse::Conflict().body("upload checksum changed"));
    }
    let content_type = upload
        .mime_type
        .as_deref()
        .unwrap_or("application/octet-stream");
    let url = state
        .storage
        .presign_single_upload(&upload.object_key, content_type, &checksum, content_length)
        .await
        .map_err(error::ErrorBadGateway)?;

    Ok(HttpResponse::Ok().json(UploadUrlResponse {
        url,
        content_length,
    }))
}

pub async fn presign_upload_part(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<(String, i32)>,
    body: web::Json<UploadChecksumRequest>,
) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let (upload_id, part_number) = path.into_inner();
    let Some(upload) = get_upload(&state, &user, &upload_id).await? else {
        return Ok(HttpResponse::NotFound().finish());
    };

    if upload.mode != "multipart" || upload.status != "pending" {
        return Ok(HttpResponse::Conflict().finish());
    }

    let size_bytes = u64::try_from(upload.size_bytes)
        .map_err(|_| error::ErrorInternalServerError("invalid upload size"))?;
    let part_size_bytes = upload_part_size(&upload)?;
    let part_count = size_bytes.div_ceil(part_size_bytes);
    let part_number_u64 =
        u64::try_from(part_number).map_err(|_| error::ErrorBadRequest("invalid upload part"))?;

    if part_number_u64 == 0 || part_number_u64 > part_count {
        return Err(error::ErrorBadRequest("invalid upload part"));
    }
    let part_offset = (part_number_u64 - 1)
        .checked_mul(part_size_bytes)
        .ok_or_else(|| error::ErrorBadRequest("invalid upload part"))?;
    let content_length = size_bytes
        .checked_sub(part_offset)
        .map(|remaining| remaining.min(part_size_bytes))
        .filter(|length| *length > 0)
        .ok_or_else(|| error::ErrorBadRequest("invalid upload part"))?;

    let checksum = validate_sha256_checksum(&body.checksum_sha256)?;
    let multipart_upload_id = upload
        .multipart_upload_id
        .as_deref()
        .ok_or_else(|| error::ErrorInternalServerError("multipart upload id missing"))?;
    let url = state
        .storage
        .presign_upload_part(
            &upload.object_key,
            multipart_upload_id,
            part_number,
            &checksum,
            content_length,
        )
        .await
        .map_err(error::ErrorBadGateway)?;

    Ok(HttpResponse::Ok().json(UploadUrlResponse {
        url,
        content_length,
    }))
}

pub async fn complete_upload(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    body: web::Json<UploadCompleteRequest>,
) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let Some(upload) = get_upload(&state, &user, &path.into_inner()).await? else {
        return Ok(HttpResponse::NotFound().finish());
    };
    if upload.status == "completed" {
        return Ok(HttpResponse::Ok().json(upload_complete_response(&upload, "completed")));
    }

    if upload.status == "completing" {
        return reconcile_completing_upload_response(&state, &upload).await;
    }

    if upload.status != "pending" {
        return Ok(HttpResponse::Conflict().finish());
    }

    let expected_size = u64::try_from(upload.size_bytes)
        .map_err(|_| error::ErrorInternalServerError("invalid upload size"))?;
    let mut completed_parts = Vec::new();

    if upload.mode == "multipart" {
        let expected_part_count = expected_size.div_ceil(upload_part_size(&upload)?);

        if body.parts.is_empty()
            || body.parts.len() > 10_000
            || u64::try_from(body.parts.len()).ok() != Some(expected_part_count)
        {
            return Err(error::ErrorBadRequest("multipart parts are invalid"));
        }

        for part in &body.parts {
            completed_parts.push(UploadedPart {
                part_number: part.part_number,
                etag: part.etag.trim().to_owned(),
                checksum_sha256: validate_sha256_checksum(&part.checksum_sha256)?,
            });
        }
        completed_parts.sort_by_key(|part| part.part_number);

        if completed_parts.iter().enumerate().any(|(index, part)| {
            part.part_number != i32::try_from(index + 1).unwrap_or(-1) || part.etag.is_empty()
        }) || completed_parts
            .windows(2)
            .any(|parts| parts[0].part_number == parts[1].part_number)
        {
            return Err(error::ErrorBadRequest("multipart parts are invalid"));
        }
    } else if !body.parts.is_empty() {
        return Err(error::ErrorBadRequest("upload parts are not expected"));
    }

    let claimed = state
        .db
        .execute(
            "
                UPDATE file_uploads
                SET status = 'completing', expires_at = now() + interval '5 minutes'
                WHERE id = $1 AND owner_id = $2 AND status = 'pending'
            ",
            &[&upload.id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    if claimed == 0 {
        let Some(current) = get_upload(&state, &user, &upload.id).await? else {
            return Ok(HttpResponse::NotFound().finish());
        };

        return if current.status == "completed" {
            Ok(HttpResponse::Ok().json(upload_complete_response(&current, "completed")))
        } else if current.status == "completing" {
            reconcile_completing_upload_response(&state, &current).await
        } else {
            Ok(HttpResponse::Conflict().json(upload_complete_response(&current, &current.status)))
        };
    }

    let mut metadata = None;

    if upload.mode == "multipart" {
        let multipart_upload_id = upload
            .multipart_upload_id
            .as_deref()
            .ok_or_else(|| error::ErrorInternalServerError("multipart upload id missing"))?;

        if let Err(complete_error) = state
            .storage
            .complete_multipart(&upload.object_key, multipart_upload_id, &completed_parts)
            .await
        {
            match state.storage.object_metadata(&upload.object_key).await {
                Ok(existing_metadata) => {
                    metadata = Some(existing_metadata);
                }
                Err(metadata_error) if metadata_error.is_not_found() => {
                    state
                        .db
                        .execute(
                            "UPDATE file_uploads SET status = 'pending', expires_at = now() + interval '24 hours' WHERE id = $1 AND owner_id = $2 AND status = 'completing'",
                            &[&upload.id, &user.id],
                        )
                        .await
                        .map_err(error::ErrorInternalServerError)?;
                    return Err(error::ErrorBadGateway(complete_error));
                }
                Err(metadata_error) => {
                    log::warn!(
                        "multipart completion for {} is uncertain and will be reconciled: {}",
                        upload.id,
                        complete_error
                    );
                    log::warn!(
                        "could not verify uncertain multipart completion {}: {}",
                        upload.id,
                        metadata_error
                    );
                    return Ok(HttpResponse::Accepted()
                        .json(upload_complete_response(&upload, "completing")));
                }
            }
        }
    }

    let metadata = match metadata {
        Some(metadata) => metadata,
        None => match state.storage.object_metadata(&upload.object_key).await {
            Ok(metadata) => metadata,
            Err(metadata_error) => {
                log::warn!(
                    "could not verify completing upload {}: {}",
                    upload.id,
                    metadata_error
                );
                return Ok(
                    HttpResponse::Accepted().json(upload_complete_response(&upload, "completing"))
                );
            }
        },
    };
    let checksum_mismatch = upload.mode == "single"
        && upload
            .checksum_sha256
            .as_deref()
            .is_none_or(|expected| metadata.checksum_sha256.as_deref() != Some(expected));

    if metadata.size_bytes != expected_size || checksum_mismatch {
        enqueue_upload_cleanup(
            &state,
            &upload.id,
            &user.id,
            &upload.object_key,
            upload.multipart_upload_id.as_deref(),
            &["completing"],
        )
        .await?;
        return Err(error::ErrorBadRequest(
            "uploaded object integrity check failed",
        ));
    }

    finalize_upload_record(&state, &upload, &metadata).await?;

    Ok(HttpResponse::Created().json(upload_complete_response(&upload, "completed")))
}

pub async fn upload_status(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
    let Some(upload) = get_upload(&state, &user, &path.into_inner()).await? else {
        return Ok(HttpResponse::NotFound().finish());
    };

    if upload.status == "completing" {
        return reconcile_completing_upload_response(&state, &upload).await;
    }

    let response = upload_complete_response(&upload, &upload.status);

    match upload.status.as_str() {
        "completed" | "pending" | "initializing" => Ok(HttpResponse::Ok().json(response)),
        "aborting" | "aborted" => Ok(HttpResponse::Conflict().json(response)),
        _ => Ok(HttpResponse::Conflict().finish()),
    }
}

async fn reconcile_completing_upload_response(
    state: &AppState,
    upload: &UploadRecord,
) -> Result<HttpResponse> {
    let metadata = match state.storage.object_metadata(&upload.object_key).await {
        Ok(metadata) => metadata,
        Err(metadata_error) => {
            if !metadata_error.is_not_found() {
                log::warn!(
                    "could not poll completing upload {}: {}",
                    upload.id,
                    metadata_error
                );
            }
            return Ok(
                HttpResponse::Accepted().json(upload_complete_response(upload, "completing"))
            );
        }
    };
    let expected_size = u64::try_from(upload.size_bytes)
        .map_err(|_| error::ErrorInternalServerError("invalid upload size"))?;
    let checksum_mismatch = upload.mode == "single"
        && upload
            .checksum_sha256
            .as_deref()
            .is_none_or(|expected| metadata.checksum_sha256.as_deref() != Some(expected));

    if metadata.size_bytes != expected_size || checksum_mismatch {
        enqueue_upload_cleanup(
            state,
            &upload.id,
            &upload.owner_id,
            &upload.object_key,
            upload.multipart_upload_id.as_deref(),
            &["completing"],
        )
        .await?;
        return Ok(HttpResponse::Conflict().json(upload_complete_response(upload, "aborting")));
    }

    finalize_upload_record(state, upload, &metadata).await?;

    Ok(HttpResponse::Ok().json(upload_complete_response(upload, "completed")))
}

async fn finalize_upload_record(
    state: &AppState,
    upload: &UploadRecord,
    metadata: &ObjectMetadata,
) -> Result<()> {
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let current = transaction
        .query_opt(
            "SELECT status FROM file_uploads WHERE id = $1 AND owner_id = $2 FOR UPDATE",
            &[&upload.id, &upload.owner_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(current) = current else {
        return Err(error::ErrorNotFound("upload no longer exists"));
    };
    let current_status: String = current.get("status");

    if current_status == "completed" {
        transaction
            .commit()
            .await
            .map_err(error::ErrorInternalServerError)?;
        return Ok(());
    }
    if current_status != "completing" {
        return Err(error::ErrorConflict("upload is no longer completing"));
    }

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
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute(
            "UPDATE file_uploads SET status = 'completed', completed_at = now() WHERE id = $1 AND owner_id = $2 AND status = 'completing'",
            &[&upload.id, &upload.owner_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(())
}

fn upload_complete_response(upload: &UploadRecord, status: &str) -> UploadCompleteResponse {
    UploadCompleteResponse {
        status: status.to_owned(),
        file_id: upload.file_id.clone(),
        location: upload_redirect_location(upload.parent_id.as_deref(), "uploaded"),
        poll_url: format!("/api/files/uploads/{}/status", upload.id),
        retry_after_seconds: 2,
    }
}

pub async fn abort_upload(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let Some(upload) = get_upload(&state, &user, &path.into_inner()).await? else {
        return Ok(HttpResponse::NoContent().finish());
    };

    if matches!(upload.status.as_str(), "initializing" | "pending") {
        enqueue_upload_cleanup(
            &state,
            &upload.id,
            &user.id,
            &upload.object_key,
            upload.multipart_upload_id.as_deref(),
            &["initializing", "pending"],
        )
        .await?;
        if let Some(object_path) = state.storage.local_path(&upload.object_key) {
            let temporary_path = object_path.with_extension(format!("part-{}", upload.id));
            let _ = tokio::fs::remove_file(temporary_path).await;
        }
    }

    Ok(HttpResponse::NoContent().finish())
}

pub async fn download(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
    let Some(file) = get_download_file(&state, &user, &path.into_inner()).await? else {
        return Ok(HttpResponse::NotFound().finish());
    };

    if let Some(download_url) = state
        .storage
        .download_url(&file.storage_name, &file.original_name)
        .await
        .map_err(error::ErrorBadGateway)?
    {
        return Ok(HttpResponse::Found()
            .insert_header((LOCATION, download_url))
            .finish());
    }

    let file_path = state
        .storage
        .local_path_for_owner(&file.storage_name, &file.owner_id)
        .ok_or_else(|| error::ErrorNotFound("stored object not found"))?;
    let stored_file = AsyncFile::open(file_path)
        .await
        .map_err(error::ErrorNotFound)?;
    let size_bytes = stored_file
        .metadata()
        .await
        .map_err(error::ErrorInternalServerError)?
        .len();
    let stream = stream::unfold(stored_file, |mut stored_file| async {
        let mut buffer = vec![0_u8; 64 * 1024];

        match stored_file.read(&mut buffer).await {
            Ok(0) => None,
            Ok(bytes_read) => {
                buffer.truncate(bytes_read);
                Some((
                    Ok::<web::Bytes, actix_web::Error>(web::Bytes::from(buffer)),
                    stored_file,
                ))
            }
            Err(read_error) => Some((
                Err(error::ErrorInternalServerError(read_error)),
                stored_file,
            )),
        }
    });

    Ok(HttpResponse::Ok()
        .insert_header((
            CONTENT_TYPE,
            file.mime_type
                .unwrap_or_else(|| "application/octet-stream".to_owned()),
        ))
        .insert_header((
            CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"{}\"",
                file.original_name.replace('"', "")
            ),
        ))
        .insert_header((CONTENT_LENGTH, size_bytes.to_string()))
        .streaming(stream))
}

pub async fn share(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    form: web::Form<ShareForm>,
) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
    require_csrf(&state, &request, &form.csrf_token).await?;
    let wants_json = request_wants_json(&request);
    if state.config.e2ee_mode.is_enabled() {
        if wants_json {
            return Err(error::ErrorConflict("encrypt this item before sharing it"));
        }
        return Ok(redirect("/files?file=encrypted-share-required"));
    }
    let file_id = path.into_inner();
    let username = normalize_username(&form.username);

    if !is_valid_username(&username) {
        if wants_json {
            return Err(error::ErrorBadRequest("enter a valid username"));
        }
        return Ok(redirect("/files?file=share-invalid"));
    }

    let Some(recipient_row) = state
        .db
        .query_opt(
            "
                SELECT id, username
                FROM users
                WHERE lower(username) = lower($1)
                  AND status = 'active'
                LIMIT 1
            ",
            &[&username],
        )
        .await
        .map_err(error::ErrorInternalServerError)?
    else {
        if wants_json {
            return Err(error::ErrorNotFound("recipient not found"));
        }
        return Ok(redirect("/files?file=share-user-missing"));
    };

    let recipient_id: String = recipient_row.get("id");
    let recipient_username: String = recipient_row.get("username");

    if recipient_id == user.id {
        if wants_json {
            return Err(error::ErrorBadRequest(
                "you cannot share an item with yourself",
            ));
        }
        return Ok(redirect("/files?file=share-self"));
    }

    let owned_file = state
        .db
        .query_opt(
            "
                SELECT id, entry_type
                FROM files
                WHERE id = $1
                  AND owner_id = $2
                  AND state = 'active'
                LIMIT 1
            ",
            &[&file_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    let Some(owned_file) = owned_file else {
        if wants_json {
            return Err(error::ErrorNotFound("item not found"));
        }
        return Ok(redirect("/files?file=missing"));
    };
    let entry_type: String = owned_file.get("entry_type");
    let counts_toward_shared = entry_type == "file";

    state
        .db
        .execute(
            "
                INSERT INTO file_shares (
                  id, file_id, owner_id, recipient_id, counts_toward_shared
                )
                VALUES (gen_random_uuid()::text, $1, $2, $3, $4)
                ON CONFLICT (file_id, recipient_id) DO NOTHING
            ",
            &[&file_id, &user.id, &recipient_id, &counts_toward_shared],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    if wants_json {
        return Ok(HttpResponse::Ok().json(ShareResponse { recipient_username }));
    }

    Ok(redirect("/files?file=shared"))
}

pub async fn unshare(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    form: web::Form<UnshareForm>,
) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
    require_csrf(&state, &request, &form.csrf_token).await?;
    let file_id = path.into_inner();
    let recipient_id = form
        .recipient_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(recipient_id) = recipient_id {
        state
            .db
            .execute(
                "
                    DELETE FROM file_shares
                    WHERE file_id = $1
                      AND owner_id = $2
                      AND recipient_id = $3
                ",
                &[&file_id, &user.id, &recipient_id],
            )
            .await
            .map_err(error::ErrorInternalServerError)?;

        return Ok(redirect("/files?file=unshared"));
    }

    state
        .db
        .execute(
            "
                DELETE FROM file_shares
                WHERE file_id = $1
                  AND recipient_id = $2
            ",
            &[&file_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(redirect("/shared?file=unshared"))
}

pub async fn trash(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    form: web::Form<CsrfForm>,
) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
    require_csrf(&state, &request, &form.csrf_token).await?;
    let wants_json = request_wants_json(&request);
    let file_id = path.into_inner();

    state
        .db
        .execute(
            "
                WITH RECURSIVE subtree AS (
                  SELECT id
                  FROM files
                  WHERE id = $1
                    AND owner_id = $2
                    AND state = 'active'

                  UNION ALL

                  SELECT child.id
                  FROM files AS child
                  INNER JOIN subtree AS parent ON child.parent_id = parent.id
                  WHERE child.owner_id = $2
                )
                UPDATE files
                SET state = 'trashed',
                    trashed_at = now(),
                    updated_at = now()
                WHERE id IN (SELECT id FROM subtree)
            ",
            &[&file_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    if wants_json {
        return Ok(HttpResponse::Ok().json(FileMutationResponse {
            status: "trashed",
            file_id,
        }));
    }

    Ok(redirect("/files?file=trashed"))
}

pub async fn restore(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    form: web::Form<CsrfForm>,
) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
    require_csrf(&state, &request, &form.csrf_token).await?;

    state
        .db
        .execute(
            "
                WITH RECURSIVE subtree AS (
                  SELECT id
                  FROM files
                  WHERE id = $1
                    AND owner_id = $2
                    AND state = 'trashed'

                  UNION ALL

                  SELECT child.id
                  FROM files AS child
                  INNER JOIN subtree AS parent ON child.parent_id = parent.id
                  WHERE child.owner_id = $2
                )
                UPDATE files
                SET state = 'active',
                    trashed_at = NULL,
                    updated_at = now()
                WHERE id IN (SELECT id FROM subtree)
            ",
            &[&path.into_inner(), &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(redirect("/trash?file=restored"))
}

pub async fn toggle_favorite(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    form: web::Form<CsrfForm>,
) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
    require_csrf(&state, &request, &form.csrf_token).await?;
    let wants_json = request_wants_json(&request);
    let file_id = path.into_inner();

    let updated = state
        .db
        .query_opt(
            "
                UPDATE files
                SET favorite = NOT favorite,
                    updated_at = now()
                WHERE id = $1
                  AND owner_id = $2
                  AND state = 'active'
                RETURNING favorite
            ",
            &[&file_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    if wants_json {
        return match updated {
            Some(row) => Ok(HttpResponse::Ok().json(FavoriteResponse {
                favorite: row.get("favorite"),
            })),
            None => Ok(HttpResponse::NotFound().finish()),
        };
    }

    Ok(redirect("/files?file=updated"))
}

pub async fn delete(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    form: web::Form<CsrfForm>,
) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
    require_csrf(&state, &request, &form.csrf_token).await?;
    let file_id = path.into_inner();
    let Some(file) = get_file(&state, &user, &file_id, false).await? else {
        return Ok(redirect("/trash?file=missing"));
    };
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute(
            "
                WITH RECURSIVE subtree AS (
                  SELECT id, owner_id, storage_name, entry_type
                  FROM files
                  WHERE id = $1 AND owner_id = $2 AND state = 'trashed'

                  UNION ALL

                  SELECT child.id, child.owner_id, child.storage_name, child.entry_type
                  FROM files AS child
                  INNER JOIN subtree AS parent ON child.parent_id = parent.id
                  WHERE child.owner_id = $2
                )
                INSERT INTO storage_deletion_jobs (object_key, available_at)
                SELECT
                  CASE
                    WHEN position('/' IN subtree.storage_name) = 0
                      THEN subtree.owner_id || '/' || subtree.storage_name
                    ELSE subtree.storage_name
                  END,
                  CASE
                    WHEN uploads.upload_mode = 'single'
                      THEN GREATEST(COALESCE(uploads.write_expires_at, now()), now())
                    ELSE now()
                  END
                FROM subtree
                LEFT JOIN file_uploads AS uploads
                  ON uploads.file_id = subtree.id
                 AND uploads.status = 'completed'
                WHERE subtree.entry_type = 'file'
                ON CONFLICT (object_key) DO UPDATE SET
                  available_at = GREATEST(
                    storage_deletion_jobs.available_at,
                    EXCLUDED.available_at
                  )
            ",
            &[&file.id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    transaction
        .execute(
            "DELETE FROM files WHERE id = $1 AND owner_id = $2 AND state = 'trashed'",
            &[&file.id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(redirect("/trash?file=deleted"))
}

async fn validate_folder(
    state: &AppState,
    user: &AuthUser,
    folder_id: Option<&str>,
) -> Result<Option<String>> {
    let Some(folder_id) = folder_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let folder = state
        .db
        .query_opt(
            "
                SELECT id
                FROM files
                WHERE id = $1
                  AND owner_id = $2
                  AND entry_type = 'folder'
                  AND state = 'active'
                LIMIT 1
            ",
            &[&folder_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    folder
        .map(|row| row.get("id"))
        .ok_or_else(|| error::ErrorNotFound("folder not found"))
        .map(Some)
}

async fn validate_shared_folder(
    state: &AppState,
    user: &AuthUser,
    folder_id: Option<&str>,
) -> Result<Option<String>> {
    let Some(folder_id) = folder_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let accessible = state
        .db
        .query_opt(
            "
                WITH RECURSIVE ancestors AS (
                  SELECT id, parent_id, owner_id
                  FROM files
                  WHERE id = $1 AND entry_type = 'folder' AND state = 'active'
                  UNION ALL
                  SELECT parent.id, parent.parent_id, parent.owner_id
                  FROM files AS parent
                  INNER JOIN ancestors AS child ON child.parent_id = parent.id
                  WHERE parent.owner_id = child.owner_id AND parent.state = 'active'
                )
                SELECT $1::text AS id
                FROM ancestors
                WHERE EXISTS (
                  SELECT 1
                  FROM file_shares AS shares
                  WHERE shares.file_id = ancestors.id
                    AND shares.owner_id = ancestors.owner_id
                    AND shares.recipient_id = $2
                ) OR EXISTS (
                  SELECT 1
                  FROM vault_shares AS shares
                  INNER JOIN vault_share_recipients AS recipients
                    ON recipients.share_id = shares.id
                   AND recipients.recipient_id = $2
                   AND recipients.status = 'active'
                  WHERE shares.root_node_id = ancestors.id
                    AND shares.owner_id = ancestors.owner_id
                    AND shares.status = 'active'
                )
                LIMIT 1
            ",
            &[&folder_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    accessible
        .map(|row| row.get("id"))
        .ok_or_else(|| error::ErrorNotFound("shared folder not found"))
        .map(Some)
}

async fn get_breadcrumbs(
    state: &AppState,
    user: &AuthUser,
    folder_id: Option<&str>,
) -> Result<Vec<FolderBreadcrumb>> {
    let Some(folder_id) = folder_id else {
        return Ok(Vec::new());
    };
    let rows = state
        .db
        .query(
            "
                WITH RECURSIVE ancestors AS (
                  SELECT id, original_name, parent_id, e2ee_state, 0 AS depth
                  FROM files
                  WHERE id = $1 AND owner_id = $2

                  UNION ALL

                  SELECT parent.id, parent.original_name, parent.parent_id, parent.e2ee_state, child.depth + 1
                  FROM files AS parent
                  INNER JOIN ancestors AS child ON child.parent_id = parent.id
                  WHERE parent.owner_id = $2
                )
                SELECT id, original_name, e2ee_state
                FROM ancestors
                ORDER BY depth DESC
            ",
            &[&folder_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(rows
        .into_iter()
        .map(|row| FolderBreadcrumb {
            id: row.get("id"),
            name: row.get("original_name"),
            e2ee_state: row.get("e2ee_state"),
        })
        .collect())
}

async fn get_shared_breadcrumbs(
    state: &AppState,
    user: &AuthUser,
    folder_id: Option<&str>,
) -> Result<Vec<FolderBreadcrumb>> {
    let Some(folder_id) = folder_id else {
        return Ok(Vec::new());
    };
    let rows = state
        .db
        .query(
            "
                WITH RECURSIVE ancestors AS (
                  SELECT id, original_name, parent_id, owner_id, e2ee_state, 0 AS depth
                  FROM files WHERE id = $1
                  UNION ALL
                  SELECT parent.id, parent.original_name, parent.parent_id,
                         parent.owner_id, parent.e2ee_state, child.depth + 1
                  FROM files AS parent
                  INNER JOIN ancestors AS child ON child.parent_id = parent.id
                  WHERE parent.owner_id = child.owner_id
                ), legacy_access AS (
                  SELECT ancestors.depth AS root_depth
                  FROM ancestors
                  INNER JOIN file_shares AS shares
                    ON shares.file_id = ancestors.id
                   AND shares.owner_id = ancestors.owner_id
                   AND shares.recipient_id = $2
                ), vault_access AS (
                  SELECT ancestors.depth AS root_depth
                  FROM ancestors
                  INNER JOIN vault_shares AS shares
                    ON shares.root_node_id = ancestors.id
                   AND shares.owner_id = ancestors.owner_id
                   AND shares.status = 'active'
                  INNER JOIN vault_share_recipients AS recipients
                    ON recipients.share_id = shares.id
                   AND recipients.recipient_id = $2
                   AND recipients.status = 'active'
                ), access AS (
                  SELECT candidates.root_depth
                  FROM (
                    SELECT root_depth FROM legacy_access
                    UNION ALL
                    SELECT root_depth FROM vault_access
                  ) AS candidates
                  ORDER BY candidates.root_depth
                  LIMIT 1
                )
                SELECT id, original_name, e2ee_state
                FROM ancestors, access
                WHERE ancestors.depth <= access.root_depth
                ORDER BY ancestors.depth DESC
            ",
            &[&folder_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    Ok(rows
        .into_iter()
        .map(|row| FolderBreadcrumb {
            id: row.get("id"),
            name: row.get("original_name"),
            e2ee_state: row.get("e2ee_state"),
        })
        .collect())
}

async fn ensure_folder(
    state: &AppState,
    user: &AuthUser,
    parent_id: Option<&str>,
    name: &str,
) -> Result<String> {
    let parent_id = parent_id.map(str::to_owned);
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .query_one(
            "SELECT pg_advisory_xact_lock(hashtextextended($1 || '|' || COALESCE($2, '') || '|' || lower($3), 0))",
            &[&user.id, &parent_id, &name],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let existing = transaction
        .query_opt(
            "
                SELECT id
                FROM files
                WHERE owner_id = $1
                  AND entry_type = 'folder'
                  AND state = 'active'
                  AND parent_id IS NOT DISTINCT FROM $2
                  AND lower(original_name) = lower($3)
                LIMIT 1
            ",
            &[&user.id, &parent_id, &name],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    if let Some(existing) = existing {
        let folder_id = existing.get("id");
        transaction
            .commit()
            .await
            .map_err(error::ErrorInternalServerError)?;
        return Ok(folder_id);
    }

    let storage_name = create_storage_name()?;
    let row = transaction
        .query_one(
            "
                INSERT INTO files (
                  id,
                  owner_id,
                  original_name,
                  storage_name,
                  size_bytes,
                  entry_type,
                  parent_id
                )
                VALUES (gen_random_uuid()::text, $1, $2, $3, 0, 'folder', $4)
                RETURNING id
            ",
            &[&user.id, &name, &storage_name, &parent_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let folder_id = row.get("id");
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(folder_id)
}

#[allow(clippy::too_many_arguments)]
async fn list_entries(
    state: &AppState,
    user: &AuthUser,
    view: &str,
    folder_id: Option<&str>,
    sort: Option<&str>,
    direction: &str,
    encoded_cursor: Option<&str>,
    page_size: usize,
) -> Result<FilePage> {
    let effective_sort = sort.unwrap_or(if view == "files" { "name" } else { "updated" });
    let cursor = decode_file_cursor(encoded_cursor, view, folder_id, effective_sort, direction)?;

    if view == "shared" {
        return list_shared_entries(
            state,
            user,
            folder_id,
            effective_sort,
            direction,
            cursor.as_ref(),
            page_size,
        )
        .await;
    }

    let predicate = match view {
        "files" => "files.state = 'active' AND files.parent_id IS NOT DISTINCT FROM $2",
        "trash" => {
            "files.state = 'trashed' AND NOT EXISTS (
              SELECT 1 FROM files AS parent
              WHERE parent.id = files.parent_id AND parent.state = 'trashed'
            )"
        }
        "favorites" => "files.state = 'active' AND files.favorite = true",
        "recent" => "files.state = 'active'",
        _ => "files.state = 'active'",
    };
    let rank = "CASE WHEN files.entry_type = 'folder' THEN 0 ELSE 1 END";
    let name = "lower(files.original_name)";
    let date = if view == "trash" {
        "COALESCE(files.trashed_at, files.updated_at)"
    } else {
        "files.updated_at"
    };
    let comparison = if direction == "ASC" { ">" } else { "<" };
    let (cursor_predicate, order) = match effective_sort {
        "size" => (
            format!(
                "$3::integer IS NULL OR {rank} > $3 OR ({rank} = $3 AND (files.size_bytes {comparison} $5 OR (files.size_bytes = $5 AND ({name} > $4 OR ({name} = $4 AND files.id > $7)))))"
            ),
            format!("{rank} ASC, files.size_bytes {direction}, {name} ASC, files.id ASC"),
        ),
        "updated" => (
            format!(
                "$3::integer IS NULL OR {rank} > $3 OR ({rank} = $3 AND ({date} {comparison} $6::text::timestamptz OR ({date} = $6::text::timestamptz AND ({name} > $4 OR ({name} = $4 AND files.id > $7)))))"
            ),
            format!("{rank} ASC, {date} {direction}, {name} ASC, files.id ASC"),
        ),
        _ => (
            format!(
                "$3::integer IS NULL OR {rank} > $3 OR ({rank} = $3 AND ({name} {comparison} $4 OR ({name} = $4 AND files.id > $7)))"
            ),
            format!("{rank} ASC, {name} {direction}, files.id ASC"),
        ),
    };
    let folder_id = folder_id.map(str::to_owned);
    let cursor_rank = cursor.as_ref().map(|value| value.rank);
    let cursor_name = cursor.as_ref().map(|value| value.name.clone());
    let cursor_size = cursor.as_ref().map(|value| value.size);
    let cursor_date = cursor.as_ref().map(|value| value.date.clone());
    let cursor_id = cursor.as_ref().map(|value| value.id.clone());
    let row_limit = i64::try_from(page_size + 1)
        .map_err(|_| error::ErrorInternalServerError("invalid page size"))?;
    let sql = format!(
        "
            SELECT
              files.id,
              files.original_name,
              files.mime_type,
              files.entry_type,
              files.parent_id,
              files.size_bytes,
              files.state,
              files.e2ee_state,
              files.favorite,
              NULL::text AS owner_username,
              EXISTS (
                SELECT 1 FROM file_shares
                WHERE file_shares.file_id = files.id
                  AND file_shares.owner_id = files.owner_id
              ) OR EXISTS (
                SELECT 1 FROM vault_shares
                WHERE vault_shares.root_node_id = files.id
                  AND vault_shares.owner_id = files.owner_id
                  AND vault_shares.status IN ('active', 'rotating')
              ) AS shared,
              NULL::text AS shared_at,
              to_char(files.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at,
              to_char(files.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS updated_at,
              to_char(files.trashed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS trashed_at,
              {rank}::integer AS cursor_rank,
              {name} AS cursor_name,
              to_char({date} AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cursor_date
            FROM files
            WHERE files.owner_id = $1
              AND ($2::text IS NULL OR $2::text IS NOT NULL)
              AND ($4::text IS NULL OR $4::text IS NOT NULL)
              AND ($5::bigint IS NULL OR $5::bigint IS NOT NULL)
              AND ($6::text IS NULL OR $6::text IS NOT NULL)
              AND ($7::text IS NULL OR $7::text IS NOT NULL)
              AND {predicate}
              AND ({cursor_predicate})
            ORDER BY {order}
            LIMIT $8
        "
    );

    let rows = state
        .db
        .query(
            &sql,
            &[
                &user.id,
                &folder_id,
                &cursor_rank,
                &cursor_name,
                &cursor_size,
                &cursor_date,
                &cursor_id,
                &row_limit,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    file_page_from_rows(
        rows,
        view,
        folder_id.as_deref(),
        effective_sort,
        direction,
        page_size,
    )
}

async fn list_shared_entries(
    state: &AppState,
    user: &AuthUser,
    folder_id: Option<&str>,
    sort: &str,
    direction: &str,
    cursor: Option<&FileCursor>,
    page_size: usize,
) -> Result<FilePage> {
    if let Some(folder_id) = folder_id {
        return list_shared_folder_entries(
            state, user, folder_id, sort, direction, cursor, page_size,
        )
        .await;
    }
    let name = "lower(files.original_name)";
    let date = "file_shares.created_at";
    let comparison = if direction == "ASC" { ">" } else { "<" };
    let (cursor_predicate, order) = match sort {
        "size" => (
            format!(
                "$2::integer IS NULL OR files.size_bytes {comparison} $4 OR (files.size_bytes = $4 AND ({name} > $3 OR ({name} = $3 AND files.id > $6)))"
            ),
            format!("files.size_bytes {direction}, {name} ASC, files.id ASC"),
        ),
        "updated" => (
            format!(
                "$2::integer IS NULL OR {date} {comparison} $5::text::timestamptz OR ({date} = $5::text::timestamptz AND ({name} > $3 OR ({name} = $3 AND files.id > $6)))"
            ),
            format!("{date} {direction}, {name} ASC, files.id ASC"),
        ),
        _ => (
            format!(
                "$2::integer IS NULL OR {name} {comparison} $3 OR ({name} = $3 AND files.id > $6)"
            ),
            format!("{name} {direction}, files.id ASC"),
        ),
    };
    let cursor_rank = cursor.map(|value| value.rank);
    let cursor_name = cursor.map(|value| value.name.clone());
    let cursor_size = cursor.map(|value| value.size);
    let cursor_date = cursor.map(|value| value.date.clone());
    let cursor_id = cursor.map(|value| value.id.clone());
    let row_limit = i64::try_from(page_size + 1)
        .map_err(|_| error::ErrorInternalServerError("invalid page size"))?;
    let sql = format!(
        "
            SELECT
              files.id,
              files.original_name,
              files.mime_type,
              files.entry_type,
              files.parent_id,
              files.size_bytes,
              files.state,
              files.e2ee_state,
              false AS favorite,
              owners.username AS owner_username,
              true AS shared,
              to_char(file_shares.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS shared_at,
              to_char(files.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at,
              to_char(files.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS updated_at,
              to_char(files.trashed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS trashed_at,
              1::integer AS cursor_rank,
              {name} AS cursor_name,
              to_char({date} AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cursor_date
            FROM file_shares
            INNER JOIN files ON files.id = file_shares.file_id
            INNER JOIN users AS owners ON owners.id = files.owner_id
            WHERE file_shares.recipient_id = $1
              AND ($3::text IS NULL OR $3::text IS NOT NULL)
              AND ($4::bigint IS NULL OR $4::bigint IS NOT NULL)
              AND ($5::text IS NULL OR $5::text IS NOT NULL)
              AND ($6::text IS NULL OR $6::text IS NOT NULL)
              AND files.state = 'active'
              AND owners.status = 'active'
              AND ({cursor_predicate})
            ORDER BY {order}
            LIMIT $7
        "
    );
    let rows = state
        .db
        .query(
            &sql,
            &[
                &user.id,
                &cursor_rank,
                &cursor_name,
                &cursor_size,
                &cursor_date,
                &cursor_id,
                &row_limit,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    file_page_from_rows(rows, "shared", None, sort, direction, page_size)
}

async fn list_shared_folder_entries(
    state: &AppState,
    user: &AuthUser,
    folder_id: &str,
    sort: &str,
    direction: &str,
    cursor: Option<&FileCursor>,
    page_size: usize,
) -> Result<FilePage> {
    let rank = "CASE WHEN files.entry_type = 'folder' THEN 0 ELSE 1 END";
    let name = "lower(files.original_name)";
    let date = "access.created_at";
    let comparison = if direction == "ASC" { ">" } else { "<" };
    let (cursor_predicate, order) = match sort {
        "size" => (
            format!(
                "$3::integer IS NULL OR {rank} > $3 OR ({rank} = $3 AND (files.size_bytes {comparison} $5 OR (files.size_bytes = $5 AND ({name} > $4 OR ({name} = $4 AND files.id > $7)))))"
            ),
            format!("{rank} ASC, files.size_bytes {direction}, {name} ASC, files.id ASC"),
        ),
        "updated" => (
            format!(
                "$3::integer IS NULL OR {rank} > $3 OR ({rank} = $3 AND ({date} {comparison} $6::text::timestamptz OR ({date} = $6::text::timestamptz AND ({name} > $4 OR ({name} = $4 AND files.id > $7)))))"
            ),
            format!("{rank} ASC, {date} {direction}, {name} ASC, files.id ASC"),
        ),
        _ => (
            format!(
                "$3::integer IS NULL OR {rank} > $3 OR ({rank} = $3 AND ({name} {comparison} $4 OR ({name} = $4 AND files.id > $7)))"
            ),
            format!("{rank} ASC, {name} {direction}, files.id ASC"),
        ),
    };
    let cursor_rank = cursor.map(|value| value.rank);
    let cursor_name = cursor.map(|value| value.name.clone());
    let cursor_size = cursor.map(|value| value.size);
    let cursor_date = cursor.map(|value| value.date.clone());
    let cursor_id = cursor.map(|value| value.id.clone());
    let row_limit = i64::try_from(page_size + 1)
        .map_err(|_| error::ErrorInternalServerError("invalid page size"))?;
    let sql = format!(
        "
            WITH RECURSIVE ancestors AS (
              SELECT id, parent_id, owner_id FROM files WHERE id = $2
              UNION ALL
              SELECT parent.id, parent.parent_id, parent.owner_id
              FROM files AS parent
              INNER JOIN ancestors AS child ON child.parent_id = parent.id
              WHERE parent.owner_id = child.owner_id
            ), legacy_access AS (
              SELECT shares.id, shares.owner_id, shares.created_at
              FROM ancestors
              INNER JOIN file_shares AS shares
                ON shares.file_id = ancestors.id
               AND shares.owner_id = ancestors.owner_id
               AND shares.recipient_id = $1
            ), vault_access AS (
              SELECT shares.id, shares.owner_id, shares.created_at
              FROM ancestors
              INNER JOIN vault_shares AS shares
                ON shares.root_node_id = ancestors.id
               AND shares.owner_id = ancestors.owner_id
               AND shares.status = 'active'
              INNER JOIN vault_share_recipients AS recipients
                ON recipients.share_id = shares.id
               AND recipients.recipient_id = $1
               AND recipients.status = 'active'
            ), access AS (
              SELECT candidates.id, candidates.owner_id, candidates.created_at
              FROM (
                SELECT id, owner_id, created_at FROM legacy_access
                UNION ALL
                SELECT id, owner_id, created_at FROM vault_access
              ) AS candidates
              ORDER BY candidates.created_at
              LIMIT 1
            )
            SELECT files.id, files.original_name, files.mime_type,
                   files.entry_type, files.parent_id, files.size_bytes,
                   files.state, files.e2ee_state, false AS favorite,
                   owners.username AS owner_username, true AS shared,
                   to_char(access.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS shared_at,
                   to_char(files.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at,
                   to_char(files.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS updated_at,
                   NULL::text AS trashed_at, {rank}::integer AS cursor_rank,
                   {name} AS cursor_name,
                   to_char({date} AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cursor_date
            FROM access
            INNER JOIN files ON files.owner_id = access.owner_id
              AND files.parent_id = $2 AND files.state = 'active'
            INNER JOIN users AS owners ON owners.id = files.owner_id
            WHERE ($4::text IS NULL OR $4::text IS NOT NULL)
              AND ($5::bigint IS NULL OR $5::bigint IS NOT NULL)
              AND ($6::text IS NULL OR $6::text IS NOT NULL)
              AND ($7::text IS NULL OR $7::text IS NOT NULL)
              AND ({cursor_predicate})
            ORDER BY {order}
            LIMIT $8
        "
    );
    let rows = state
        .db
        .query(
            &sql,
            &[
                &user.id,
                &folder_id,
                &cursor_rank,
                &cursor_name,
                &cursor_size,
                &cursor_date,
                &cursor_id,
                &row_limit,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    file_page_from_rows(rows, "shared", Some(folder_id), sort, direction, page_size)
}

fn listed_file_from_row(row: tokio_postgres::Row) -> ListedFile {
    let mime_type: Option<String> = row.get("mime_type");
    let name: String = row.get("original_name");
    let entry_type: String = row.get("entry_type");
    let kind = if entry_type == "folder" {
        "Folder".to_owned()
    } else {
        file_kind(&name, mime_type.as_deref())
    };

    ListedFile {
        rank: row.get("cursor_rank"),
        cursor_name: row.get("cursor_name"),
        cursor_date: row.get("cursor_date"),
        entry: FileEntry {
            id: row.get("id"),
            name,
            kind,
            entry_type,
            parent_id: row.get("parent_id"),
            size_bytes: row.get("size_bytes"),
            state: row.get("state"),
            favorite: row.get("favorite"),
            owner_username: row.get("owner_username"),
            shared: row.get("shared"),
            shared_at: row.get("shared_at"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
            trashed_at: row.get("trashed_at"),
            e2ee_state: row.get("e2ee_state"),
        },
    }
}

fn file_page_from_rows(
    rows: Vec<tokio_postgres::Row>,
    view: &str,
    folder_id: Option<&str>,
    sort: &str,
    direction: &str,
    page_size: usize,
) -> Result<FilePage> {
    let mut listed = rows
        .into_iter()
        .map(listed_file_from_row)
        .collect::<Vec<_>>();
    let has_more = listed.len() > page_size;
    listed.truncate(page_size);
    let next_cursor = if has_more {
        listed
            .last()
            .map(|last| {
                encode_file_cursor(&FileCursor {
                    view: view.to_owned(),
                    folder_id: folder_id.map(str::to_owned),
                    sort: sort.to_owned(),
                    direction: direction.to_owned(),
                    rank: last.rank,
                    name: last.cursor_name.clone(),
                    size: last.entry.size_bytes,
                    date: last.cursor_date.clone(),
                    id: last.entry.id.clone(),
                })
            })
            .transpose()?
    } else {
        None
    };

    Ok(FilePage {
        entries: listed.into_iter().map(|item| item.entry).collect(),
        next_cursor,
        has_more,
    })
}

fn decode_file_cursor(
    encoded: Option<&str>,
    view: &str,
    folder_id: Option<&str>,
    sort: &str,
    direction: &str,
) -> Result<Option<FileCursor>> {
    let Some(encoded) = encoded else {
        return Ok(None);
    };

    if encoded.len() > 2048 {
        return Err(error::ErrorBadRequest("invalid file cursor"));
    }

    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| error::ErrorBadRequest("invalid file cursor"))?;
    let cursor = serde_json::from_slice::<FileCursor>(&bytes)
        .map_err(|_| error::ErrorBadRequest("invalid file cursor"))?;

    if cursor.view != view
        || cursor.folder_id.as_deref() != folder_id
        || cursor.sort != sort
        || cursor.direction != direction
    {
        return Err(error::ErrorBadRequest(
            "file cursor does not match this view",
        ));
    }

    Ok(Some(cursor))
}

fn encode_file_cursor(cursor: &FileCursor) -> Result<String> {
    let bytes = serde_json::to_vec(cursor).map_err(error::ErrorInternalServerError)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

async fn get_summary(state: &AppState, user: &AuthUser) -> Result<FilesSummary> {
    let row = state
        .db
        .query_one(
            "
                SELECT
                  COALESCE(total_files, 0)::bigint AS total_files,
                  COALESCE(total_folders, 0)::bigint AS total_folders,
                  COALESCE(active_files, 0)::bigint AS active_files,
                  COALESCE(trashed_files, 0)::bigint AS trashed_files,
                  COALESCE(favorite_files, 0)::bigint AS favorite_files,
                  COALESCE(shared_files, 0)::bigint AS shared_files,
                  COALESCE(used_bytes, 0)::bigint AS used_bytes
                FROM users
                LEFT JOIN user_file_counters ON user_file_counters.owner_id = users.id
                WHERE users.id = $1
            ",
            &[&user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(FilesSummary {
        total_files: row.get("total_files"),
        total_folders: row.get("total_folders"),
        active_files: row.get("active_files"),
        trashed_files: row.get("trashed_files"),
        favorite_files: row.get("favorite_files"),
        shared_files: row.get("shared_files"),
        used_bytes: row.get("used_bytes"),
    })
}

async fn get_file(
    state: &AppState,
    user: &AuthUser,
    file_id: &str,
    active_only: bool,
) -> Result<Option<StoredFile>> {
    let state_predicate = if active_only {
        "AND state = 'active'"
    } else {
        "AND state = 'trashed'"
    };
    let sql = format!(
        "
            SELECT id, owner_id, original_name, storage_name, mime_type
            FROM files
            WHERE id = $1
              AND owner_id = $2
              {state_predicate}
            LIMIT 1
        "
    );

    let row = state
        .db
        .query_opt(&sql, &[&file_id, &user.id])
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(row.map(|row| StoredFile {
        id: row.get("id"),
        owner_id: row.get("owner_id"),
        original_name: row.get("original_name"),
        storage_name: row.get("storage_name"),
        mime_type: row.get("mime_type"),
    }))
}

async fn get_download_file(
    state: &AppState,
    user: &AuthUser,
    file_id: &str,
) -> Result<Option<StoredFile>> {
    let row = state
        .db
        .query_opt(
            "
                WITH RECURSIVE ancestors AS (
                  SELECT id, parent_id, owner_id
                  FROM files
                  WHERE id = $1

                  UNION ALL

                  SELECT parent.id, parent.parent_id, parent.owner_id
                  FROM files AS parent
                  INNER JOIN ancestors AS child ON child.parent_id = parent.id
                  WHERE parent.owner_id = child.owner_id
                )
                SELECT
                  files.id,
                  files.owner_id,
                  files.original_name,
                  files.storage_name,
                  files.mime_type
                FROM files
                INNER JOIN users AS owners ON owners.id = files.owner_id
                WHERE files.id = $1
                  AND files.state = 'active'
                  AND files.entry_type = 'file'
                  AND files.e2ee_state IN ('legacy', 'staged')
                  AND (
                    files.owner_id = $2
                    OR (
                      owners.status = 'active'
                      AND EXISTS (
                        SELECT 1
                        FROM ancestors
                        INNER JOIN file_shares
                          ON file_shares.file_id = ancestors.id
                         AND file_shares.owner_id = ancestors.owner_id
                        WHERE file_shares.recipient_id = $2
                      )
                    )
                  )
                LIMIT 1
            ",
            &[&file_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(row.map(|row| StoredFile {
        id: row.get("id"),
        owner_id: row.get("owner_id"),
        original_name: row.get("original_name"),
        storage_name: row.get("storage_name"),
        mime_type: row.get("mime_type"),
    }))
}

async fn get_upload(
    state: &AppState,
    user: &AuthUser,
    upload_id: &str,
) -> Result<Option<UploadRecord>> {
    let row = state
        .db
        .query_opt(
            "
                SELECT
                  id,
                  file_id,
                  owner_id,
                  parent_id,
                  original_name,
                  object_key,
                  mime_type,
                  size_bytes,
                  upload_mode,
                  part_size_bytes,
                  multipart_upload_id,
                  status,
                  checksum_sha256
                FROM file_uploads
                WHERE id = $1
                  AND owner_id = $2
                  AND (status = 'completed' OR expires_at > now())
                LIMIT 1
            ",
            &[&upload_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(row.map(|row| UploadRecord {
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
    }))
}

async fn find_resumable_upload(
    state: &AppState,
    user: &AuthUser,
    parent_id: Option<&str>,
    original_name: &str,
    mime_type: &Option<String>,
    size_bytes: i64,
) -> Result<Option<UploadRecord>> {
    let parent_id = parent_id.map(str::to_owned);
    let row = state
        .db
        .query_opt(
            "
                SELECT
                  id,
                  file_id,
                  owner_id,
                  parent_id,
                  original_name,
                  object_key,
                  mime_type,
                  size_bytes,
                  upload_mode,
                  part_size_bytes,
                  multipart_upload_id,
                  status,
                  checksum_sha256
                FROM file_uploads
                WHERE owner_id = $1
                  AND parent_id IS NOT DISTINCT FROM $2
                  AND original_name = $3
                  AND size_bytes = $4
                  AND mime_type IS NOT DISTINCT FROM $5
                  AND status IN ('initializing', 'pending', 'completing')
                  AND expires_at > now()
                ORDER BY created_at DESC
                LIMIT 1
            ",
            &[
                &user.id,
                &parent_id,
                &original_name,
                &size_bytes,
                &mime_type,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(row.map(|row| UploadRecord {
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
    }))
}

async fn current_reserved_bytes(state: &AppState, user: &AuthUser) -> Result<u64> {
    let row = state
        .db
        .query_one(
            "
                SELECT
                  COALESCE((
                    SELECT used_bytes
                    FROM user_file_counters
                    WHERE owner_id = $1
                  ), 0)::bigint
                  +
                  COALESCE((
                    SELECT sum(size_bytes)
                    FROM file_uploads
                    WHERE owner_id = $1
                      AND (
                        (status IN ('initializing', 'pending', 'completing') AND expires_at > now())
                        OR status = 'aborting'
                      )
                  ), 0)::bigint AS reserved_bytes
            ",
            &[&user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let reserved_bytes: i64 = row.get("reserved_bytes");

    u64::try_from(reserved_bytes)
        .map_err(|_| error::ErrorInternalServerError("invalid reserved byte count"))
}

async fn require_header_csrf(state: &AppState, request: &HttpRequest) -> Result<()> {
    let csrf_token = request
        .headers()
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| error::ErrorForbidden("csrf token required"))?;

    require_csrf(state, request, csrf_token).await
}

async fn enqueue_upload_cleanup(
    state: &AppState,
    upload_id: &str,
    owner_id: &str,
    object_key: &str,
    multipart_upload_id: Option<&str>,
    from_statuses: &[&str],
) -> Result<bool> {
    let statuses = from_statuses
        .iter()
        .map(|status| (*status).to_owned())
        .collect::<Vec<_>>();
    let transitioned = state
        .db
        .query_opt(
            "
                WITH transitioned AS (
                  UPDATE file_uploads
                  SET status = 'aborting',
                      multipart_upload_id = COALESCE($1, multipart_upload_id),
                      expires_at = now() + interval '24 hours'
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
        .await
        .map_err(error::ErrorInternalServerError)?;
    let did_transition = transitioned.is_some();

    Ok(did_transition)
}

fn upload_part_size(upload: &UploadRecord) -> Result<u64> {
    upload
        .part_size_bytes
        .and_then(|value| u64::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| error::ErrorInternalServerError("multipart part size is missing"))
}

fn validate_sha256_checksum(value: &str) -> Result<String> {
    let checksum = value.trim();
    let decoded = STANDARD
        .decode(checksum)
        .map_err(|_| error::ErrorBadRequest("invalid SHA-256 checksum"))?;

    if decoded.len() != 32 {
        return Err(error::ErrorBadRequest("invalid SHA-256 checksum"));
    }

    Ok(checksum.to_owned())
}

fn create_storage_name() -> Result<String> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes).map_err(error::ErrorInternalServerError)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn sanitize_display_name(filename: &str) -> String {
    filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("file")
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(180)
        .collect()
}

fn sanitize_upload_path(filename: &str) -> Vec<String> {
    let normalized = filename.replace('\\', "/");
    let raw_segments = normalized
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();

    if raw_segments.is_empty()
        || raw_segments.len() > 64
        || raw_segments
            .iter()
            .any(|segment| matches!(*segment, "." | ".."))
    {
        return Vec::new();
    }

    raw_segments
        .into_iter()
        .map(sanitize_display_name)
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn upload_redirect_location(parent_id: Option<&str>, status: &str) -> String {
    match parent_id {
        Some(parent_id) => format!("/files?folder={parent_id}&file={status}"),
        None => format!("/files?file={status}"),
    }
}

fn normalize_username(username: &str) -> String {
    username.trim().to_ascii_lowercase()
}

fn is_valid_username(username: &str) -> bool {
    let length = username.len();

    (3..=32).contains(&length)
        && username.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

fn file_kind(name: &str, mime_type: Option<&str>) -> String {
    if let Some(mime_type) = mime_type
        && let Some(kind) = mime_type.split('/').next()
        && !kind.is_empty()
        && kind != "application"
    {
        return kind.to_owned();
    }

    name.rsplit('.')
        .next()
        .filter(|extension| *extension != name)
        .map(|extension| extension.to_ascii_uppercase())
        .unwrap_or_else(|| "File".to_owned())
}

fn normalize_view(view: Option<&str>) -> &str {
    match view {
        Some("recent") => "recent",
        Some("favorites") => "favorites",
        Some("shared") => "shared",
        Some("trash") => "trash",
        _ => "files",
    }
}

fn normalize_sort(sort: Option<&str>) -> Option<&'static str> {
    match sort {
        Some("name") => Some("name"),
        Some("size") => Some("size"),
        Some("updated") => Some("updated"),
        _ => None,
    }
}

fn normalize_sort_direction(direction: Option<&str>, sort: Option<&str>) -> &'static str {
    match direction {
        Some("asc") => "ASC",
        Some("desc") => "DESC",
        _ if sort == Some("name") => "ASC",
        _ => "DESC",
    }
}

fn storage_stats(state: &AppState, used_bytes: i64) -> StorageStats {
    let used_bytes = u64::try_from(used_bytes).unwrap_or(0);
    let total_bytes = state.config.storage_quota_bytes;

    StorageStats {
        storage_path: format!("{} storage", state.storage.backend_name()),
        total_bytes,
        available_bytes: total_bytes.saturating_sub(used_bytes),
        system_used_bytes: used_bytes,
        aeralyth_used_bytes: used_bytes,
    }
}

fn request_wants_json(request: &HttpRequest) -> bool {
    request
        .headers()
        .get(ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("application/json"))
}

fn redirect(location: impl Into<String>) -> HttpResponse {
    HttpResponse::SeeOther()
        .insert_header((LOCATION, location.into()))
        .finish()
}
