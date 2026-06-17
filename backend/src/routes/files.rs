use std::ffi::CString;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use actix_multipart::Multipart;
use actix_web::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE, LOCATION};
use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use tokio::fs::File as AsyncFile;
use tokio::io::AsyncReadExt;

use crate::auth::{AuthUser, CSRF_FIELD, require_csrf, require_user};
use crate::state::AppState;

const MAX_UPLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Deserialize)]
pub(crate) struct FilesQuery {
    view: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct UploadQuery {
    csrf_token: Option<String>,
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
pub struct FilesResponse {
    view: String,
    entries: Vec<FileEntry>,
    summary: FilesSummary,
    storage: StorageStats,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesSummary {
    total_files: usize,
    active_files: i64,
    trashed_files: i64,
    favorite_files: i64,
    used_bytes: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    id: String,
    name: String,
    kind: String,
    size_bytes: i64,
    state: String,
    favorite: bool,
    owner_username: Option<String>,
    shared: bool,
    shared_at: Option<String>,
    created_at: String,
    updated_at: String,
    trashed_at: Option<String>,
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

pub async fn list_files(
    state: web::Data<AppState>,
    request: HttpRequest,
    query: web::Query<FilesQuery>,
) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
    ensure_storage_dir(&state)?;

    let view = normalize_view(query.view.as_deref());
    let entries = list_entries(&state, &user, view).await?;
    let summary = get_summary(&state, &user).await?;
    let storage = storage_stats(&state)?;

    Ok(HttpResponse::Ok().json(FilesResponse {
        view: view.to_owned(),
        entries,
        summary,
        storage,
    }))
}

pub async fn storage(state: web::Data<AppState>, request: HttpRequest) -> Result<HttpResponse> {
    require_user(&state, &request).await?;
    ensure_storage_dir(&state)?;

    Ok(HttpResponse::Ok().json(storage_stats(&state)?))
}

pub async fn upload(
    state: web::Data<AppState>,
    request: HttpRequest,
    query: web::Query<UploadQuery>,
    mut payload: Multipart,
) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
    let user_dir = user_storage_dir(&state, &user);
    let mut uploaded_any = false;
    let mut csrf_verified = false;

    let header_csrf_token = request
        .headers()
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok());
    let csrf_token = query.csrf_token.as_deref().or(header_csrf_token);

    if let Some(csrf_token) = csrf_token {
        require_csrf(&state, &request, csrf_token).await?;
        csrf_verified = true;
    }

    while let Some(field_result) = payload.next().await {
        let mut field = field_result.map_err(error::ErrorBadRequest)?;
        let Some(content_disposition) = field.content_disposition() else {
            drain_field(&mut field).await?;
            continue;
        };
        let field_name = content_disposition.get_name().map(str::to_owned);
        let filename = content_disposition.get_filename().map(str::to_owned);

        if field_name.as_deref() == Some(CSRF_FIELD) {
            let csrf_token = read_limited_text_field(&mut field, 512).await?;
            require_csrf(&state, &request, &csrf_token).await?;
            csrf_verified = true;
            continue;
        }

        if !csrf_verified {
            drain_field(&mut field).await?;
            return Err(error::ErrorForbidden("csrf token required"));
        }

        let Some(filename) = filename else {
            drain_field(&mut field).await?;
            continue;
        };
        let display_name = sanitize_display_name(&filename);

        if display_name.is_empty() {
            drain_field(&mut field).await?;
            continue;
        }

        fs::create_dir_all(&user_dir).map_err(error::ErrorInternalServerError)?;
        let storage_name = create_storage_name()?;
        let storage_path = user_dir.join(&storage_name);
        let mut file = File::create(&storage_path).map_err(error::ErrorInternalServerError)?;
        let mut size_bytes: u64 = 0;

        while let Some(chunk_result) = field.next().await {
            let chunk = chunk_result.map_err(error::ErrorBadRequest)?;
            size_bytes = size_bytes
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| error::ErrorBadRequest("upload is too large"))?;

            if size_bytes > MAX_UPLOAD_BYTES {
                let _ = fs::remove_file(&storage_path);
                return Ok(redirect("/files?file=too-large"));
            }

            file.write_all(&chunk)
                .map_err(error::ErrorInternalServerError)?;
        }

        let mime_type = field.content_type().map(|mime| mime.to_string());
        let size_bytes_i64 =
            i64::try_from(size_bytes).map_err(|_| error::ErrorBadRequest("upload is too large"))?;

        let insert_result = state
            .db
            .execute(
                "
                    INSERT INTO files (
                      id,
                      owner_id,
                      original_name,
                      storage_name,
                      mime_type,
                      size_bytes
                    )
                    VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5)
                ",
                &[
                    &user.id,
                    &display_name,
                    &storage_name,
                    &mime_type,
                    &size_bytes_i64,
                ],
            )
            .await;

        if let Err(error) = insert_result {
            let _ = fs::remove_file(&storage_path);
            return Err(error::ErrorInternalServerError(error));
        }

