use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use serde::{Deserialize, Serialize};
use tokio_postgres::Row;

use crate::auth::{AuthUser, require_csrf, require_user};
use crate::state::AppState;

const MAX_REPOSITORY_ENTRIES: i64 = 500;
const MAX_REPOSITORY_ARCHIVE_ENTRIES: i64 = 50_000;
const MAX_REPOSITORY_ARCHIVE_BYTES: i64 = 2 * 1024 * 1024 * 1024;
const MAX_REPOSITORY_DESCRIPTION_CHARS: usize = 350;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateRepositoryRequest {
    root_folder_id: String,
}

#[derive(Deserialize)]
pub(crate) struct UpdateRepositoryRequest {
    description: String,
}

#[derive(Deserialize)]
pub(crate) struct RepositoryQuery {
    folder: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoriesResponse {
    repositories: Vec<RepositorySummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryDetailResponse {
    repository: RepositorySummary,
    current_folder_id: String,
    breadcrumbs: Vec<RepositoryBreadcrumb>,
    entries: Vec<RepositoryEntry>,
    summary: RepositoryTreeSummary,
    entries_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryArchiveManifestResponse {
    repository: RepositorySummary,
    entries: Vec<RepositoryEntry>,
    total_bytes: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositorySummary {
    id: String,
    owner_username: String,
    default_branch: &'static str,
    description: Option<String>,
    root: RepositoryRoot,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryRoot {
    id: String,
    name: String,
    e2ee_state: String,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryBreadcrumb {
    id: String,
    name: String,
    e2ee_state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryEntry {
    id: String,
    name: String,
    mime_type: Option<String>,
    entry_type: String,
    parent_id: Option<String>,
    size_bytes: i64,
    e2ee_state: String,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryTreeSummary {
    total_files: i64,
    total_folders: i64,
}

pub async fn list(state: web::Data<AppState>, request: HttpRequest) -> Result<HttpResponse> {
    let owner = require_user(&state, &request).await?;
    let rows = state
        .db
        .query(
            "
                SELECT
                  repositories.id,
                  repositories.description,
                  owners.username AS owner_username,
                  roots.id AS root_id,
                  roots.original_name AS root_name,
                  roots.e2ee_state AS root_e2ee_state,
                  to_char(roots.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS root_updated_at,
                  to_char(repositories.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at,
                  to_char(repositories.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS updated_at
                FROM repositories
                INNER JOIN users AS owners ON owners.id = repositories.owner_id
                INNER JOIN files AS roots ON roots.id = repositories.root_file_id
                WHERE repositories.owner_id = $1
                  AND roots.owner_id = repositories.owner_id
                  AND roots.entry_type = 'folder'
                  AND roots.state = 'active'
                ORDER BY repositories.updated_at DESC, lower(roots.original_name), repositories.id
            ",
            &[&owner.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::Ok().json(RepositoriesResponse {
        repositories: rows.into_iter().map(repository_summary_from_row).collect(),
    }))
}

pub async fn create(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Json<CreateRepositoryRequest>,
) -> Result<HttpResponse> {
    let owner = require_user(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let root_folder_id = body.root_folder_id.trim();
    if root_folder_id.is_empty() {
        return Err(error::ErrorBadRequest("root folder is required"));
    }

    let root = state
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
            &[&root_folder_id, &owner.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if root.is_none() {
        return Ok(HttpResponse::NotFound().body("repository folder not found"));
    }

    let row = state
        .db
        .query_one(
            "
                INSERT INTO repositories (id, owner_id, root_file_id)
                VALUES ('repo_' || replace(gen_random_uuid()::text, '-', ''), $1, $2)
                ON CONFLICT (owner_id, root_file_id)
                DO UPDATE SET root_file_id = EXCLUDED.root_file_id
                RETURNING id
            ",
            &[&owner.id, &root_folder_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let repository_id: String = row.get("id");
    let repository = get_repository_summary(&state, &owner, &repository_id)
        .await?
        .ok_or_else(|| error::ErrorInternalServerError("repository could not be loaded"))?;

    Ok(HttpResponse::Created().json(repository))
}

pub async fn update(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    body: web::Json<UpdateRepositoryRequest>,
) -> Result<HttpResponse> {
    let owner = require_user(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let repository_id = path.into_inner();
    let description = body.description.trim();
    if description.chars().count() > MAX_REPOSITORY_DESCRIPTION_CHARS {
        return Err(error::ErrorBadRequest(
            "repository description must be 350 characters or fewer",
        ));
    }
    let description = (!description.is_empty()).then(|| description.to_owned());
    let updated = state
        .db
        .query_opt(
            "
                UPDATE repositories
                SET description = $1,
                    updated_at = now()
                WHERE id = $2 AND owner_id = $3
                RETURNING id
            ",
            &[&description, &repository_id, &owner.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if updated.is_none() {
        return Ok(HttpResponse::NotFound().finish());
    }
    let repository = get_repository_summary(&state, &owner, &repository_id)
        .await?
        .ok_or_else(|| error::ErrorInternalServerError("repository could not be loaded"))?;
    Ok(HttpResponse::Ok().json(repository))
}

pub async fn detail(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    query: web::Query<RepositoryQuery>,
) -> Result<HttpResponse> {
    let owner = require_user(&state, &request).await?;
    let repository_id = path.into_inner();
    let Some(repository) = get_repository_summary(&state, &owner, &repository_id).await? else {
        return Ok(HttpResponse::NotFound().finish());
    };
    let root_folder_id = repository.root.id.clone();
    let requested_folder_id = query
        .folder
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&root_folder_id)
        .to_owned();

    if !folder_is_in_repository(&state, &owner.id, &root_folder_id, &requested_folder_id).await? {
        return Ok(HttpResponse::NotFound().body("repository folder not found"));
    }

    let breadcrumb_rows = state
        .db
        .query(
            "
                WITH RECURSIVE ancestors AS (
                  SELECT id, original_name, parent_id, e2ee_state, 0::integer AS depth
                  FROM files
                  WHERE id = $1 AND owner_id = $2 AND state = 'active'
                  UNION ALL
                  SELECT parent.id, parent.original_name, parent.parent_id, parent.e2ee_state, ancestors.depth + 1
                  FROM files AS parent
                  INNER JOIN ancestors ON ancestors.parent_id = parent.id
                  WHERE parent.owner_id = $2
                    AND parent.state = 'active'
                    AND ancestors.id <> $3
                    AND ancestors.depth < 100
                )
                SELECT id, original_name, e2ee_state
                FROM ancestors
                WHERE id <> $3
                ORDER BY depth DESC
            ",
            &[&requested_folder_id, &owner.id, &root_folder_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    let mut entry_rows = state
        .db
        .query(
            "
                SELECT
                  id,
                  original_name,
                  mime_type,
                  entry_type,
                  parent_id,
                  size_bytes,
                  e2ee_state,
                  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS updated_at
                FROM files
                WHERE owner_id = $1
                  AND parent_id = $2
                  AND state = 'active'
                ORDER BY CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END,
                         lower(original_name),
                         id
                LIMIT $3
            ",
            &[
                &owner.id,
                &requested_folder_id,
                &(MAX_REPOSITORY_ENTRIES + 1),
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let entries_truncated = entry_rows.len() > MAX_REPOSITORY_ENTRIES as usize;
    entry_rows.truncate(MAX_REPOSITORY_ENTRIES as usize);

    let summary_row = state
        .db
        .query_one(
            "
                WITH RECURSIVE tree AS (
                  SELECT id, entry_type
                  FROM files
                  WHERE id = $1 AND owner_id = $2 AND state = 'active'
                  UNION
                  SELECT child.id, child.entry_type
                  FROM files AS child
                  INNER JOIN tree ON child.parent_id = tree.id
                  WHERE child.owner_id = $2 AND child.state = 'active'
                )
                SELECT
                  count(*) FILTER (WHERE entry_type = 'file')::bigint AS total_files,
                  GREATEST(count(*) FILTER (WHERE entry_type = 'folder') - 1, 0)::bigint AS total_folders
                FROM tree
            ",
            &[&root_folder_id, &owner.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::Ok().json(RepositoryDetailResponse {
        repository,
        current_folder_id: requested_folder_id,
        breadcrumbs: breadcrumb_rows
            .into_iter()
            .map(|row| RepositoryBreadcrumb {
                id: row.get("id"),
                name: row.get("original_name"),
                e2ee_state: row.get("e2ee_state"),
            })
            .collect(),
        entries: entry_rows
            .into_iter()
            .map(repository_entry_from_row)
            .collect(),
        summary: RepositoryTreeSummary {
            total_files: summary_row.get("total_files"),
            total_folders: summary_row.get("total_folders"),
        },
        entries_truncated,
    }))
}

pub async fn archive_manifest(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    let owner = require_user(&state, &request).await?;
    let repository_id = path.into_inner();
    let Some(repository) = get_repository_summary(&state, &owner, &repository_id).await? else {
        return Ok(HttpResponse::NotFound().finish());
    };
    let root_folder_id = repository.root.id.clone();
    let rows = state
        .db
        .query(
            "
                WITH RECURSIVE tree AS (
                  SELECT
                    id,
                    original_name,
                    mime_type,
                    entry_type,
                    parent_id,
                    size_bytes,
                    e2ee_state,
                    updated_at,
                    0::integer AS depth
                  FROM files
                  WHERE id = $1
                    AND owner_id = $2
                    AND entry_type = 'folder'
                    AND state = 'active'

                  UNION ALL

                  SELECT
                    child.id,
                    child.original_name,
                    child.mime_type,
                    child.entry_type,
                    child.parent_id,
                    child.size_bytes,
                    child.e2ee_state,
                    child.updated_at,
                    tree.depth + 1
                  FROM files AS child
                  INNER JOIN tree ON child.parent_id = tree.id
                  WHERE child.owner_id = $2
                    AND child.state = 'active'
                    AND tree.depth < 100
                )
                SELECT
                  id,
                  original_name,
                  mime_type,
                  entry_type,
                  parent_id,
                  size_bytes,
                  e2ee_state,
                  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS updated_at
                FROM tree
                WHERE id <> $1
                ORDER BY depth,
                         CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END,
                         lower(original_name),
                         id
                LIMIT $3
            ",
            &[
                &root_folder_id,
                &owner.id,
                &(MAX_REPOSITORY_ARCHIVE_ENTRIES + 1),
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    if rows.len() > MAX_REPOSITORY_ARCHIVE_ENTRIES as usize {
        return Ok(HttpResponse::PayloadTooLarge()
            .body("This repository has too many entries to download as one ZIP archive."));
    }

    let total_bytes = rows
        .iter()
        .filter(|row| row.get::<_, String>("entry_type") == "file")
        .map(|row| row.get::<_, i64>("size_bytes").max(0))
        .fold(0_i64, i64::saturating_add);
    if total_bytes > MAX_REPOSITORY_ARCHIVE_BYTES {
        return Ok(HttpResponse::PayloadTooLarge()
            .body("This repository is larger than the 2 GB ZIP download limit."));
    }

    Ok(HttpResponse::Ok().json(RepositoryArchiveManifestResponse {
        repository,
        entries: rows.into_iter().map(repository_entry_from_row).collect(),
        total_bytes,
    }))
}

async fn get_repository_summary(
    state: &AppState,
    owner: &AuthUser,
    repository_id: &str,
) -> Result<Option<RepositorySummary>> {
    let row = state
        .db
        .query_opt(
            "
                SELECT
                  repositories.id,
                  repositories.description,
                  owners.username AS owner_username,
                  roots.id AS root_id,
                  roots.original_name AS root_name,
                  roots.e2ee_state AS root_e2ee_state,
                  to_char(roots.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS root_updated_at,
                  to_char(repositories.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at,
                  to_char(repositories.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS updated_at
                FROM repositories
                INNER JOIN users AS owners ON owners.id = repositories.owner_id
                INNER JOIN files AS roots ON roots.id = repositories.root_file_id
                WHERE repositories.id = $1
                  AND repositories.owner_id = $2
                  AND roots.owner_id = repositories.owner_id
                  AND roots.entry_type = 'folder'
                  AND roots.state = 'active'
                LIMIT 1
            ",
            &[&repository_id, &owner.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(row.map(repository_summary_from_row))
}

async fn folder_is_in_repository(
    state: &AppState,
    owner_id: &str,
    root_folder_id: &str,
    folder_id: &str,
) -> Result<bool> {
    let row = state
        .db
        .query_opt(
            "
                WITH RECURSIVE tree AS (
                  SELECT id
                  FROM files
                  WHERE id = $1
                    AND owner_id = $2
                    AND entry_type = 'folder'
                    AND state = 'active'
                  UNION
                  SELECT child.id
                  FROM files AS child
                  INNER JOIN tree ON child.parent_id = tree.id
                  WHERE child.owner_id = $2
                    AND child.entry_type = 'folder'
                    AND child.state = 'active'
                )
                SELECT id FROM tree WHERE id = $3 LIMIT 1
            ",
            &[&root_folder_id, &owner_id, &folder_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(row.is_some())
}

fn repository_summary_from_row(row: Row) -> RepositorySummary {
    RepositorySummary {
        id: row.get("id"),
        owner_username: row.get("owner_username"),
        default_branch: "main",
        description: row.get("description"),
        root: RepositoryRoot {
            id: row.get("root_id"),
            name: row.get("root_name"),
            e2ee_state: row.get("root_e2ee_state"),
            updated_at: row.get("root_updated_at"),
        },
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn repository_entry_from_row(row: Row) -> RepositoryEntry {
    RepositoryEntry {
        id: row.get("id"),
        name: row.get("original_name"),
        mime_type: row.get("mime_type"),
        entry_type: row.get("entry_type"),
        parent_id: row.get("parent_id"),
        size_bytes: row.get("size_bytes"),
        e2ee_state: row.get("e2ee_state"),
        updated_at: row.get("updated_at"),
    }
}

async fn require_header_csrf(state: &AppState, request: &HttpRequest) -> Result<()> {
    let csrf_token = request
        .headers()
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| error::ErrorForbidden("csrf token required"))?;

    require_csrf(state, request, csrf_token).await
}
