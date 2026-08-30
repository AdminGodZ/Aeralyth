use std::collections::{BTreeMap, HashMap};

use actix_web::http::header::{
    ACCEPT, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, LOCATION,
};
use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use futures_util::{StreamExt, future::try_join_all};
use serde::{Deserialize, Serialize};
use tokio::fs::{File as AsyncFile, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio_postgres::IsolationLevel;

use crate::auth::{SessionPrincipal, parse_json_body, require_csrf, require_principal};
use crate::db::{query_cached, query_one_cached, query_opt_cached};
use crate::routes::local_file_stream::local_file_stream;
use crate::routes::share_links::{
    EditorShareGrant, editor_grant_from_header, editor_parent, validate_editor_replacement,
};
use crate::routes::tree_walk::{
    MAX_TREE_MUTATION_NODES, TREE_MUTATION_BATCH_SIZE, TreeWalkScope, update_tree_state,
    walk_subtree,
};
use crate::routes::upload_reservations::{reservation_amount, reserve_upload_capacity};
use crate::state::{AppState, LoadShedError};
use crate::storage::UploadedPart;
use crate::timestamps;
use crate::upload_completion::{
    FileUploadFinalizeOutcome, FileUploadRecord, completion_retry_delay_seconds,
    defer_file_upload_completion, file_upload_from_row, file_upload_metadata_matches,
    finalize_file_upload_record, transition_file_upload_to_cleanup,
};

const MAX_UPLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_FOLDER_ARCHIVE_ENTRIES: usize = 50_000;
const MAX_FOLDER_ARCHIVE_BYTES: i64 = 2 * 1024 * 1024 * 1024;
const UPLOAD_LENGTH_HEADER: &str = "x-aeralyth-upload-length";
const UPLOAD_OFFSET_HEADER: &str = "x-aeralyth-upload-offset";
const DEFAULT_PAGE_SIZE: usize = 50;
const MAX_PAGE_SIZE: usize = 100;
const MAX_PRESIGN_PARTS: usize = 32;
pub(crate) const DELETE_TREE_BATCH_QUERY: &str = "
    WITH targets AS MATERIALIZED (
      SELECT files.id, files.owner_id, files.storage_name,
             files.entry_type
      FROM files
      WHERE files.owner_id = $2
        AND files.id = ANY($1::text[])
      FOR UPDATE
    ), queued AS (
      INSERT INTO storage_deletion_jobs (object_key, available_at)
      SELECT
        CASE
          WHEN position('/' IN targets.storage_name) = 0
            THEN targets.owner_id || '/' || targets.storage_name
          ELSE targets.storage_name
        END,
        CASE
          WHEN uploads.upload_mode = 'single'
            THEN GREATEST(
              COALESCE(uploads.write_expires_at, now()), now()
            )
          ELSE now()
        END
      FROM targets
      LEFT JOIN file_uploads AS uploads
        ON uploads.file_id = targets.id
       AND uploads.status = 'completed'
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
const MAX_FOLDER_MANIFEST_PATHS: usize = 1_000;
const MAX_FOLDER_MANIFEST_FOLDERS: usize = MAX_FOLDER_MANIFEST_PATHS * 63;
const FOLDER_MANIFEST_JSON_LIMIT: usize = 2 * 1024 * 1024;
const UPLOAD_CONTROL_JSON_LIMIT: usize = 64 * 1024;
const UPLOAD_COMPLETION_JSON_LIMIT: usize = 4 * 1024 * 1024;

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
pub(crate) struct DownloadQuery {
    version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadInitRequest {
    name: String,
    relative_path: String,
    size_bytes: u64,
    mime_type: Option<String>,
    parent_id: Option<String>,
    replacement_file_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderManifestRequest {
    relative_paths: Vec<String>,
    parent_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderManifestResponse {
    parent_ids: Vec<Option<String>>,
    root_folder_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PlannedFolder {
    path: String,
    parent_path: Option<String>,
    name: String,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadPartUrlRequest {
    part_number: i32,
    checksum_sha256: String,
}

#[derive(Deserialize)]
pub(crate) struct UploadPartUrlsRequest {
    parts: Vec<UploadPartUrlRequest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadInitResponse {
    upload_id: String,
    root_folder_id: Option<String>,
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
pub(crate) struct UploadPartUrlsResponse {
    parts: Vec<UploadPartUrlResponse>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadPartUrlResponse {
    part_number: i32,
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
    vault_generation_id: Option<String>,
    vault_record_version: Option<i64>,
    vault_record_hash: Option<String>,
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
    has_active_share_link: bool,
    shared_at: Option<String>,
    created_at: String,
    updated_at: String,
    trashed_at: Option<String>,
    e2ee_state: String,
    vault_generation_id: Option<String>,
    vault_record_version: Option<i64>,
    vault_record_hash: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderArchiveManifestResponse {
    root_id: String,
    entries: Vec<FolderArchiveEntry>,
    total_bytes: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderArchiveEntry {
    id: String,
    name: String,
    mime_type: Option<String>,
    entry_type: String,
    parent_id: Option<String>,
    size_bytes: i64,
    e2ee_state: String,
    updated_at: String,
    content_version: String,
    vault_generation_id: Option<String>,
    vault_record_hash: Option<String>,
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
    owner_id: String,
    original_name: String,
    storage_name: String,
    mime_type: Option<String>,
}

struct UploadActor {
    owner_id: String,
    share_link_id: Option<String>,
    editor_grant: Option<EditorShareGrant>,
}

struct FilePage {
    entries: Vec<FileEntry>,
    next_cursor: Option<String>,
    has_more: bool,
}

struct FolderContext {
    current_folder_id: Option<String>,
    breadcrumbs: Vec<FolderBreadcrumb>,
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
    let user = require_principal(&state, &request).await?;

    let view = normalize_view(query.view.as_deref());
    let sort = normalize_sort(query.sort.as_deref()).or(Some(if view == "files" {
        "name"
    } else {
        "updated"
    }));
    let direction = normalize_sort_direction(query.direction.as_deref(), sort);
    let _recursive_permit = if query
        .folder
        .as_deref()
        .is_some_and(|folder_id| !folder_id.trim().is_empty())
        && matches!(view, "files" | "shared")
    {
        Some(state.acquire_recursive_operation(&user.id).await?)
    } else {
        None
    };
    let folder_context = match view {
        "files" => resolve_owned_folder_context(&state, &user, query.folder.as_deref()).await?,
        "shared" => resolve_shared_folder_context(&state, &user, query.folder.as_deref()).await?,
        _ => FolderContext {
            current_folder_id: None,
            breadcrumbs: Vec::new(),
        },
    };
    let current_folder_id = folder_context.current_folder_id;
    let breadcrumbs = folder_context.breadcrumbs;
    let page_size = query
        .limit
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);
    let (page, summary) = futures_util::try_join!(
        list_entries(
            &state,
            &user,
            view,
            current_folder_id.as_deref(),
            sort,
            direction,
            query.cursor.as_deref(),
            page_size,
        ),
        get_summary(&state, &user),
    )?;
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
    let user = require_principal(&state, &request).await?;
    let summary = get_summary(&state, &user).await?;

    Ok(HttpResponse::Ok().json(storage_stats(&state, summary.used_bytes)))
}

pub async fn create_folder_manifest(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Payload,
) -> Result<HttpResponse> {
    let actor = require_upload_actor(&state, &request, true).await?;
    if state.config.e2ee_mode.is_enabled() {
        return Ok(HttpResponse::Conflict()
            .body("plaintext folder manifests are disabled; use the encrypted vault upload API"));
    }
    state.db.release_request_connection().await;
    let _upload_permit = state
        .upload_control_limiter
        .try_acquire(&actor.owner_id)
        .map_err(|()| LoadShedError::too_many_requests("upload control capacity is full"))?;
    let _recursive_permit = state.acquire_recursive_operation(&actor.owner_id).await?;
    let body = parse_json_body::<FolderManifestRequest>(&request, body, FOLDER_MANIFEST_JSON_LIMIT)
        .await?;
    if body.relative_paths.is_empty() || body.relative_paths.len() > MAX_FOLDER_MANIFEST_PATHS {
        return Err(error::ErrorBadRequest("invalid folder manifest size"));
    }

    let upload_paths = body
        .relative_paths
        .iter()
        .map(|path| sanitize_upload_path(path))
        .collect::<Vec<_>>();
    if upload_paths.iter().any(Vec::is_empty) {
        return Err(error::ErrorBadRequest(
            "folder manifest contains an invalid upload path",
        ));
    }

    let base_parent_id = if let Some(grant) = &actor.editor_grant {
        Some(editor_parent(&state, grant, body.parent_id.as_deref()).await?)
    } else {
        validate_folder(&state, &actor.owner_id, body.parent_id.as_deref()).await?
    };
    let levels = plan_folder_manifest(&upload_paths);
    let folder_count = levels.iter().map(Vec::len).sum::<usize>();
    if folder_count > MAX_FOLDER_MANIFEST_FOLDERS {
        return Err(error::ErrorBadRequest(
            "folder manifest contains too many folders",
        ));
    }
    if levels.is_empty() {
        return Ok(HttpResponse::Ok().json(FolderManifestResponse {
            parent_ids: vec![base_parent_id; upload_paths.len()],
            root_folder_id: None,
        }));
    }

    let first_root_path = upload_paths
        .iter()
        .find(|path| path.len() > 1)
        .and_then(|path| path.first())
        .cloned();
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    query_one_cached(
        &transaction,
        "SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:legacy-folder-tree:' || $1, 0))",
        &[&actor.owner_id],
    )
    .await
    .map_err(error::ErrorInternalServerError)?;

    let mut resolved = HashMap::<String, String>::with_capacity(folder_count);
    for level in levels {
        let paths = level
            .iter()
            .map(|folder| folder.path.clone())
            .collect::<Vec<_>>();
        let parent_ids = level
            .iter()
            .map(|folder| {
                let Some(parent_path) = folder.parent_path.as_ref() else {
                    return Ok(base_parent_id.clone());
                };
                resolved.get(parent_path).cloned().map(Some).ok_or_else(|| {
                    error::ErrorInternalServerError("folder manifest parent was not resolved")
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let names = level
            .iter()
            .map(|folder| folder.name.clone())
            .collect::<Vec<_>>();
        let rows = query_cached(
            &transaction,
            "
                SELECT path, id
                FROM ensure_legacy_folder_level($1, $2, $3, $4)
            ",
            &[&actor.owner_id, &paths, &parent_ids, &names],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
        if rows.len() != level.len() {
            return Err(error::ErrorInternalServerError(
                "folder manifest did not resolve every folder",
            ));
        }
        for row in rows {
            resolved.insert(row.get("path"), row.get("id"));
        }
    }

    let parent_ids = upload_paths
        .iter()
        .map(|path| {
            if path.len() <= 1 {
                return Ok(base_parent_id.clone());
            }
            let parent_path = path[..path.len() - 1].join("/");
            resolved
                .get(&parent_path)
                .cloned()
                .map(Some)
                .ok_or_else(|| {
                    error::ErrorInternalServerError(
                        "folder manifest did not resolve an upload parent",
                    )
                })
        })
        .collect::<Result<Vec<_>>>()?;
    let root_folder_id = first_root_path.and_then(|path| resolved.get(&path).cloned());
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::Ok().json(FolderManifestResponse {
        parent_ids,
        root_folder_id,
    }))
}

pub async fn init_upload(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Payload,
) -> Result<HttpResponse> {
    let actor = require_upload_actor(&state, &request, true).await?;
    let _upload_permit = state
        .upload_control_limiter
        .try_acquire(&actor.owner_id)
        .map_err(|()| LoadShedError::too_many_requests("upload control capacity is full"))?;
    let _recursive_permit = if actor.editor_grant.is_some() {
        Some(state.acquire_recursive_operation(&actor.owner_id).await?)
    } else {
        None
    };

    if state.config.e2ee_mode.is_enabled() {
        return Ok(HttpResponse::Conflict()
            .body("plaintext uploads are disabled; use the encrypted vault upload API"));
    }
    let body =
        parse_json_body::<UploadInitRequest>(&request, body, UPLOAD_CONTROL_JSON_LIMIT).await?;

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
    let (mut parent_id, replacement_file_id) = if let Some(grant) = &actor.editor_grant {
        let replacement_file_id =
            validate_editor_replacement(grant, body.replacement_file_id.as_deref())?;
        let parent_id = if replacement_file_id.is_some() {
            None
        } else {
            Some(editor_parent(&state, grant, body.parent_id.as_deref()).await?)
        };
        (parent_id, replacement_file_id)
    } else {
        (
            validate_folder(&state, &actor.owner_id, body.parent_id.as_deref()).await?,
            body.replacement_file_id.clone(),
        )
    };

    let mut root_folder_id = None;
    for folder_name in folder_names {
        let folder_id =
            ensure_folder(&state, &actor.owner_id, parent_id.as_deref(), folder_name).await?;
        if root_folder_id.is_none() {
            root_folder_id = Some(folder_id.clone());
        }
        parent_id = Some(folder_id);
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
        &actor.owner_id,
        actor.share_link_id.as_deref(),
        replacement_file_id.as_deref(),
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

        state.db.release_request_connection().await;
        let existing_parts =
            if let Some(multipart_upload_id) = existing.multipart_upload_id.as_deref() {
                state
                    .storage_operations
                    .run(
                        &actor.owner_id,
                        state
                            .storage
                            .uploaded_parts(&existing.object_key, multipart_upload_id),
                    )
                    .await?
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
            root_folder_id,
            mode: existing.mode.clone(),
            upload_url: (existing.mode == "local")
                .then(|| format!("/api/files/uploads/{}/content", existing.id)),
            existing_parts,
            part_size_bytes,
            content_type,
        }));
    }

    let upload_id = format!("upl_{}", create_storage_name()?);
    let file_id = format!("fil_{}", create_storage_name()?);
    let object_key = format!(
        "users/{}/files/{}/{}",
        actor.owner_id,
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
    let replacement_credit = if let Some(replacement_file_id) = replacement_file_id.as_deref() {
        let replacement = if actor.editor_grant.is_some() {
            query_opt_cached(
                &transaction,
                "
                    SELECT size_bytes
                    FROM files
                    WHERE id = $1 AND owner_id = $2 AND entry_type = 'file'
                      AND state = 'active' AND e2ee_state IN ('legacy', 'staged')
                    FOR UPDATE
                ",
                &[&replacement_file_id, &actor.owner_id],
            )
            .await
            .map_err(error::ErrorInternalServerError)?
        } else {
            query_opt_cached(
                &transaction,
                "
                    SELECT size_bytes
                    FROM files
                    WHERE id = $1 AND owner_id = $2 AND entry_type = 'file'
                      AND state = 'active' AND e2ee_state IN ('legacy', 'staged')
                      AND parent_id IS NOT DISTINCT FROM $3
                      AND lower(original_name) = lower($4)
                    FOR UPDATE
                ",
                &[
                    &replacement_file_id,
                    &actor.owner_id,
                    &parent_id,
                    &display_name,
                ],
            )
            .await
            .map_err(error::ErrorInternalServerError)?
        }
        .ok_or_else(|| {
            error::ErrorConflict("the replacement file no longer matches the upload path")
        })?;
        let competing = query_opt_cached(
            &transaction,
            "
                SELECT id
                FROM file_uploads
                WHERE owner_id = $1 AND replacement_file_id = $2
                  AND status IN ('initializing', 'pending', 'completing', 'aborting')
                LIMIT 1
            ",
            &[&actor.owner_id, &replacement_file_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
        if competing.is_some() {
            return Ok(HttpResponse::Conflict()
                .body("the selected file already has a replacement in progress"));
        }
        replacement.get::<_, i64>("size_bytes")
    } else {
        0
    };
    let reservation = reservation_amount(size_bytes, replacement_credit)?;
    reserve_upload_capacity(
        &transaction,
        &actor.owner_id,
        reservation,
        state.config.storage_quota_bytes,
    )
    .await?;

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
                  share_link_id,
                  replacement_file_id,
                  reservation_bytes,
                  status,
                  expires_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, $12, $13, 'initializing', now() + interval '24 hours')
            ",
            &[
                &upload_id,
                &file_id,
                &actor.owner_id,
                &parent_id,
                &display_name,
                &object_key,
                &mime_type,
                &size_bytes,
                &upload_mode,
                &part_size_bytes,
                &actor.share_link_id,
                &replacement_file_id,
                &reservation.ledger_bytes,
            ],
        )
        .await;

    if let Err(database_error) = insert_result {
        return Err(error::ErrorInternalServerError(database_error));
    }
    match transaction.commit().await {
        Ok(()) => drop(client),
        Err(commit_error) => {
            // A failed COMMIT can leave the transaction connection unusable. Reconcile on a
            // fresh checkout so an acknowledged commit is never mistaken for a rollback.
            drop(client);
            state.db.release_request_connection().await;
            match state
                .db
                .query_opt(
                    "SELECT id FROM file_uploads WHERE id = $1 AND owner_id = $2 LIMIT 1",
                    &[&upload_id, &actor.owner_id],
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
    }
    state.db.release_request_connection().await;

    let prepared = match state
        .storage_operations
        .run(
            &actor.owner_id,
            state.storage.prepare_upload(
                &upload_id,
                &object_key,
                Some(&content_type),
                body.size_bytes,
            ),
        )
        .await?
    {
        Ok(prepared) => prepared,
        Err(storage_error) => {
            let grace_seconds =
                i64::try_from(state.config.storage_multipart_orphan_grace_seconds).unwrap_or(3_600);
            let _ = state
                .db
                .execute(
                    "UPDATE file_uploads SET expires_at = now() + ($1::bigint * interval '1 second') WHERE id = $2 AND owner_id = $3 AND status = 'initializing'",
                    &[&grace_seconds, &upload_id, &actor.owner_id],
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
            &actor.owner_id,
            &object_key,
            prepared.multipart_upload_id.as_deref(),
            &["initializing"],
            None,
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
            &[&prepared.multipart_upload_id, &upload_id, &actor.owner_id],
        )
        .await;

    match activated {
        Ok(1) => {}
        Ok(_) => {
            let _ = enqueue_upload_cleanup(
                &state,
                &upload_id,
                &actor.owner_id,
                &object_key,
                prepared.multipart_upload_id.as_deref(),
                &["initializing"],
                None,
            )
            .await;
            return Ok(HttpResponse::Conflict().body("upload initialization was canceled"));
        }
        Err(database_error) => {
            log::error!("could not persist provider upload id for {upload_id}: {database_error}");
            let _ = enqueue_upload_cleanup(
                &state,
                &upload_id,
                &actor.owner_id,
                &object_key,
                prepared.multipart_upload_id.as_deref(),
                &["initializing"],
                None,
            )
            .await;
            return Err(error::ErrorInternalServerError(database_error));
        }
    }

    Ok(HttpResponse::Created().json(UploadInitResponse {
        upload_id,
        root_folder_id,
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
    let actor = require_upload_actor(&state, &request, true).await?;
    let _upload_permit = state
        .upload_control_limiter
        .try_acquire(&actor.owner_id)
        .map_err(|()| LoadShedError::too_many_requests("upload control capacity is full"))?;
    let Some(upload) = get_upload(&state, &actor, &path.into_inner()).await? else {
        return Ok(HttpResponse::NotFound().finish());
    };

    if upload.mode != "local" || upload.status != "pending" {
        return Ok(HttpResponse::Conflict().finish());
    }
    state.db.release_request_connection().await;

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
    let expected_bytes = u64::try_from(upload.size_bytes)
        .map_err(|_| error::ErrorInternalServerError("invalid upload size"))?;
    let chunk_range = local_upload_chunk(&request, expected_bytes)?;
    let (chunk_offset, chunk_bytes) = chunk_range.unwrap_or((0, expected_bytes));
    let chunk_end = chunk_offset
        .checked_add(chunk_bytes)
        .ok_or_else(|| error::ErrorPayloadTooLarge("upload is too large"))?;

    if chunk_end > expected_bytes {
        return Err(error::ErrorPayloadTooLarge("upload is too large"));
    }

    if chunk_range.is_some() {
        if let Ok(metadata) = tokio::fs::metadata(&object_path).await
            && metadata.len() == expected_bytes
            && chunk_end == expected_bytes
        {
            return Ok(HttpResponse::NoContent().finish());
        }

        let existing_bytes = match tokio::fs::metadata(&temporary_path).await {
            Ok(metadata) => metadata.len(),
            Err(metadata_error) if metadata_error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(metadata_error) => return Err(error::ErrorInternalServerError(metadata_error)),
        };

        if chunk_bytes > 0 && existing_bytes == chunk_end {
            return Ok(HttpResponse::NoContent().finish());
        }
        if existing_bytes < chunk_offset || existing_bytes > chunk_end {
            return Err(error::ErrorConflict("upload chunk offset does not match"));
        }
        if existing_bytes != chunk_offset {
            let partial = OpenOptions::new()
                .write(true)
                .open(&temporary_path)
                .await
                .map_err(error::ErrorInternalServerError)?;
            partial
                .set_len(chunk_offset)
                .await
                .map_err(error::ErrorInternalServerError)?;
        }
    }

    let mut file = if chunk_range.is_some() {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&temporary_path)
            .await
            .map_err(error::ErrorInternalServerError)?
    } else {
        AsyncFile::create(&temporary_path)
            .await
            .map_err(error::ErrorInternalServerError)?
    };
    let mut written_bytes = 0_u64;

    while let Some(payload_chunk) = payload.next().await {
        let payload_chunk = match payload_chunk {
            Ok(payload_chunk) => payload_chunk,
            Err(payload_error) => {
                rollback_local_upload_chunk(
                    &mut file,
                    &temporary_path,
                    chunk_offset,
                    chunk_range.is_some(),
                )
                .await;
                return Err(error::ErrorBadRequest(payload_error));
            }
        };
        written_bytes = written_bytes
            .checked_add(payload_chunk.len() as u64)
            .ok_or_else(|| error::ErrorPayloadTooLarge("upload is too large"))?;

        if written_bytes > chunk_bytes || chunk_end > MAX_UPLOAD_BYTES {
            rollback_local_upload_chunk(
                &mut file,
                &temporary_path,
                chunk_offset,
                chunk_range.is_some(),
            )
            .await;
            return Err(error::ErrorPayloadTooLarge("upload is too large"));
        }

        if let Err(write_error) = file.write_all(&payload_chunk).await {
            rollback_local_upload_chunk(
                &mut file,
                &temporary_path,
                chunk_offset,
                chunk_range.is_some(),
            )
            .await;
            return Err(error::ErrorInternalServerError(write_error));
        }
    }

    if let Err(flush_error) = file.flush().await {
        rollback_local_upload_chunk(
            &mut file,
            &temporary_path,
            chunk_offset,
            chunk_range.is_some(),
        )
        .await;
        return Err(error::ErrorInternalServerError(flush_error));
    }

    if written_bytes != chunk_bytes {
        rollback_local_upload_chunk(
            &mut file,
            &temporary_path,
            chunk_offset,
            chunk_range.is_some(),
        )
        .await;
        return Err(error::ErrorBadRequest(
            "uploaded chunk byte count does not match declaration",
        ));
    }
    drop(file);

    if chunk_end < expected_bytes {
        return Ok(HttpResponse::NoContent().finish());
    }

    if let Err(rename_error) = tokio::fs::rename(&temporary_path, &object_path).await {
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error::ErrorInternalServerError(rename_error));
    }

    Ok(HttpResponse::NoContent().finish())
}

fn local_upload_chunk(request: &HttpRequest, expected_bytes: u64) -> Result<Option<(u64, u64)>> {
    let offset = request.headers().get(UPLOAD_OFFSET_HEADER);
    let length = request.headers().get(UPLOAD_LENGTH_HEADER);

    let (Some(offset), Some(length)) = (offset, length) else {
        if offset.is_some() || length.is_some() {
            return Err(error::ErrorBadRequest(
                "upload chunk headers must be provided together",
            ));
        }
        return Ok(None);
    };

    let offset = offset
        .to_str()
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| error::ErrorBadRequest("invalid upload chunk offset"))?;
    let length = length
        .to_str()
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| error::ErrorBadRequest("invalid upload chunk length"))?;
    let end = offset
        .checked_add(length)
        .ok_or_else(|| error::ErrorPayloadTooLarge("upload is too large"))?;

    if end > expected_bytes || length > MAX_UPLOAD_BYTES {
        return Err(error::ErrorPayloadTooLarge("upload is too large"));
    }

    if let Some(content_length) = request.headers().get(CONTENT_LENGTH) {
        let content_length = content_length
            .to_str()
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| error::ErrorBadRequest("invalid content length"))?;
        if content_length != length {
            return Err(error::ErrorBadRequest(
                "upload chunk length does not match content length",
            ));
        }
    }

    Ok(Some((offset, length)))
}

async fn rollback_local_upload_chunk(
    file: &mut AsyncFile,
    temporary_path: &std::path::Path,
    chunk_offset: u64,
    chunked: bool,
) {
    if chunked {
        let _ = file.set_len(chunk_offset).await;
        let _ = file.flush().await;
    } else {
        let _ = file.set_len(0).await;
        let _ = tokio::fs::remove_file(temporary_path).await;
    }
}

pub async fn presign_upload_content(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    body: web::Payload,
) -> Result<HttpResponse> {
    let actor = require_upload_actor(&state, &request, true).await?;
    let _upload_permit = state
        .upload_control_limiter
        .try_acquire(&actor.owner_id)
        .map_err(|()| LoadShedError::too_many_requests("upload control capacity is full"))?;
    let Some(upload) = get_upload(&state, &actor, &path.into_inner()).await? else {
        return Ok(HttpResponse::NotFound().finish());
    };

    if upload.mode != "single" || upload.status != "pending" {
        return Ok(HttpResponse::Conflict().finish());
    }
    let body =
        parse_json_body::<UploadChecksumRequest>(&request, body, UPLOAD_CONTROL_JSON_LIMIT).await?;

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
            &[
                &checksum,
                &upload.id,
                &upload.owner_id,
                &write_lifetime_seconds,
            ],
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
        .storage_operations
        .run(
            &actor.owner_id,
            state.storage.presign_single_upload(
                &upload.object_key,
                content_type,
                &checksum,
                content_length,
            ),
        )
        .await?
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
    body: web::Payload,
) -> Result<HttpResponse> {
    let actor = require_upload_actor(&state, &request, true).await?;
    let _upload_permit = state
        .upload_control_limiter
        .try_acquire(&actor.owner_id)
        .map_err(|()| LoadShedError::too_many_requests("upload control capacity is full"))?;
    let (upload_id, part_number) = path.into_inner();
    let Some(upload) = get_upload(&state, &actor, &upload_id).await? else {
        return Ok(HttpResponse::NotFound().finish());
    };

    if upload.mode != "multipart" || upload.status != "pending" {
        return Ok(HttpResponse::Conflict().finish());
    }
    let body =
        parse_json_body::<UploadChecksumRequest>(&request, body, UPLOAD_CONTROL_JSON_LIMIT).await?;

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
        .storage_operations
        .run(
            &actor.owner_id,
            state.storage.presign_upload_part(
                &upload.object_key,
                multipart_upload_id,
                part_number,
                &checksum,
                content_length,
            ),
        )
        .await?
        .map_err(error::ErrorBadGateway)?;

    Ok(HttpResponse::Ok().json(UploadUrlResponse {
        url,
        content_length,
    }))
}

pub async fn presign_upload_parts(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    body: web::Payload,
) -> Result<HttpResponse> {
    let actor = require_upload_actor(&state, &request, true).await?;
    let _upload_permit = state
        .upload_control_limiter
        .try_acquire(&actor.owner_id)
        .map_err(|()| LoadShedError::too_many_requests("upload control capacity is full"))?;
    let Some(upload) = get_upload(&state, &actor, &path.into_inner()).await? else {
        return Ok(HttpResponse::NotFound().finish());
    };
    if upload.mode != "multipart" || upload.status != "pending" {
        return Ok(HttpResponse::Conflict().finish());
    }
    let body =
        parse_json_body::<UploadPartUrlsRequest>(&request, body, UPLOAD_CONTROL_JSON_LIMIT).await?;
    if body.parts.is_empty() || body.parts.len() > MAX_PRESIGN_PARTS {
        return Err(error::ErrorBadRequest(
            "multipart presign batch must contain 1 to 32 parts",
        ));
    }

    let size_bytes = u64::try_from(upload.size_bytes)
        .map_err(|_| error::ErrorInternalServerError("invalid upload size"))?;
    let part_size_bytes = upload_part_size(&upload)?;
    let part_count = size_bytes.div_ceil(part_size_bytes);
    let mut parts = body
        .parts
        .iter()
        .map(|part| {
            let part_number = u64::try_from(part.part_number)
                .ok()
                .filter(|value| *value > 0 && *value <= part_count)
                .ok_or_else(|| error::ErrorBadRequest("invalid upload part"))?;
            let offset = (part_number - 1)
                .checked_mul(part_size_bytes)
                .ok_or_else(|| error::ErrorBadRequest("invalid upload part"))?;
            let content_length = size_bytes
                .checked_sub(offset)
                .map(|remaining| remaining.min(part_size_bytes))
                .filter(|length| *length > 0)
                .ok_or_else(|| error::ErrorBadRequest("invalid upload part"))?;
            Ok((
                part.part_number,
                validate_sha256_checksum(&part.checksum_sha256)?,
                content_length,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    parts.sort_by_key(|(part_number, _, _)| *part_number);
    if parts.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(error::ErrorBadRequest("upload part is duplicated"));
    }
    let multipart_upload_id = upload
        .multipart_upload_id
        .as_deref()
        .ok_or_else(|| error::ErrorInternalServerError("multipart upload id missing"))?;
    let urls = try_join_all(parts.iter().map(|(part_number, checksum, length)| async {
        state
            .storage_operations
            .run(
                &actor.owner_id,
                state.storage.presign_upload_part(
                    &upload.object_key,
                    multipart_upload_id,
                    *part_number,
                    checksum,
                    *length,
                ),
            )
            .await?
            .map_err(error::ErrorBadGateway)
    }))
    .await?;
    let parts = parts
        .into_iter()
        .zip(urls)
        .map(
            |((part_number, _, content_length), url)| UploadPartUrlResponse {
                part_number,
                url,
                content_length,
            },
        )
        .collect();

    Ok(HttpResponse::Ok().json(UploadPartUrlsResponse { parts }))
}

pub async fn complete_upload(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    body: web::Payload,
) -> Result<HttpResponse> {
    let actor = require_upload_actor(&state, &request, true).await?;
    let _upload_permit = state
        .upload_control_limiter
        .try_acquire(&actor.owner_id)
        .map_err(|()| LoadShedError::too_many_requests("upload control capacity is full"))?;
    let Some(mut upload) = get_upload(&state, &actor, &path.into_inner()).await? else {
        return Ok(HttpResponse::NotFound().finish());
    };
    if upload.status == "completed" {
        return Ok(HttpResponse::Ok().json(upload_complete_response(&upload, "completed")));
    }

    if upload.status == "completing" {
        return Ok(HttpResponse::Accepted().json(upload_complete_response(&upload, "completing")));
    }

    if upload.status != "pending" {
        return Ok(HttpResponse::Conflict().finish());
    }
    let body =
        parse_json_body::<UploadCompleteRequest>(&request, body, UPLOAD_COMPLETION_JSON_LIMIT)
            .await?;

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
        .query_opt(
            "
                UPDATE file_uploads
                SET status = 'completing',
                    expires_at = now() + interval '5 minutes',
                    completion_available_at = now(),
                    completion_locked_until = now() + interval '5 minutes',
                    completion_lease_token = gen_random_uuid()::text,
                    completion_dead_lettered_at = NULL,
                    completion_last_error = NULL
                WHERE id = $1 AND owner_id = $2 AND status = 'pending'
                RETURNING completion_lease_token
            ",
            &[&upload.id, &upload.owner_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    let Some(claimed) = claimed else {
        let Some(current) = get_upload(&state, &actor, &upload.id).await? else {
            return Ok(HttpResponse::NotFound().finish());
        };

        return if current.status == "completed" {
            Ok(HttpResponse::Ok().json(upload_complete_response(&current, "completed")))
        } else if current.status == "completing" {
            Ok(HttpResponse::Accepted().json(upload_complete_response(&current, "completing")))
        } else {
            Ok(HttpResponse::Conflict().json(upload_complete_response(&current, &current.status)))
        };
    };
    upload.completion_lease_token = claimed.get("completion_lease_token");
    state.db.release_request_connection().await;

    let metadata = if upload.mode == "multipart" {
        let multipart_upload_id = upload
            .multipart_upload_id
            .as_deref()
            .ok_or_else(|| error::ErrorInternalServerError("multipart upload id missing"))?;

        match state
            .storage_operations
            .run(
                &actor.owner_id,
                state.storage.complete_multipart(
                    &upload.object_key,
                    multipart_upload_id,
                    &completed_parts,
                    expected_size,
                ),
            )
            .await?
        {
            Ok(metadata) => metadata,
            Err(complete_error) => {
                let delay = completion_retry_delay_seconds(upload.completion_attempts);
                log::warn!(
                    "multipart completion for {} is uncertain and will be reconciled in {delay}s: {}",
                    upload.id,
                    complete_error
                );
                defer_file_upload_completion(
                    &state.db,
                    &upload.id,
                    &upload.owner_id,
                    &upload.completion_lease_token,
                    &complete_error.to_string(),
                    delay,
                )
                .await
                .map_err(error::ErrorInternalServerError)?;
                return Ok(
                    HttpResponse::Accepted().json(upload_complete_response(&upload, "completing"))
                );
            }
        }
    } else {
        match state
            .storage_operations
            .run(
                &actor.owner_id,
                state.storage.object_metadata(&upload.object_key),
            )
            .await?
        {
            Ok(metadata) => metadata,
            Err(metadata_error) => {
                let delay = completion_retry_delay_seconds(upload.completion_attempts);
                log::warn!(
                    "could not verify completing upload {}; background finalization will retry in {delay}s: {}",
                    upload.id,
                    metadata_error
                );
                defer_file_upload_completion(
                    &state.db,
                    &upload.id,
                    &upload.owner_id,
                    &upload.completion_lease_token,
                    &metadata_error.to_string(),
                    delay,
                )
                .await
                .map_err(error::ErrorInternalServerError)?;
                return Ok(
                    HttpResponse::Accepted().json(upload_complete_response(&upload, "completing"))
                );
            }
        }
    };

    if !file_upload_metadata_matches(&upload, &metadata) {
        enqueue_upload_cleanup(
            &state,
            &upload.id,
            &upload.owner_id,
            &upload.object_key,
            upload.multipart_upload_id.as_deref(),
            &["completing"],
            Some(&upload.completion_lease_token),
        )
        .await?;
        return Err(error::ErrorBadRequest(
            "uploaded object integrity check failed",
        ));
    }

    match finalize_file_upload_record(
        &state.db,
        &upload,
        &metadata,
        state.config.storage_presign_seconds,
    )
    .await
    .map_err(error::ErrorInternalServerError)?
    {
        FileUploadFinalizeOutcome::Completed | FileUploadFinalizeOutcome::AlreadyCompleted => {}
        FileUploadFinalizeOutcome::Missing => {
            return Err(error::ErrorNotFound("upload no longer exists"));
        }
        FileUploadFinalizeOutcome::StateChanged => {
            return Err(error::ErrorConflict("upload is no longer completing"));
        }
        FileUploadFinalizeOutcome::ReplacementMismatch => {
            enqueue_upload_cleanup(
                &state,
                &upload.id,
                &upload.owner_id,
                &upload.object_key,
                upload.multipart_upload_id.as_deref(),
                &["completing"],
                Some(&upload.completion_lease_token),
            )
            .await?;
            return Err(error::ErrorConflict(
                "the replacement file no longer matches the upload path",
            ));
        }
    }

    Ok(HttpResponse::Created().json(upload_complete_response(&upload, "completed")))
}

pub async fn upload_status(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    let actor = require_upload_actor(&state, &request, false).await?;
    let Some(upload) = get_upload(&state, &actor, &path.into_inner()).await? else {
        return Ok(HttpResponse::NotFound().finish());
    };

    let response = upload_complete_response(&upload, &upload.status);

    match upload.status.as_str() {
        "completed" | "pending" | "initializing" => Ok(HttpResponse::Ok().json(response)),
        "completing" => Ok(HttpResponse::Accepted().json(response)),
        "aborting" | "aborted" => Ok(HttpResponse::Conflict().json(response)),
        _ => Ok(HttpResponse::Conflict().finish()),
    }
}

fn upload_complete_response(upload: &FileUploadRecord, status: &str) -> UploadCompleteResponse {
    UploadCompleteResponse {
        status: status.to_owned(),
        file_id: upload
            .replacement_file_id
            .clone()
            .unwrap_or_else(|| upload.file_id.clone()),
        location: upload_redirect_location(upload.parent_id.as_deref(), "uploaded"),
        poll_url: format!("/api/files/uploads/{}/status", upload.id),
        retry_after_seconds: 2,
    }
}

pub(crate) const FOLDER_ARCHIVE_ACCESS_QUERY: &str = r#"
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id, owner_id,
             ARRAY[id]::text[] AS visited_ids, 0::integer AS depth
      FROM files
      WHERE id = $1
        AND entry_type = 'folder'
        AND state = 'active'

      UNION ALL

      SELECT parent.id, parent.parent_id, parent.owner_id,
             child.visited_ids || parent.id, child.depth + 1
      FROM files AS parent
      INNER JOIN ancestors AS child ON child.parent_id = parent.id
      WHERE parent.owner_id = child.owner_id
        AND parent.state = 'active'
        AND child.depth < 100
        AND NOT parent.id = ANY(child.visited_ids)
    )
    SELECT selected_folder.owner_id
    FROM ancestors AS selected_folder
    INNER JOIN users AS owners ON owners.id = selected_folder.owner_id
    WHERE selected_folder.id = $1
      AND (
        selected_folder.owner_id = $2
        OR (
          owners.status = 'active'
          AND (
            EXISTS (
              SELECT 1
              FROM ancestors
              INNER JOIN file_shares AS shares
                ON shares.file_id = ancestors.id
               AND shares.owner_id = ancestors.owner_id
              WHERE shares.recipient_id = $2
            )
            OR EXISTS (
              SELECT 1
              FROM ancestors
              INNER JOIN vault_shares AS shares
                ON shares.root_node_id = ancestors.id
               AND shares.owner_id = ancestors.owner_id
               AND shares.status = 'active'
              INNER JOIN vault_share_recipients AS recipients
                ON recipients.share_id = shares.id
               AND recipients.recipient_id = $2
               AND recipients.status = 'active'
            )
          )
        )
      )
    LIMIT 1
"#;

pub(crate) const FOLDER_ARCHIVE_ENTRIES_QUERY: &str = r#"
    SELECT files.id, files.original_name, files.mime_type,
           files.entry_type, files.parent_id, files.size_bytes,
           files.e2ee_state, files.updated_at,
           files.current_generation_id AS vault_generation_id,
           heads.record_hash AS vault_record_hash
    FROM files
    LEFT JOIN vault_node_heads AS heads ON heads.node_id = files.id
    WHERE files.owner_id = $2
      AND files.state = 'active'
      AND files.id = ANY($1::text[])
"#;

pub async fn folder_archive_manifest(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    let user = require_principal(&state, &request).await?;
    let _recursive_permit = state.acquire_recursive_operation(&user.id).await?;
    let root_id = path.into_inner();
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(access) = transaction
        .query_opt(FOLDER_ARCHIVE_ACCESS_QUERY, &[&root_id, &user.id])
        .await
        .map_err(error::ErrorInternalServerError)?
    else {
        return Ok(HttpResponse::NotFound().finish());
    };
    let owner_id: String = access.get("owner_id");
    let Some(tree) = walk_subtree(
        &transaction,
        TreeWalkScope {
            owner_id: &owner_id,
            root_id: &root_id,
            root_state: Some("active"),
            child_state: Some("active"),
            e2ee_state: None,
            max_nodes: MAX_FOLDER_ARCHIVE_ENTRIES.saturating_add(1),
        },
    )
    .await
    .map_err(error::ErrorInternalServerError)?
    else {
        return Ok(HttpResponse::NotFound().finish());
    };
    if tree.truncated {
        return Ok(HttpResponse::PayloadTooLarge()
            .body("This folder has too many entries to download as one ZIP archive."));
    }

    let depths = tree
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node.depth))
        .collect::<HashMap<_, _>>();
    let descendant_ids = tree
        .nodes
        .iter()
        .skip(1)
        .map(|node| node.id.as_str())
        .collect::<Vec<_>>();
    let mut ordered_entries = Vec::with_capacity(descendant_ids.len());
    let mut total_bytes = 0_i64;
    for ids in descendant_ids.chunks(TREE_MUTATION_BATCH_SIZE) {
        let rows = transaction
            .query(FOLDER_ARCHIVE_ENTRIES_QUERY, &[&ids, &owner_id])
            .await
            .map_err(error::ErrorInternalServerError)?;
        for row in rows {
            let id: String = row.get("id");
            let updated_at: time::OffsetDateTime = row.get("updated_at");
            let entry = FolderArchiveEntry {
                id: id.clone(),
                name: row.get("original_name"),
                mime_type: row.get("mime_type"),
                entry_type: row.get("entry_type"),
                parent_id: row.get("parent_id"),
                size_bytes: row.get("size_bytes"),
                e2ee_state: row.get("e2ee_state"),
                updated_at: timestamps::api(updated_at),
                content_version: timestamps::cursor(updated_at),
                vault_generation_id: row
                    .get::<_, Option<Vec<u8>>>("vault_generation_id")
                    .map(|value| URL_SAFE_NO_PAD.encode(value)),
                vault_record_hash: row
                    .get::<_, Option<Vec<u8>>>("vault_record_hash")
                    .map(|value| URL_SAFE_NO_PAD.encode(value)),
            };
            if entry.entry_type == "file" {
                total_bytes = total_bytes.saturating_add(entry.size_bytes.max(0));
                if total_bytes > MAX_FOLDER_ARCHIVE_BYTES {
                    return Ok(HttpResponse::PayloadTooLarge()
                        .body("This folder is larger than the 2 GB browser ZIP safety limit."));
                }
            }
            let rank = i32::from(entry.entry_type != "folder");
            ordered_entries.push((
                depths.get(id.as_str()).copied().unwrap_or_default(),
                rank,
                entry.name.to_lowercase(),
                id,
                entry,
            ));
        }
    }
    if ordered_entries.len() != descendant_ids.len() {
        return Err(error::ErrorInternalServerError(
            "folder archive tree changed during preparation",
        ));
    }
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    ordered_entries.sort_unstable_by(|left, right| {
        (&left.0, &left.1, &left.2, &left.3).cmp(&(&right.0, &right.1, &right.2, &right.3))
    });
    let entries = ordered_entries
        .into_iter()
        .map(|(_, _, _, _, entry)| entry)
        .collect::<Vec<_>>();

    Ok(HttpResponse::Ok().json(FolderArchiveManifestResponse {
        root_id,
        entries,
        total_bytes,
    }))
}

pub async fn abort_upload(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    let actor = require_upload_actor(&state, &request, true).await?;
    let _upload_permit = state
        .upload_control_limiter
        .try_acquire(&actor.owner_id)
        .map_err(|()| LoadShedError::too_many_requests("upload control capacity is full"))?;
    let Some(upload) = get_upload(&state, &actor, &path.into_inner()).await? else {
        return Ok(HttpResponse::NoContent().finish());
    };

    if matches!(upload.status.as_str(), "initializing" | "pending") {
        enqueue_upload_cleanup(
            &state,
            &upload.id,
            &upload.owner_id,
            &upload.object_key,
            upload.multipart_upload_id.as_deref(),
            &["initializing", "pending"],
            None,
        )
        .await?;
        if let Some(object_path) = state.storage.local_path(&upload.object_key) {
            let temporary_path = object_path.with_extension(format!("part-{}", upload.id));
            tokio::spawn(async move {
                if let Err(error) = tokio::fs::remove_file(&temporary_path).await
                    && error.kind() != std::io::ErrorKind::NotFound
                {
                    log::warn!(
                        "could not remove aborted local upload {}: {error}",
                        temporary_path.display()
                    );
                }
            });
        }
    }

    Ok(HttpResponse::Accepted().finish())
}

pub async fn download(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    query: web::Query<DownloadQuery>,
) -> Result<HttpResponse> {
    let user = require_principal(&state, &request).await?;
    let _recursive_permit = state.acquire_recursive_operation(&user.id).await?;
    let expected_version = query
        .version
        .as_deref()
        .map(parse_download_version)
        .transpose()?;
    let Some(file) = get_download_file(&state, &user, &path.into_inner(), expected_version).await?
    else {
        return Ok(HttpResponse::NotFound().finish());
    };
    state.db.release_request_connection().await;

    if let Some(download_url) = state
        .storage_operations
        .run(
            &user.id,
            state
                .storage
                .download_url(&file.storage_name, &file.original_name),
        )
        .await?
        .map_err(error::ErrorBadGateway)?
    {
        return Ok(HttpResponse::Found()
            .insert_header((CACHE_CONTROL, "private, no-store"))
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
    let stream = local_file_stream(stored_file);

    Ok(HttpResponse::Ok()
        .insert_header((CACHE_CONTROL, "private, no-store"))
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
    let user = require_principal(&state, &request).await?;
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
    let user = require_principal(&state, &request).await?;
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
    let user = require_principal(&state, &request).await?;
    require_csrf(&state, &request, &form.csrf_token).await?;
    let _recursive_permit = state.acquire_recursive_operation(&user.id).await?;
    let wants_json = request_wants_json(&request);
    let file_id = path.into_inner();
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .start()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let tree = walk_subtree(
        &transaction,
        TreeWalkScope {
            owner_id: &user.id,
            root_id: &file_id,
            root_state: Some("active"),
            child_state: None,
            e2ee_state: None,
            max_nodes: MAX_TREE_MUTATION_NODES,
        },
    )
    .await
    .map_err(error::ErrorInternalServerError)?;
    if tree.as_ref().is_some_and(|tree| tree.truncated) {
        return Ok(HttpResponse::PayloadTooLarge().body("folder contains too many entries"));
    }
    if let Some(tree) = tree {
        update_tree_state(&transaction, &tree.nodes, &user.id, "trashed")
            .await
            .map_err(error::ErrorInternalServerError)?;
    }
    transaction
        .commit()
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
    let user = require_principal(&state, &request).await?;
    require_csrf(&state, &request, &form.csrf_token).await?;
    let _recursive_permit = state.acquire_recursive_operation(&user.id).await?;
    let wants_json = request_wants_json(&request);
    let file_id = path.into_inner();
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .start()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let tree = walk_subtree(
        &transaction,
        TreeWalkScope {
            owner_id: &user.id,
            root_id: &file_id,
            root_state: Some("trashed"),
            child_state: None,
            e2ee_state: None,
            max_nodes: MAX_TREE_MUTATION_NODES,
        },
    )
    .await
    .map_err(error::ErrorInternalServerError)?;
    if tree.as_ref().is_some_and(|tree| tree.truncated) {
        return Ok(HttpResponse::PayloadTooLarge().body("folder contains too many entries"));
    }
    if let Some(tree) = tree {
        update_tree_state(&transaction, &tree.nodes, &user.id, "active")
            .await
            .map_err(error::ErrorInternalServerError)?;
    }
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    if wants_json {
        return Ok(HttpResponse::Ok().json(FileMutationResponse {
            status: "restored",
            file_id,
        }));
    }

    Ok(redirect("/trash?file=restored"))
}

pub async fn toggle_favorite(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    form: web::Form<CsrfForm>,
) -> Result<HttpResponse> {
    let user = require_principal(&state, &request).await?;
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
    let user = require_principal(&state, &request).await?;
    require_csrf(&state, &request, &form.csrf_token).await?;
    let _recursive_permit = state.acquire_recursive_operation(&user.id).await?;
    let wants_json = request_wants_json(&request);
    let file_id = path.into_inner();
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .start()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(mut tree) = walk_subtree(
        &transaction,
        TreeWalkScope {
            owner_id: &user.id,
            root_id: &file_id,
            root_state: Some("trashed"),
            child_state: None,
            e2ee_state: None,
            max_nodes: MAX_TREE_MUTATION_NODES,
        },
    )
    .await
    .map_err(error::ErrorInternalServerError)?
    else {
        return Ok(redirect("/trash?file=missing"));
    };
    if tree.truncated {
        return Ok(HttpResponse::PayloadTooLarge().body("folder contains too many entries"));
    }
    tree.nodes
        .sort_unstable_by(|left, right| right.depth.cmp(&left.depth).then(left.id.cmp(&right.id)));
    for nodes in tree.nodes.chunks(TREE_MUTATION_BATCH_SIZE) {
        let ids = nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>();
        transaction
            .query_one(DELETE_TREE_BATCH_QUERY, &[&ids, &user.id])
            .await
            .map_err(error::ErrorInternalServerError)?;
    }
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    if wants_json {
        return Ok(HttpResponse::Ok().json(FileMutationResponse {
            status: "deleted",
            file_id,
        }));
    }

    Ok(redirect("/trash?file=deleted"))
}

async fn validate_folder(
    state: &AppState,
    owner_id: &str,
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
            &[&folder_id, &owner_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    folder
        .map(|row| row.get("id"))
        .ok_or_else(|| error::ErrorNotFound("folder not found"))
        .map(Some)
}

const OWNED_FOLDER_CONTEXT_QUERY: &str = "
    WITH RECURSIVE ancestors AS (
      SELECT id, original_name, parent_id, e2ee_state, current_generation_id,
             ARRAY[id]::text[] AS visited_ids, 0 AS depth
      FROM files
      WHERE id = $1
        AND owner_id = $2
        AND entry_type = 'folder'
        AND state = 'active'

      UNION ALL

      SELECT parent.id, parent.original_name, parent.parent_id,
             parent.e2ee_state, parent.current_generation_id,
             child.visited_ids || parent.id, child.depth + 1
      FROM files AS parent
      INNER JOIN ancestors AS child ON child.parent_id = parent.id
      WHERE parent.owner_id = $2
        AND child.depth < 100
        AND NOT parent.id = ANY(child.visited_ids)
    )
    SELECT ancestors.id, ancestors.original_name, ancestors.e2ee_state,
           ancestors.current_generation_id AS vault_generation_id,
           heads.record_version AS vault_record_version,
           heads.record_hash AS vault_record_hash
    FROM ancestors
    LEFT JOIN vault_node_heads AS heads ON heads.node_id = ancestors.id
    ORDER BY depth DESC
";

async fn resolve_owned_folder_context(
    state: &AppState,
    user: &SessionPrincipal,
    folder_id: Option<&str>,
) -> Result<FolderContext> {
    let Some(folder_id) = folder_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(FolderContext {
            current_folder_id: None,
            breadcrumbs: Vec::new(),
        });
    };
    let rows = state
        .db
        .query(OWNED_FOLDER_CONTEXT_QUERY, &[&folder_id, &user.id])
        .await
        .map_err(error::ErrorInternalServerError)?;
    if rows.is_empty() {
        return Err(error::ErrorNotFound("folder not found"));
    }

    Ok(FolderContext {
        current_folder_id: Some(folder_id.to_owned()),
        breadcrumbs: folder_breadcrumbs_from_rows(rows),
    })
}

const SHARED_FOLDER_CONTEXT_QUERY: &str = "
    WITH RECURSIVE ancestors AS (
      SELECT id, original_name, parent_id, owner_id, e2ee_state,
             current_generation_id,
             ARRAY[id]::text[] AS visited_ids, 0 AS depth
      FROM files
      WHERE id = $1 AND entry_type = 'folder' AND state = 'active'

      UNION ALL

      SELECT parent.id, parent.original_name, parent.parent_id,
             parent.owner_id, parent.e2ee_state,
             parent.current_generation_id,
             child.visited_ids || parent.id, child.depth + 1
      FROM files AS parent
      INNER JOIN ancestors AS child ON child.parent_id = parent.id
      WHERE parent.owner_id = child.owner_id AND parent.state = 'active'
        AND child.depth < 100
        AND NOT parent.id = ANY(child.visited_ids)
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
    SELECT ancestors.id, ancestors.original_name, ancestors.e2ee_state,
           ancestors.current_generation_id AS vault_generation_id,
           heads.record_version AS vault_record_version,
           heads.record_hash AS vault_record_hash
    FROM ancestors
    CROSS JOIN access
    LEFT JOIN vault_node_heads AS heads ON heads.node_id = ancestors.id
    WHERE ancestors.depth <= access.root_depth
    ORDER BY ancestors.depth DESC
";

async fn resolve_shared_folder_context(
    state: &AppState,
    user: &SessionPrincipal,
    folder_id: Option<&str>,
) -> Result<FolderContext> {
    let Some(folder_id) = folder_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(FolderContext {
            current_folder_id: None,
            breadcrumbs: Vec::new(),
        });
    };
    let rows = state
        .db
        .query(SHARED_FOLDER_CONTEXT_QUERY, &[&folder_id, &user.id])
        .await
        .map_err(error::ErrorInternalServerError)?;
    if rows.is_empty() {
        return Err(error::ErrorNotFound("shared folder not found"));
    }

    Ok(FolderContext {
        current_folder_id: Some(folder_id.to_owned()),
        breadcrumbs: folder_breadcrumbs_from_rows(rows),
    })
}

fn folder_breadcrumbs_from_rows(rows: Vec<tokio_postgres::Row>) -> Vec<FolderBreadcrumb> {
    rows.into_iter()
        .map(|row| FolderBreadcrumb {
            id: row.get("id"),
            name: row.get("original_name"),
            e2ee_state: row.get("e2ee_state"),
            vault_generation_id: row
                .get::<_, Option<Vec<u8>>>("vault_generation_id")
                .map(|value| URL_SAFE_NO_PAD.encode(value)),
            vault_record_version: row.get("vault_record_version"),
            vault_record_hash: row
                .get::<_, Option<Vec<u8>>>("vault_record_hash")
                .map(|value| URL_SAFE_NO_PAD.encode(value)),
        })
        .collect()
}

async fn ensure_folder(
    state: &AppState,
    owner_id: &str,
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
    query_one_cached(
        &transaction,
        "SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:legacy-folder-tree:' || $1, 0))",
        &[&owner_id],
    )
    .await
    .map_err(error::ErrorInternalServerError)?;
    let paths = vec![name.to_owned()];
    let parent_ids = vec![parent_id];
    let names = vec![name.to_owned()];
    let row = query_one_cached(
        &transaction,
        "
            SELECT id
            FROM ensure_legacy_folder_level($1, $2, $3, $4)
        ",
        &[&owner_id, &paths, &parent_ids, &names],
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
    user: &SessionPrincipal,
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
              (files.legacy_share_count > 0 OR files.vault_share_count > 0) AS shared,
              (
                files.permanent_share_link_count > 0
                OR COALESCE(files.latest_share_link_expiry > now(), FALSE)
              ) AS has_active_share_link,
              NULL::timestamptz AS shared_at,
              files.created_at,
              files.updated_at,
              files.trashed_at,
              files.current_generation_id AS vault_generation_id,
              heads.record_version AS vault_record_version,
              heads.record_hash AS vault_record_hash,
              {rank}::integer AS cursor_rank,
              {name} AS cursor_name,
              {date} AS cursor_date
            FROM files
            LEFT JOIN vault_node_heads AS heads ON heads.node_id = files.id
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
    user: &SessionPrincipal,
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
              false AS has_active_share_link,
              file_shares.created_at AS shared_at,
              files.created_at,
              files.updated_at,
              files.trashed_at,
              files.current_generation_id AS vault_generation_id,
              heads.record_version AS vault_record_version,
              heads.record_hash AS vault_record_hash,
              1::integer AS cursor_rank,
              {name} AS cursor_name,
              {date} AS cursor_date
            FROM file_shares
            INNER JOIN files ON files.id = file_shares.file_id
            INNER JOIN users AS owners ON owners.id = files.owner_id
            LEFT JOIN vault_node_heads AS heads ON heads.node_id = files.id
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
    user: &SessionPrincipal,
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
              SELECT id, parent_id, owner_id,
                     ARRAY[id]::text[] AS visited_ids, 0::integer AS depth
              FROM files WHERE id = $2
              UNION ALL
              SELECT parent.id, parent.parent_id, parent.owner_id,
                     child.visited_ids || parent.id, child.depth + 1
              FROM files AS parent
              INNER JOIN ancestors AS child ON child.parent_id = parent.id
              WHERE parent.owner_id = child.owner_id
                AND child.depth < 100
                AND NOT parent.id = ANY(child.visited_ids)
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
                   false AS has_active_share_link,
                   access.created_at AS shared_at,
                   files.created_at,
                   files.updated_at,
                   NULL::timestamptz AS trashed_at,
                   files.current_generation_id AS vault_generation_id,
                   heads.record_version AS vault_record_version,
                   heads.record_hash AS vault_record_hash,
                   {rank}::integer AS cursor_rank,
                   {name} AS cursor_name,
                   {date} AS cursor_date
            FROM access
            INNER JOIN files ON files.owner_id = access.owner_id
              AND files.parent_id = $2 AND files.state = 'active'
            INNER JOIN users AS owners ON owners.id = files.owner_id
            LEFT JOIN vault_node_heads AS heads ON heads.node_id = files.id
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
        cursor_date: timestamps::cursor(row.get("cursor_date")),
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
            has_active_share_link: row.get("has_active_share_link"),
            shared_at: timestamps::optional_api(row.get("shared_at")),
            created_at: timestamps::api(row.get("created_at")),
            updated_at: timestamps::api(row.get("updated_at")),
            trashed_at: timestamps::optional_api(row.get("trashed_at")),
            e2ee_state: row.get("e2ee_state"),
            vault_generation_id: row
                .get::<_, Option<Vec<u8>>>("vault_generation_id")
                .map(|value| URL_SAFE_NO_PAD.encode(value)),
            vault_record_version: row.get("vault_record_version"),
            vault_record_hash: row
                .get::<_, Option<Vec<u8>>>("vault_record_hash")
                .map(|value| URL_SAFE_NO_PAD.encode(value)),
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

async fn get_summary(state: &AppState, user: &SessionPrincipal) -> Result<FilesSummary> {
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

pub(crate) const DOWNLOAD_FILE_QUERY: &str = r#"
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id, owner_id,
             ARRAY[id]::text[] AS visited_ids, 0::integer AS depth
      FROM files
      WHERE id = $1

      UNION ALL

      SELECT parent.id, parent.parent_id, parent.owner_id,
             child.visited_ids || parent.id, child.depth + 1
      FROM files AS parent
      INNER JOIN ancestors AS child ON child.parent_id = parent.id
      WHERE parent.owner_id = child.owner_id
        AND child.depth < 100
        AND NOT parent.id = ANY(child.visited_ids)
    )
    SELECT
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
      AND ($3::timestamptz IS NULL OR files.updated_at = $3)
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
"#;

async fn get_download_file(
    state: &AppState,
    user: &SessionPrincipal,
    file_id: &str,
    expected_version: Option<time::OffsetDateTime>,
) -> Result<Option<StoredFile>> {
    let row = state
        .db
        .query_opt(
            DOWNLOAD_FILE_QUERY,
            &[&file_id, &user.id, &expected_version],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(row.map(|row| StoredFile {
        owner_id: row.get("owner_id"),
        original_name: row.get("original_name"),
        storage_name: row.get("storage_name"),
        mime_type: row.get("mime_type"),
    }))
}

fn parse_download_version(value: &str) -> Result<time::OffsetDateTime> {
    let bytes = value.as_bytes();
    let has_wire_shape = bytes.len() == 27
        && [4, 7, 10, 13, 16, 19, 26]
            .into_iter()
            .zip(*b"--T::.Z")
            .all(|(index, expected)| bytes[index] == expected)
        && bytes.iter().enumerate().all(|(index, byte)| {
            [4, 7, 10, 13, 16, 19, 26].contains(&index) || byte.is_ascii_digit()
        });
    if !has_wire_shape {
        return Err(error::ErrorBadRequest("invalid file version"));
    }

    let number = |start: usize, end: usize| value[start..end].parse::<u32>().ok();
    let parsed = (|| {
        let year = i32::try_from(number(0, 4)?).ok()?;
        let month = time::Month::try_from(u8::try_from(number(5, 7)?).ok()?).ok()?;
        let day = u8::try_from(number(8, 10)?).ok()?;
        let hour = u8::try_from(number(11, 13)?).ok()?;
        let minute = u8::try_from(number(14, 16)?).ok()?;
        let second = u8::try_from(number(17, 19)?).ok()?;
        let microsecond = number(20, 26)?;
        let date = time::Date::from_calendar_date(year, month, day).ok()?;
        let time = time::Time::from_hms_micro(hour, minute, second, microsecond).ok()?;
        Some(time::PrimitiveDateTime::new(date, time).assume_utc())
    })();

    parsed.ok_or_else(|| error::ErrorBadRequest("invalid file version"))
}

async fn get_upload(
    state: &AppState,
    actor: &UploadActor,
    upload_id: &str,
) -> Result<Option<FileUploadRecord>> {
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
                  checksum_sha256,
                  share_link_id,
                  replacement_file_id,
                  expires_at,
                  completion_attempts,
                  COALESCE(completion_lease_token, '') AS completion_lease_token
                FROM file_uploads
                WHERE id = $1
                  AND owner_id = $2
                  AND ($3::text IS NULL OR share_link_id = $3)
                  AND (
                    status IN ('completed', 'completing')
                    OR expires_at > now()
                  )
                LIMIT 1
            ",
            &[&upload_id, &actor.owner_id, &actor.share_link_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(row.map(file_upload_from_row))
}

#[allow(clippy::too_many_arguments)]
async fn find_resumable_upload(
    state: &AppState,
    owner_id: &str,
    share_link_id: Option<&str>,
    replacement_file_id: Option<&str>,
    parent_id: Option<&str>,
    original_name: &str,
    mime_type: &Option<String>,
    size_bytes: i64,
) -> Result<Option<FileUploadRecord>> {
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
                  checksum_sha256,
                  share_link_id,
                  replacement_file_id,
                  expires_at,
                  completion_attempts,
                  COALESCE(completion_lease_token, '') AS completion_lease_token
                FROM file_uploads
                WHERE owner_id = $1
                  AND parent_id IS NOT DISTINCT FROM $2
                  AND original_name = $3
                  AND size_bytes = $4
                  AND mime_type IS NOT DISTINCT FROM $5
                  AND share_link_id IS NOT DISTINCT FROM $6
                  AND replacement_file_id IS NOT DISTINCT FROM $7
                  AND (
                    status = 'completing'
                    OR (
                      status IN ('initializing', 'pending')
                      AND expires_at > now()
                    )
                  )
                ORDER BY created_at DESC
                LIMIT 1
            ",
            &[
                &owner_id,
                &parent_id,
                &original_name,
                &size_bytes,
                &mime_type,
                &share_link_id,
                &replacement_file_id,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(row.map(file_upload_from_row))
}

async fn require_header_csrf(state: &AppState, request: &HttpRequest) -> Result<()> {
    let csrf_token = request
        .headers()
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| error::ErrorForbidden("csrf token required"))?;

    require_csrf(state, request, csrf_token).await
}

async fn require_upload_actor(
    state: &AppState,
    request: &HttpRequest,
    require_mutation_csrf: bool,
) -> Result<UploadActor> {
    if let Some(grant) = editor_grant_from_header(state, request).await? {
        return Ok(UploadActor {
            owner_id: grant.owner_id.clone(),
            share_link_id: Some(grant.id.clone()),
            editor_grant: Some(grant),
        });
    }

    let user = require_principal(state, request).await?;
    if require_mutation_csrf {
        require_header_csrf(state, request).await?;
    }
    Ok(UploadActor {
        owner_id: user.id,
        share_link_id: None,
        editor_grant: None,
    })
}

async fn enqueue_upload_cleanup(
    state: &AppState,
    upload_id: &str,
    owner_id: &str,
    object_key: &str,
    multipart_upload_id: Option<&str>,
    from_statuses: &[&str],
    lease_token: Option<&str>,
) -> Result<bool> {
    transition_file_upload_to_cleanup(
        &state.db,
        upload_id,
        owner_id,
        object_key,
        multipart_upload_id,
        from_statuses,
        lease_token,
    )
    .await
    .map_err(error::ErrorInternalServerError)
}

fn upload_part_size(upload: &FileUploadRecord) -> Result<u64> {
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

fn plan_folder_manifest(upload_paths: &[Vec<String>]) -> Vec<Vec<PlannedFolder>> {
    let mut levels = Vec::<BTreeMap<String, PlannedFolder>>::new();
    for upload_path in upload_paths {
        let mut path_components = Vec::<&str>::new();
        let mut parent_path = None;
        for (depth, name) in upload_path
            .iter()
            .take(upload_path.len().saturating_sub(1))
            .enumerate()
        {
            path_components.push(name);
            let path = path_components.join("/");
            if levels.len() <= depth {
                levels.push(BTreeMap::new());
            }
            levels[depth]
                .entry(path.clone())
                .or_insert_with(|| PlannedFolder {
                    path: path.clone(),
                    parent_path: parent_path.clone(),
                    name: name.clone(),
                });
            parent_path = Some(path);
        }
    }

    levels
        .into_iter()
        .map(|level| level.into_values().collect())
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

#[cfg(test)]
mod tests {
    use actix_web::test::TestRequest;

    use super::{
        DOWNLOAD_FILE_QUERY, FOLDER_ARCHIVE_ACCESS_QUERY, FOLDER_ARCHIVE_ENTRIES_QUERY,
        MAX_FOLDER_ARCHIVE_BYTES, MAX_FOLDER_ARCHIVE_ENTRIES, OWNED_FOLDER_CONTEXT_QUERY,
        PlannedFolder, SHARED_FOLDER_CONTEXT_QUERY, UPLOAD_LENGTH_HEADER, UPLOAD_OFFSET_HEADER,
        local_upload_chunk, parse_download_version, plan_folder_manifest, sanitize_upload_path,
    };

    #[test]
    fn folder_archive_authorizes_the_selected_subtree_for_owner_or_active_share() {
        assert!(FOLDER_ARCHIVE_ACCESS_QUERY.contains("entry_type = 'folder'"));
        assert!(FOLDER_ARCHIVE_ACCESS_QUERY.contains("state = 'active'"));
        assert!(FOLDER_ARCHIVE_ACCESS_QUERY.contains("selected_folder.owner_id = $2"));
        assert!(FOLDER_ARCHIVE_ACCESS_QUERY.contains("file_shares AS shares"));
        assert!(FOLDER_ARCHIVE_ACCESS_QUERY.contains("vault_shares AS shares"));
        assert!(FOLDER_ARCHIVE_ACCESS_QUERY.contains("shares.status = 'active'"));
        assert!(FOLDER_ARCHIVE_ACCESS_QUERY.contains("vault_share_recipients AS recipients"));
        assert!(FOLDER_ARCHIVE_ACCESS_QUERY.contains("recipients.status = 'active'"));
        assert!(FOLDER_ARCHIVE_ACCESS_QUERY.contains("owners.status = 'active'"));
        assert!(FOLDER_ARCHIVE_ACCESS_QUERY.contains("visited_ids"));
        assert!(FOLDER_ARCHIVE_ACCESS_QUERY.contains("depth < 100"));
    }

    #[test]
    fn folder_archive_stays_bounded_and_uses_the_batched_tree_walker() {
        assert_eq!(MAX_FOLDER_ARCHIVE_ENTRIES, 50_000);
        assert_eq!(MAX_FOLDER_ARCHIVE_BYTES, 2 * 1024 * 1024 * 1024);
        let source = include_str!("files.rs");
        let handler = source
            .split_once("pub async fn folder_archive_manifest")
            .and_then(|(_, tail)| tail.split_once("pub async fn abort_upload"))
            .map(|(handler, _)| handler)
            .expect("folder archive handler source should remain inspectable");

        assert!(handler.contains("IsolationLevel::RepeatableRead"));
        assert!(handler.contains(".read_only(true)"));
        assert!(handler.contains("walk_subtree("));
        assert!(handler.contains("TREE_MUTATION_BATCH_SIZE"));
        assert!(handler.contains("MAX_FOLDER_ARCHIVE_ENTRIES.saturating_add(1)"));
        assert!(handler.contains("MAX_FOLDER_ARCHIVE_BYTES"));
        assert!(handler.contains("child_state: Some(\"active\")"));
        assert!(FOLDER_ARCHIVE_ENTRIES_QUERY.contains("current_generation_id"));
        assert!(FOLDER_ARCHIVE_ENTRIES_QUERY.contains("heads.record_hash"));
    }

    #[test]
    fn folder_manifest_bounds_upload_and_recursive_work_before_planning() {
        let source = include_str!("files.rs");
        let handler = source
            .split_once("pub async fn create_folder_manifest(")
            .and_then(|(_, tail)| tail.split_once("pub async fn init_upload("))
            .map(|(handler, _)| handler)
            .expect("folder manifest handler source should remain inspectable");

        assert!(handler.contains("upload_control_limiter"));
        assert!(handler.contains("acquire_recursive_operation"));
        let admission = handler
            .find("acquire_recursive_operation")
            .expect("recursive admission should be present");
        let planning = handler
            .find("plan_folder_manifest")
            .expect("folder planning should be present");
        assert!(admission < planning);
    }

    #[test]
    fn recursive_listing_download_and_editor_upload_paths_are_admitted_first() {
        let source = include_str!("files.rs");
        for (start, end, recursive_call) in [
            (
                "pub async fn list_files(",
                "pub async fn storage(",
                "resolve_owned_folder_context(",
            ),
            (
                "pub async fn init_upload(",
                "pub async fn upload_content(",
                "editor_parent(",
            ),
            (
                "pub async fn download(",
                "pub async fn share(",
                "get_download_file(",
            ),
        ] {
            let handler = source
                .split_once(start)
                .and_then(|(_, tail)| tail.split_once(end))
                .map(|(handler, _)| handler)
                .expect("recursive legacy handler source should remain inspectable");
            let admission = handler
                .find("acquire_recursive_operation")
                .unwrap_or_else(|| panic!("{start} admission should be present"));
            let recursive_query = handler
                .find(recursive_call)
                .unwrap_or_else(|| panic!("{start} should contain {recursive_call}"));
            assert!(
                admission < recursive_query,
                "{start} must acquire recursive capacity first"
            );
        }
    }

    #[test]
    fn file_lifecycle_mutations_return_json_for_client_side_batches() {
        let source = include_str!("files.rs");
        for (start, end, status) in [
            ("pub async fn trash(", "pub async fn restore(", "trashed"),
            (
                "pub async fn restore(",
                "pub async fn toggle_favorite(",
                "restored",
            ),
            (
                "pub async fn delete(",
                "async fn validate_folder(",
                "deleted",
            ),
        ] {
            let handler = source
                .split_once(start)
                .and_then(|(_, tail)| tail.split_once(end))
                .map(|(handler, _)| handler)
                .expect("file lifecycle handler should remain inspectable");
            assert!(handler.contains("request_wants_json(&request)"));
            assert!(handler.contains("FileMutationResponse"));
            assert!(handler.contains(&format!("status: \"{status}\"")));
        }
    }

    #[test]
    fn folder_archive_download_versions_are_exact_and_unambiguous() {
        let version = parse_download_version("2026-08-17T12:34:56.123456Z")
            .expect("manifest version should parse");
        assert_eq!(
            crate::timestamps::cursor(version),
            "2026-08-17T12:34:56.123456Z"
        );
        for invalid in [
            "2026-08-17T12:34:56Z",
            "2026-02-30T12:34:56.123456Z",
            "2026-08-17T25:34:56.123456Z",
            "2026-08-17T12:34:56.12345Z",
            "2026-08-17T12:34:56.123456+00:00",
        ] {
            assert!(parse_download_version(invalid).is_err(), "{invalid}");
        }
        assert!(DOWNLOAD_FILE_QUERY.contains("files.updated_at = $3"));
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn database_query_contracts_prepare() {
        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
        let (client, connection) = tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
            .await
            .expect("connect to PostgreSQL");
        actix_web::rt::spawn(async move {
            connection
                .await
                .expect("PostgreSQL connection stays healthy");
        });

        for query in [
            FOLDER_ARCHIVE_ACCESS_QUERY,
            FOLDER_ARCHIVE_ENTRIES_QUERY,
            DOWNLOAD_FILE_QUERY,
        ] {
            client
                .prepare(query)
                .await
                .expect("folder archive query prepares");
        }
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn database_optimized_queries_execute() {
        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
        let (mut client, connection) =
            tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
                .await
                .expect("connect to PostgreSQL");
        actix_web::rt::spawn(async move {
            connection
                .await
                .expect("PostgreSQL connection stays healthy");
        });
        let transaction = client
            .transaction()
            .await
            .expect("test transaction should start");
        transaction
            .batch_execute(
                "INSERT INTO users (id, username, password_hash, role, status)
                   VALUES
                     ('usr_archive_owner', 'archive_owner', 'not-a-login-hash', 'user', 'active'),
                     ('usr_archive_legacy', 'archive_legacy', 'not-a-login-hash', 'user', 'active'),
                     ('usr_archive_vault', 'archive_vault', 'not-a-login-hash', 'user', 'active'),
                     ('usr_archive_outside', 'archive_outside', 'not-a-login-hash', 'user', 'active');
                 INSERT INTO files (
                   id, owner_id, original_name, storage_name, size_bytes, state,
                   entry_type, parent_id, e2ee_state, updated_at
                 ) VALUES
                   ('fil_archive_root', 'usr_archive_owner', 'root', 'tests/archive-root', 0,
                    'active', 'folder', NULL, 'legacy', '2026-08-17 12:34:56.123456+00'),
                   ('fil_archive_child', 'usr_archive_owner', 'child', 'tests/archive-child', 0,
                    'active', 'folder', 'fil_archive_root', 'legacy', now()),
                   ('fil_archive_file', 'usr_archive_owner', 'file.txt', 'tests/archive-file', 4,
                    'active', 'file', 'fil_archive_child', 'legacy', '2026-08-17 12:34:56.123456+00'),
                   ('fil_archive_trashed', 'usr_archive_owner', 'trashed', 'tests/archive-trashed', 0,
                    'trashed', 'folder', 'fil_archive_root', 'legacy', now()),
                   ('fil_archive_outside', 'usr_archive_owner', 'outside', 'tests/archive-outside', 0,
                    'active', 'folder', NULL, 'legacy', now());
                 INSERT INTO vault_identity_keys (
                   user_id, key_version, x25519_public_key, ed25519_public_key,
                   fingerprint_sha256, status
                 ) VALUES (
                   'usr_archive_vault', 1, decode(repeat('71', 32), 'hex'),
                   decode(repeat('72', 32), 'hex'), decode(repeat('73', 32), 'hex'), 'active'
                 );",
            )
            .await
            .expect("folder archive fixtures should insert");

        let owner = transaction
            .query_opt(
                FOLDER_ARCHIVE_ACCESS_QUERY,
                &[&"fil_archive_child", &"usr_archive_owner"],
            )
            .await
            .expect("owner access query should execute");
        assert_eq!(
            owner.map(|row| row.get::<_, String>("owner_id")),
            Some("usr_archive_owner".into())
        );
        assert!(
            transaction
                .query_opt(
                    FOLDER_ARCHIVE_ACCESS_QUERY,
                    &[&"fil_archive_child", &"usr_archive_outside"],
                )
                .await
                .expect("unshared access query should execute")
                .is_none()
        );
        assert!(
            transaction
                .query_opt(
                    FOLDER_ARCHIVE_ACCESS_QUERY,
                    &[&"fil_archive_trashed", &"usr_archive_owner"],
                )
                .await
                .expect("trashed access query should execute")
                .is_none()
        );

        transaction
            .execute(
                "INSERT INTO file_shares (id, file_id, owner_id, recipient_id)
                 VALUES ('fsh_archive', 'fil_archive_root', 'usr_archive_owner', 'usr_archive_legacy')",
                &[],
            )
            .await
            .expect("legacy share should insert");
        assert!(
            transaction
                .query_opt(
                    FOLDER_ARCHIVE_ACCESS_QUERY,
                    &[&"fil_archive_child", &"usr_archive_legacy"],
                )
                .await
                .expect("ancestor legacy share should execute")
                .is_some()
        );
        transaction
            .execute("DELETE FROM file_shares WHERE id = 'fsh_archive'", &[])
            .await
            .expect("legacy share should delete");
        assert!(
            transaction
                .query_opt(
                    FOLDER_ARCHIVE_ACCESS_QUERY,
                    &[&"fil_archive_child", &"usr_archive_legacy"],
                )
                .await
                .expect("revoked legacy share should execute")
                .is_none()
        );

        transaction
            .batch_execute(
                "INSERT INTO vault_shares (id, owner_id, root_node_id, status)
                   VALUES ('shr_archive', 'usr_archive_owner', 'fil_archive_root', 'active');
                 INSERT INTO vault_share_recipients (
                   share_id, recipient_id, recipient_key_version, status
                 ) VALUES ('shr_archive', 'usr_archive_vault', 1, 'active');",
            )
            .await
            .expect("vault share should insert");
        assert!(
            transaction
                .query_opt(
                    FOLDER_ARCHIVE_ACCESS_QUERY,
                    &[&"fil_archive_child", &"usr_archive_vault"],
                )
                .await
                .expect("active vault share should execute")
                .is_some()
        );
        transaction
            .execute(
                "UPDATE vault_share_recipients SET status = 'revoked'
                 WHERE share_id = 'shr_archive' AND recipient_id = 'usr_archive_vault'",
                &[],
            )
            .await
            .expect("recipient should revoke");
        assert!(
            transaction
                .query_opt(
                    FOLDER_ARCHIVE_ACCESS_QUERY,
                    &[&"fil_archive_child", &"usr_archive_vault"],
                )
                .await
                .expect("revoked recipient query should execute")
                .is_none()
        );
        transaction
            .batch_execute(
                "UPDATE vault_share_recipients SET status = 'active', revoked_at = NULL
                   WHERE share_id = 'shr_archive' AND recipient_id = 'usr_archive_vault';
                 UPDATE vault_shares SET status = 'revoked', revoked_at = now()
                   WHERE id = 'shr_archive';",
            )
            .await
            .expect("share should revoke");
        assert!(
            transaction
                .query_opt(
                    FOLDER_ARCHIVE_ACCESS_QUERY,
                    &[&"fil_archive_child", &"usr_archive_vault"],
                )
                .await
                .expect("revoked share query should execute")
                .is_none()
        );

        let matching_version = parse_download_version("2026-08-17T12:34:56.123456Z")
            .expect("matching version should parse");
        assert!(
            transaction
                .query_opt(
                    DOWNLOAD_FILE_QUERY,
                    &[
                        &"fil_archive_file",
                        &"usr_archive_owner",
                        &Some(matching_version),
                    ],
                )
                .await
                .expect("versioned download query should execute")
                .is_some()
        );
        let stale_version = parse_download_version("2026-08-17T12:34:56.123455Z")
            .expect("stale version should parse");
        assert!(
            transaction
                .query_opt(
                    DOWNLOAD_FILE_QUERY,
                    &[
                        &"fil_archive_file",
                        &"usr_archive_owner",
                        &Some(stale_version),
                    ],
                )
                .await
                .expect("stale download query should execute")
                .is_none()
        );
        transaction
            .rollback()
            .await
            .expect("fixtures should roll back");
    }

    #[test]
    fn listing_resolves_folder_access_and_breadcrumbs_in_one_query() {
        assert!(OWNED_FOLDER_CONTEXT_QUERY.contains("entry_type = 'folder'"));
        assert!(OWNED_FOLDER_CONTEXT_QUERY.contains("state = 'active'"));
        assert!(OWNED_FOLDER_CONTEXT_QUERY.contains("ORDER BY depth DESC"));
        assert!(OWNED_FOLDER_CONTEXT_QUERY.contains("heads.record_version"));
        assert!(OWNED_FOLDER_CONTEXT_QUERY.contains("heads.record_hash"));

        assert!(SHARED_FOLDER_CONTEXT_QUERY.contains("entry_type = 'folder'"));
        assert!(SHARED_FOLDER_CONTEXT_QUERY.contains("legacy_access AS"));
        assert!(SHARED_FOLDER_CONTEXT_QUERY.contains("vault_access AS"));
        assert!(SHARED_FOLDER_CONTEXT_QUERY.contains("ORDER BY ancestors.depth DESC"));
        assert!(SHARED_FOLDER_CONTEXT_QUERY.contains("heads.record_version"));
        assert!(SHARED_FOLDER_CONTEXT_QUERY.contains("heads.record_hash"));
    }

    #[test]
    fn file_listing_exposes_cryptographic_revision_validators() {
        let source = include_str!("files.rs");
        let listing = source
            .split_once("async fn list_entries(")
            .and_then(|(_, tail)| tail.split_once("fn listed_file_from_row"))
            .map(|(listing, _)| listing)
            .expect("file listing source should remain inspectable");

        assert!(listing.contains("vault_generation_id"));
        assert!(listing.contains("vault_record_version"));
        assert!(listing.contains("vault_record_hash"));
        assert!(listing.contains("LEFT JOIN vault_node_heads"));
    }

    #[test]
    fn listing_pipelines_entries_and_summary_after_folder_resolution() {
        let source = include_str!("files.rs");
        let listing = source
            .split_once("pub async fn list_files")
            .and_then(|(_, tail)| tail.split_once("pub async fn storage"))
            .map(|(listing, _)| listing)
            .expect("list_files source should remain inspectable");

        assert!(listing.contains("futures_util::try_join!("));
        assert!(listing.contains("list_entries("));
        assert!(listing.contains("get_summary(&state, &user)"));
        assert!(!listing.contains("validate_shared_folder("));
        assert!(!listing.contains("get_shared_breadcrumbs("));
    }

    #[test]
    fn owned_listing_reads_transactionally_maintained_share_state() {
        let source = include_str!("files.rs");
        let owned_listing = source
            .split_once("async fn list_entries(")
            .and_then(|(_, tail)| tail.split_once("async fn list_shared_entries("))
            .map(|(listing, _)| listing)
            .expect("owned listing source should remain inspectable");

        assert!(owned_listing.contains("files.legacy_share_count > 0"));
        assert!(owned_listing.contains("files.vault_share_count > 0"));
        assert!(owned_listing.contains("files.permanent_share_link_count > 0"));
        assert!(owned_listing.contains("COALESCE(files.latest_share_link_expiry > now(), FALSE)"));
        assert!(!owned_listing.contains("SELECT 1 FROM file_shares"));
        assert!(!owned_listing.contains("SELECT 1 FROM vault_shares"));
        assert!(!owned_listing.contains("SELECT 1 FROM share_links"));
    }

    #[test]
    fn parses_matching_local_upload_chunk_headers() {
        let request = TestRequest::default()
            .insert_header((UPLOAD_OFFSET_HEADER, "8"))
            .insert_header((UPLOAD_LENGTH_HEADER, "4"))
            .insert_header(("content-length", "4"))
            .to_http_request();

        assert_eq!(local_upload_chunk(&request, 12).unwrap(), Some((8, 4)));
    }

    #[test]
    fn preserves_legacy_local_uploads_without_chunk_headers() {
        let request = TestRequest::default().to_http_request();

        assert_eq!(local_upload_chunk(&request, 12).unwrap(), None);
    }

    #[test]
    fn rejects_incomplete_or_out_of_bounds_chunk_headers() {
        let incomplete = TestRequest::default()
            .insert_header((UPLOAD_OFFSET_HEADER, "0"))
            .to_http_request();
        let out_of_bounds = TestRequest::default()
            .insert_header((UPLOAD_OFFSET_HEADER, "8"))
            .insert_header((UPLOAD_LENGTH_HEADER, "5"))
            .to_http_request();
        let mismatched_length = TestRequest::default()
            .insert_header((UPLOAD_OFFSET_HEADER, "0"))
            .insert_header((UPLOAD_LENGTH_HEADER, "4"))
            .insert_header(("content-length", "3"))
            .to_http_request();

        assert!(local_upload_chunk(&incomplete, 12).is_err());
        assert!(local_upload_chunk(&out_of_bounds, 12).is_err());
        assert!(local_upload_chunk(&mismatched_length, 12).is_err());
    }

    #[test]
    fn folder_manifest_deduplicates_shared_prefixes_by_depth() {
        let paths = (0..1_000)
            .map(|index| sanitize_upload_path(&format!("project/src/lib/file-{index}.ts")))
            .collect::<Vec<_>>();

        assert_eq!(
            plan_folder_manifest(&paths),
            vec![
                vec![PlannedFolder {
                    path: "project".to_owned(),
                    parent_path: None,
                    name: "project".to_owned(),
                }],
                vec![PlannedFolder {
                    path: "project/src".to_owned(),
                    parent_path: Some("project".to_owned()),
                    name: "src".to_owned(),
                }],
                vec![PlannedFolder {
                    path: "project/src/lib".to_owned(),
                    parent_path: Some("project/src".to_owned()),
                    name: "lib".to_owned(),
                }],
            ]
        );
    }
}