        uploaded_any = true;
    }

    if !csrf_verified {
        return Err(error::ErrorForbidden("csrf token required"));
    }

    if uploaded_any {
        Ok(redirect("/files?file=uploaded"))
    } else {
        Ok(redirect("/files?file=missing"))
    }
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

    let file_path = owner_storage_dir(&state, &file.owner_id).join(&file.storage_name);
    let stored_file = AsyncFile::open(file_path)
        .await
        .map_err(error::ErrorNotFound)?;
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
    let file_id = path.into_inner();
    let username = normalize_username(&form.username);

    if !is_valid_username(&username) {
        return Ok(redirect("/files?file=share-invalid"));
    }

    let Some(recipient_row) = state
        .db
        .query_opt(
            "
                SELECT id
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
        return Ok(redirect("/files?file=share-user-missing"));
    };

    let recipient_id: String = recipient_row.get("id");

    if recipient_id == user.id {
        return Ok(redirect("/files?file=share-self"));
    }

    let owned_file = state
        .db
        .query_opt(
            "
                SELECT id
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

    if owned_file.is_none() {
        return Ok(redirect("/files?file=missing"));
    }

    state
        .db
        .execute(
            "
                INSERT INTO file_shares (id, file_id, owner_id, recipient_id)
                VALUES (gen_random_uuid()::text, $1, $2, $3)
                ON CONFLICT (file_id, recipient_id) DO NOTHING
            ",
            &[&file_id, &user.id, &recipient_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

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

    state
        .db
        .execute(
            "
                UPDATE files
                SET state = 'trashed',
                    trashed_at = now(),
                    updated_at = now()
                WHERE id = $1
                  AND owner_id = $2
                  AND state = 'active'
            ",
            &[&path.into_inner(), &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

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
                UPDATE files
                SET state = 'active',
                    trashed_at = NULL,
                    updated_at = now()
                WHERE id = $1
                  AND owner_id = $2
                  AND state = 'trashed'
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

    state
        .db
        .execute(
            "
                UPDATE files
                SET favorite = NOT favorite,
                    updated_at = now()
                WHERE id = $1
                  AND owner_id = $2
                  AND state = 'active'
            ",
            &[&path.into_inner(), &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

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

    state
        .db
        .execute(
            "DELETE FROM files WHERE id = $1 AND owner_id = $2 AND state = 'trashed'",
            &[&file.id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    let file_path = user_storage_dir(&state, &user).join(file.storage_name);
    let _ = fs::remove_file(file_path);

    Ok(redirect("/trash?file=deleted"))
}

async fn list_entries(state: &AppState, user: &AuthUser, view: &str) -> Result<Vec<FileEntry>> {
    if view == "shared" {
        return list_shared_entries(state, user).await;
    }

    let (predicate, order) = match view {
        "trash" => ("state = 'trashed'", "trashed_at DESC NULLS LAST"),
        "favorites" => ("state = 'active' AND favorite = true", "updated_at DESC"),
        "recent" => ("state = 'active'", "updated_at DESC"),
        _ => ("state = 'active'", "original_name ASC"),
    };
    let limit = if view == "recent" { " LIMIT 50" } else { "" };
    let sql = format!(
        "
            SELECT
              id,
              original_name,
              mime_type,
                size_bytes,
                state,
                favorite,
                NULL::text AS owner_username,
                false AS shared,
                NULL::text AS shared_at,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at,
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS updated_at,
                to_char(trashed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS trashed_at
            FROM files
            WHERE owner_id = $1
              AND {predicate}
            ORDER BY {order}
            {limit}
        "
    );

    let rows = state
        .db
        .query(&sql, &[&user.id])
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let mime_type: Option<String> = row.get("mime_type");
            let name: String = row.get("original_name");

            FileEntry {
                id: row.get("id"),
                kind: file_kind(&name, mime_type.as_deref()),
                name,
                size_bytes: row.get("size_bytes"),
                state: row.get("state"),
                favorite: row.get("favorite"),
                owner_username: row.get("owner_username"),
                shared: row.get("shared"),
                shared_at: row.get("shared_at"),
                created_at: row.get("created_at"),
                updated_at: row.get("updated_at"),
                trashed_at: row.get("trashed_at"),
            }
        })
        .collect())
}

async fn list_shared_entries(state: &AppState, user: &AuthUser) -> Result<Vec<FileEntry>> {
    let rows = state
        .db
        .query(
            "
                SELECT
                  files.id,
                  files.original_name,
                  files.mime_type,
                  files.size_bytes,
                  files.state,
                  false AS favorite,
                  owners.username AS owner_username,
                  true AS shared,
                  to_char(file_shares.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS shared_at,
                  to_char(files.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at,
                  to_char(files.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS updated_at,
                  to_char(files.trashed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS trashed_at
                FROM file_shares
                INNER JOIN files ON files.id = file_shares.file_id
                INNER JOIN users AS owners ON owners.id = files.owner_id
                WHERE file_shares.recipient_id = $1
                  AND files.state = 'active'
                  AND owners.status = 'active'
                ORDER BY file_shares.created_at DESC
            ",
            &[&user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let mime_type: Option<String> = row.get("mime_type");
            let name: String = row.get("original_name");

            FileEntry {
                id: row.get("id"),
                kind: file_kind(&name, mime_type.as_deref()),
                name,
                size_bytes: row.get("size_bytes"),
                state: row.get("state"),
                favorite: row.get("favorite"),
                owner_username: row.get("owner_username"),
                shared: row.get("shared"),
                shared_at: row.get("shared_at"),
                created_at: row.get("created_at"),
                updated_at: row.get("updated_at"),
                trashed_at: row.get("trashed_at"),
            }
        })
        .collect())
}

async fn get_summary(state: &AppState, user: &AuthUser) -> Result<FilesSummary> {
    let row = state
        .db
        .query_one(
            "
                SELECT
                  count(*) FILTER (WHERE state = 'active') AS active_files,
                  count(*) FILTER (WHERE state = 'trashed') AS trashed_files,
                  count(*) FILTER (WHERE state = 'active' AND favorite = true) AS favorite_files,
                  COALESCE(sum(size_bytes), 0)::bigint AS used_bytes
                FROM files
                WHERE owner_id = $1
            ",
            &[&user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    let active_files: i64 = row.get("active_files");
    let trashed_files: i64 = row.get("trashed_files");

    Ok(FilesSummary {
        total_files: usize::try_from(active_files + trashed_files).unwrap_or(0),
        active_files,
        trashed_files,
        favorite_files: row.get("favorite_files"),
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
                  AND (
                    files.owner_id = $2
                    OR (
                      owners.status = 'active'
                      AND EXISTS (
                        SELECT 1
                        FROM file_shares
                        WHERE file_shares.file_id = files.id
                          AND file_shares.recipient_id = $2
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

async fn drain_field(field: &mut actix_multipart::Field) -> Result<()> {
    while let Some(chunk) = field.next().await {
        chunk.map_err(error::ErrorBadRequest)?;
    }

    Ok(())
}

async fn read_limited_text_field(
    field: &mut actix_multipart::Field,
    max_bytes: usize,
) -> Result<String> {
    let mut bytes = Vec::new();

    while let Some(chunk) = field.next().await {
        let chunk = chunk.map_err(error::ErrorBadRequest)?;

        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(error::ErrorBadRequest("form field is too large"));
        }

        bytes.extend_from_slice(&chunk);
    }

    String::from_utf8(bytes).map_err(error::ErrorBadRequest)
}

fn ensure_storage_dir(state: &AppState) -> Result<()> {
    fs::create_dir_all(&state.config.storage_path).map_err(error::ErrorInternalServerError)
}

fn user_storage_dir(state: &AppState, user: &AuthUser) -> PathBuf {
    owner_storage_dir(state, &user.id)
}

fn owner_storage_dir(state: &AppState, owner_id: &str) -> PathBuf {
    Path::new(&state.config.storage_path).join(owner_id)
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
    if let Some(mime_type) = mime_type {
        if let Some(kind) = mime_type.split('/').next() {
            if !kind.is_empty() && kind != "application" {
                return kind.to_owned();
            }
        }
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

fn storage_stats(state: &AppState) -> Result<StorageStats> {
    let storage_path = Path::new(&state.config.storage_path);
    let stats = statvfs(storage_path)?;
    let total_bytes = stats.total_bytes;
    let available_bytes = stats.available_bytes;
    let system_used_bytes = total_bytes.saturating_sub(available_bytes);
    let aeralyth_used_bytes = directory_size(storage_path).unwrap_or(0);

    Ok(StorageStats {
        storage_path: state.config.storage_path.clone(),
        total_bytes,
        available_bytes,
        system_used_bytes,
        aeralyth_used_bytes,
    })
}

fn statvfs(path: &Path) -> Result<StorageStatsRaw> {
    let path_string = path.to_string_lossy();
    let path_cstring =
        CString::new(path_string.as_bytes()).map_err(error::ErrorInternalServerError)?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();

    let result = unsafe { libc::statvfs(path_cstring.as_ptr(), stats.as_mut_ptr()) };

    if result != 0 {
        return Err(error::ErrorInternalServerError(
            "failed to read storage stats",
        ));
    }

    let stats = unsafe { stats.assume_init() };
    let fragment_size = stats.f_frsize;

    Ok(StorageStatsRaw {
        total_bytes: stats.f_blocks.saturating_mul(fragment_size),
        available_bytes: stats.f_bavail.saturating_mul(fragment_size),
    })
}

fn directory_size(path: &Path) -> std::io::Result<u64> {
    let mut total = 0_u64;

    if !path.exists() {
        return Ok(total);
    }

    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;

        if metadata.is_dir() {
            total = total.saturating_add(directory_size(&entry.path())?);
        } else {
            total = total.saturating_add(metadata.len());
        }
    }

    Ok(total)
}

struct StorageStatsRaw {
    total_bytes: u64,
    available_bytes: u64,
}

fn redirect(location: &'static str) -> HttpResponse {
    HttpResponse::SeeOther()
        .insert_header((LOCATION, location))
        .finish()
}
