use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use serde::{Deserialize, Serialize};
use tokio_postgres::Row;

use crate::auth::{SessionPrincipal, parse_json_body, require_csrf, require_principal};
use crate::routes::pagination::{decode_cursor, encode_cursor, row_limit};
use crate::state::AppState;
use crate::timestamps;

const MAX_REPOSITORY_ENTRIES: i64 = 500;
const REPOSITORY_LIST_PAGE_SIZE: usize = 100;
const MAX_REPOSITORY_ARCHIVE_ENTRIES: i64 = 50_000;
const MAX_REPOSITORY_ARCHIVE_BYTES: i64 = 2 * 1024 * 1024 * 1024;
const MAX_REPOSITORY_DESCRIPTION_CHARS: usize = 350;
const MAX_REPOSITORY_NAME_CHARS: usize = 100;
const REPOSITORY_JSON_LIMIT: usize = 16 * 1024;
const REPOSITORY_DETAIL_CONTEXT_QUERY: &str = r#"
    WITH RECURSIVE repository AS MATERIALIZED (
      SELECT
        repositories.id,
        repositories.description,
        repositories.root_file_id,
        repositories.total_files,
        repositories.total_folders,
        repositories.tree_version,
        repositories.counts_version,
        owners.username AS owner_username,
        roots.original_name AS root_name,
        roots.e2ee_state AS root_e2ee_state,
        roots.updated_at AS root_updated_at_value,
        repositories.created_at AS created_at_value,
        repositories.updated_at AS updated_at_value,
        COALESCE(NULLIF(btrim($3::text), ''), repositories.root_file_id)
          AS requested_folder_id
      FROM repositories
      INNER JOIN users AS owners ON owners.id = repositories.owner_id
      INNER JOIN files AS roots ON roots.id = repositories.root_file_id
      WHERE repositories.id = $1
        AND repositories.owner_id = $2
        AND roots.owner_id = repositories.owner_id
        AND roots.entry_type = 'folder'
        AND roots.state = 'active'
      LIMIT 1
    ),
    ancestors AS (
      SELECT
        folder.id,
        folder.original_name,
        folder.parent_id,
        folder.e2ee_state,
        repository.root_file_id,
        ARRAY[folder.id]::text[] AS visited_ids,
        0::integer AS depth
      FROM repository
      INNER JOIN files AS folder ON folder.id = repository.requested_folder_id
      WHERE folder.owner_id = $2
        AND folder.entry_type = 'folder'
        AND folder.state = 'active'

      UNION ALL

      SELECT
        parent.id,
        parent.original_name,
        parent.parent_id,
        parent.e2ee_state,
        child.root_file_id,
        child.visited_ids || parent.id,
        child.depth + 1
      FROM files AS parent
      INNER JOIN ancestors AS child ON child.parent_id = parent.id
      WHERE parent.owner_id = $2
        AND parent.state = 'active'
        AND child.id <> child.root_file_id
        AND child.depth < 100
        AND NOT parent.id = ANY(child.visited_ids)
    )
    SELECT
      repository.id,
      repository.description,
      repository.owner_username,
      repository.root_file_id AS root_id,
      repository.root_name,
      repository.root_e2ee_state,
      repository.root_updated_at_value AS root_updated_at,
      repository.created_at_value AS created_at,
      repository.updated_at_value AS updated_at,
      repository.total_files,
      repository.total_folders,
      repository.tree_version,
      repository.counts_version,
      repository.requested_folder_id,
      EXISTS (
        SELECT 1
        FROM ancestors AS authorization_path
        WHERE authorization_path.id = authorization_path.root_file_id
      ) AS folder_authorized,
      ancestors.id AS breadcrumb_id,
      ancestors.original_name AS breadcrumb_name,
      ancestors.e2ee_state AS breadcrumb_e2ee_state,
      COALESCE(ancestors.id <> repository.root_file_id, FALSE) AS include_breadcrumb
    FROM repository
    LEFT JOIN ancestors ON TRUE
    ORDER BY ancestors.depth DESC
"#;

const REPOSITORY_CHILDREN_QUERY: &str = r#"
    SELECT
      id,
      original_name,
      mime_type,
      entry_type,
      parent_id,
      size_bytes,
      e2ee_state,
      updated_at,
      CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END AS cursor_rank,
      lower(original_name) AS cursor_name
    FROM files
    WHERE owner_id = $1
      AND parent_id = $2
      AND state = 'active'
      AND (
        $3::integer IS NULL
        OR CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END > $3
        OR (
          CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END = $3
          AND (
            lower(original_name) > $4
            OR (lower(original_name) = $4 AND id > $5)
          )
        )
      )
    ORDER BY CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END,
             lower(original_name),
             id
    LIMIT $6
"#;

const REFRESH_REPOSITORY_TOTALS_QUERY: &str = r#"
    WITH RECURSIVE repository_snapshot AS MATERIALIZED (
      SELECT root_file_id, tree_version
      FROM repositories
      WHERE id = $1 AND owner_id = $2
      LIMIT 1
    ),
    tree AS (
      SELECT files.id, files.entry_type, ARRAY[files.id]::text[] AS visited_ids,
             0::integer AS depth
      FROM files
      INNER JOIN repository_snapshot
        ON repository_snapshot.root_file_id = files.id
      WHERE files.owner_id = $2 AND files.state = 'active'

      UNION ALL

      SELECT child.id, child.entry_type, tree.visited_ids || child.id,
             tree.depth + 1
      FROM files AS child
      INNER JOIN tree ON child.parent_id = tree.id
      WHERE child.owner_id = $2
        AND child.state = 'active'
        AND tree.depth < 100
        AND NOT child.id = ANY(tree.visited_ids)
    ),
    totals AS (
      SELECT
        count(*) FILTER (WHERE entry_type = 'file')::bigint AS total_files,
        GREATEST(count(*) FILTER (WHERE entry_type = 'folder') - 1, 0)::bigint
          AS total_folders
      FROM tree
    )
    UPDATE repositories
    SET total_files = totals.total_files,
        total_folders = totals.total_folders,
        counts_version = repository_snapshot.tree_version
    FROM repository_snapshot
    CROSS JOIN totals
    WHERE repositories.id = $1
      AND repositories.owner_id = $2
      AND repositories.tree_version = repository_snapshot.tree_version
    RETURNING repositories.total_files, repositories.total_folders
"#;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateRepositoryRequest {
    root_folder_id: String,
    description: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct CreateEmptyRepositoryRequest {
    name: String,
    description: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct UpdateRepositoryRequest {
    description: String,
}

#[derive(Deserialize)]
pub(crate) struct RepositoryQuery {
    folder: Option<String>,
    cursor: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct RepositoryListQuery {
    cursor: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct RepositoryListCursor {
    scope: String,
    updated_at: String,
    name: String,
    id: String,
}

#[derive(Deserialize, Serialize)]
struct RepositoryEntryCursor {
    scope: String,
    repository_id: String,
    folder_id: String,
    rank: i32,
    name: String,
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoriesResponse {
    repositories: Vec<RepositorySummary>,
    next_cursor: Option<String>,
    has_more: bool,
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
    next_cursor: Option<String>,
    has_more: bool,
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
    #[serde(skip)]
    total_files: i64,
    #[serde(skip)]
    total_folders: i64,
    #[serde(skip)]
    tree_version: i64,
    #[serde(skip)]
    counts_version: i64,
}

struct RepositoryDetailContext {
    repository: RepositorySummary,
    current_folder_id: String,
    breadcrumbs: Vec<RepositoryBreadcrumb>,
    folder_authorized: bool,
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

struct RepositoryEntryPage {
    rows: Vec<Row>,
    next_cursor: Option<String>,
    has_more: bool,
}

pub async fn list(
    state: web::Data<AppState>,
    request: HttpRequest,
    query: web::Query<RepositoryListQuery>,
) -> Result<HttpResponse> {
    let owner = require_principal(&state, &request).await?;
    let cursor = decode_cursor::<RepositoryListCursor>(query.cursor.as_deref())?;
    if cursor
        .as_ref()
        .is_some_and(|cursor| cursor.scope != "repositories")
    {
        return Err(error::ErrorBadRequest(
            "pagination cursor does not match repository list",
        ));
    }
    let cursor_updated_at = cursor.as_ref().map(|cursor| cursor.updated_at.clone());
    let cursor_name = cursor.as_ref().map(|cursor| cursor.name.clone());
    let cursor_id = cursor.as_ref().map(|cursor| cursor.id.clone());
    let limit = row_limit(REPOSITORY_LIST_PAGE_SIZE)?;
    let mut rows = state
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
                  roots.updated_at AS root_updated_at,
                  repositories.created_at,
                  repositories.updated_at,
                  repositories.total_files,
                  repositories.total_folders,
                  repositories.tree_version,
                  repositories.counts_version,
                  repositories.updated_at AS cursor_updated_at,
                  lower(roots.original_name) AS cursor_name
                FROM repositories
                INNER JOIN users AS owners ON owners.id = repositories.owner_id
                INNER JOIN files AS roots ON roots.id = repositories.root_file_id
                WHERE repositories.owner_id = $1
                  AND roots.owner_id = repositories.owner_id
                  AND roots.entry_type = 'folder'
                  AND roots.state = 'active'
                  AND (
                    $2::text IS NULL
                    OR repositories.updated_at < $2::text::timestamptz
                    OR (
                      repositories.updated_at = $2::text::timestamptz
                      AND (
                        lower(roots.original_name) > $3
                        OR (lower(roots.original_name) = $3 AND repositories.id > $4)
                      )
                    )
                  )
                ORDER BY repositories.updated_at DESC, lower(roots.original_name), repositories.id
                LIMIT $5
            ",
            &[
                &owner.id,
                &cursor_updated_at,
                &cursor_name,
                &cursor_id,
                &limit,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    let has_more = rows.len() > REPOSITORY_LIST_PAGE_SIZE;
    rows.truncate(REPOSITORY_LIST_PAGE_SIZE);
    let next_cursor = if has_more {
        rows.last()
            .map(|row| {
                encode_cursor(&RepositoryListCursor {
                    scope: "repositories".to_owned(),
                    updated_at: timestamps::cursor(row.get("cursor_updated_at")),
                    name: row.get("cursor_name"),
                    id: row.get("id"),
                })
            })
            .transpose()?
    } else {
        None
    };

    Ok(HttpResponse::Ok().json(RepositoriesResponse {
        repositories: rows.iter().map(repository_summary_from_row).collect(),
        next_cursor,
        has_more,
    }))
}

pub async fn create(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Payload,
) -> Result<HttpResponse> {
    let owner = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let body =
        parse_json_body::<CreateRepositoryRequest>(&request, body, REPOSITORY_JSON_LIMIT).await?;
    let root_folder_id = body.root_folder_id.trim();
    if root_folder_id.is_empty() {
        return Err(error::ErrorBadRequest("root folder is required"));
    }
    let description = normalize_description(body.description.as_deref())?;

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
                INSERT INTO repositories (id, owner_id, root_file_id, description)
                VALUES ('repo_' || replace(gen_random_uuid()::text, '-', ''), $1, $2, $3)
                ON CONFLICT (owner_id, root_file_id)
                DO UPDATE SET
                  root_file_id = EXCLUDED.root_file_id,
                  description = COALESCE(EXCLUDED.description, repositories.description),
                  updated_at = now()
                RETURNING id
            ",
            &[&owner.id, &root_folder_id, &description],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let repository_id: String = row.get("id");
    let repository = get_repository_summary(&state, &owner, &repository_id)
        .await?
        .ok_or_else(|| error::ErrorInternalServerError("repository could not be loaded"))?;

    Ok(HttpResponse::Created().json(repository))
}

pub async fn create_empty(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Payload,
) -> Result<HttpResponse> {
    let owner = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let body =
        parse_json_body::<CreateEmptyRepositoryRequest>(&request, body, REPOSITORY_JSON_LIMIT)
            .await?;
    if state.config.e2ee_mode.is_enabled() {
        return Ok(HttpResponse::Conflict()
            .body("encrypted repositories must create their root through the vault"));
    }

    let name = normalize_repository_name(&body.name)?;
    let description = normalize_description(body.description.as_deref())?;
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
            "SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:legacy-folder-tree:' || $1, 0))",
            &[&owner.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let existing_folder = transaction
        .query_opt(
            "
                SELECT id
                FROM files
                WHERE owner_id = $1
                  AND entry_type = 'folder'
                  AND state = 'active'
                  AND parent_id IS NULL
                  AND lower(original_name) = lower($2)
                LIMIT 1
            ",
            &[&owner.id, &name],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if existing_folder.is_some() {
        transaction
            .rollback()
            .await
            .map_err(error::ErrorInternalServerError)?;
        return Ok(HttpResponse::Conflict()
            .body("A top-level folder with this name already exists. Import it instead."));
    }

    let root = transaction
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
                VALUES (
                  gen_random_uuid()::text,
                  $1,
                  $2,
                  'folder_' || replace(gen_random_uuid()::text, '-', ''),
                  0,
                  'folder',
                  NULL
                )
                RETURNING id
            ",
            &[&owner.id, &name],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let root_folder_id: String = root.get("id");
    let repository = transaction
        .query_one(
            "
                INSERT INTO repositories (id, owner_id, root_file_id, description)
                VALUES ('repo_' || replace(gen_random_uuid()::text, '-', ''), $1, $2, $3)
                RETURNING id
            ",
            &[&owner.id, &root_folder_id, &description],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let repository_id: String = repository.get("id");
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    let repository = get_repository_summary(&state, &owner, &repository_id)
        .await?
        .ok_or_else(|| error::ErrorInternalServerError("repository could not be loaded"))?;
    Ok(HttpResponse::Created().json(repository))
}

pub async fn update(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    body: web::Payload,
) -> Result<HttpResponse> {
    let owner = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let body =
        parse_json_body::<UpdateRepositoryRequest>(&request, body, REPOSITORY_JSON_LIMIT).await?;
    let repository_id = path.into_inner();
    let description = normalize_description(Some(&body.description))?;
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
    let owner = require_principal(&state, &request).await?;
    let repository_id = path.into_inner();
    let requested_folder_id = query
        .folder
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(mut context) =
        get_repository_detail_context(&state, &owner, &repository_id, requested_folder_id).await?
    else {
        return Ok(HttpResponse::NotFound().finish());
    };
    if !context.folder_authorized {
        return Ok(HttpResponse::NotFound().body("repository folder not found"));
    }
    let entry_cursor = decode_cursor::<RepositoryEntryCursor>(query.cursor.as_deref())?;
    if entry_cursor.as_ref().is_some_and(|cursor| {
        cursor.scope != "repository-entries"
            || cursor.repository_id != repository_id
            || cursor.folder_id != context.current_folder_id
    }) {
        return Err(error::ErrorBadRequest(
            "pagination cursor does not match repository folder",
        ));
    }

    let counts_are_stale = context.repository.counts_version != context.repository.tree_version;
    let (entry_page, refreshed_totals) = if counts_are_stale {
        futures_util::try_join!(
            list_repository_children(
                &state,
                &owner.id,
                &repository_id,
                &context.current_folder_id,
                entry_cursor.as_ref(),
            ),
            refresh_repository_totals(&state, &owner.id, &repository_id),
        )?
    } else {
        (
            list_repository_children(
                &state,
                &owner.id,
                &repository_id,
                &context.current_folder_id,
                entry_cursor.as_ref(),
            )
            .await?,
            None,
        )
    };

    let refreshed_totals = if counts_are_stale && refreshed_totals.is_none() {
        // A concurrent structural write advanced the tree version while the
        // count was running. One new statement gets a fresh snapshot without
        // ever publishing totals for the wrong version.
        refresh_repository_totals(&state, &owner.id, &repository_id).await?
    } else {
        refreshed_totals
    };
    if let Some(summary) = refreshed_totals {
        context.repository.total_files = summary.total_files;
        context.repository.total_folders = summary.total_folders;
    }

    Ok(HttpResponse::Ok().json(RepositoryDetailResponse {
        summary: RepositoryTreeSummary {
            total_files: context.repository.total_files,
            total_folders: context.repository.total_folders,
        },
        repository: context.repository,
        current_folder_id: context.current_folder_id,
        breadcrumbs: context.breadcrumbs,
        entries: entry_page
            .rows
            .into_iter()
            .map(repository_entry_from_row)
            .collect(),
        entries_truncated: entry_page.has_more,
        next_cursor: entry_page.next_cursor,
        has_more: entry_page.has_more,
    }))
}

pub async fn archive_manifest(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    let owner = require_principal(&state, &request).await?;
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
                    ARRAY[id]::text[] AS visited_ids,
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
                    tree.visited_ids || child.id,
                    tree.depth + 1
                  FROM files AS child
                  INNER JOIN tree ON child.parent_id = tree.id
                  WHERE child.owner_id = $2
                    AND child.state = 'active'
                    AND tree.depth < 100
                    AND NOT child.id = ANY(tree.visited_ids)
                )
                SELECT
                  id,
                  original_name,
                  mime_type,
                  entry_type,
                  parent_id,
                  size_bytes,
                  e2ee_state,
                  updated_at
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

async fn get_repository_detail_context(
    state: &AppState,
    owner: &SessionPrincipal,
    repository_id: &str,
    requested_folder_id: Option<&str>,
) -> Result<Option<RepositoryDetailContext>> {
    let rows = state
        .db
        .query(
            REPOSITORY_DETAIL_CONTEXT_QUERY,
            &[&repository_id, &owner.id, &requested_folder_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(first_row) = rows.first() else {
        return Ok(None);
    };

    let folder_authorized: bool = first_row.get("folder_authorized");
    let breadcrumbs = if folder_authorized {
        rows.iter()
            .filter(|row| row.get::<_, bool>("include_breadcrumb"))
            .map(|row| RepositoryBreadcrumb {
                id: row.get("breadcrumb_id"),
                name: row.get("breadcrumb_name"),
                e2ee_state: row.get("breadcrumb_e2ee_state"),
            })
            .collect()
    } else {
        Vec::new()
    };

    Ok(Some(RepositoryDetailContext {
        repository: repository_summary_from_row(first_row),
        current_folder_id: first_row.get("requested_folder_id"),
        breadcrumbs,
        folder_authorized,
    }))
}

async fn list_repository_children(
    state: &AppState,
    owner_id: &str,
    repository_id: &str,
    folder_id: &str,
    cursor: Option<&RepositoryEntryCursor>,
) -> Result<RepositoryEntryPage> {
    let cursor_rank = cursor.map(|cursor| cursor.rank);
    let cursor_name = cursor.map(|cursor| cursor.name.clone());
    let cursor_id = cursor.map(|cursor| cursor.id.clone());
    let limit = row_limit(MAX_REPOSITORY_ENTRIES as usize)?;
    let mut rows = state
        .db
        .query(
            REPOSITORY_CHILDREN_QUERY,
            &[
                &owner_id,
                &folder_id,
                &cursor_rank,
                &cursor_name,
                &cursor_id,
                &limit,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let has_more = rows.len() > MAX_REPOSITORY_ENTRIES as usize;
    rows.truncate(MAX_REPOSITORY_ENTRIES as usize);
    let next_cursor = if has_more {
        rows.last()
            .map(|row| {
                encode_cursor(&RepositoryEntryCursor {
                    scope: "repository-entries".to_owned(),
                    repository_id: repository_id.to_owned(),
                    folder_id: folder_id.to_owned(),
                    rank: row.get("cursor_rank"),
                    name: row.get("cursor_name"),
                    id: row.get("id"),
                })
            })
            .transpose()?
    } else {
        None
    };

    Ok(RepositoryEntryPage {
        rows,
        next_cursor,
        has_more,
    })
}

async fn refresh_repository_totals(
    state: &AppState,
    owner_id: &str,
    repository_id: &str,
) -> Result<Option<RepositoryTreeSummary>> {
    let row = state
        .db
        .query_opt(
            REFRESH_REPOSITORY_TOTALS_QUERY,
            &[&repository_id, &owner_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(row.map(|row| RepositoryTreeSummary {
        total_files: row.get("total_files"),
        total_folders: row.get("total_folders"),
    }))
}

async fn get_repository_summary(
    state: &AppState,
    owner: &SessionPrincipal,
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
                  roots.updated_at AS root_updated_at,
                  repositories.created_at,
                  repositories.updated_at,
                  repositories.total_files,
                  repositories.total_folders,
                  repositories.tree_version,
                  repositories.counts_version
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

    Ok(row.as_ref().map(repository_summary_from_row))
}

fn repository_summary_from_row(row: &Row) -> RepositorySummary {
    RepositorySummary {
        id: row.get("id"),
        owner_username: row.get("owner_username"),
        default_branch: "main",
        description: row.get("description"),
        root: RepositoryRoot {
            id: row.get("root_id"),
            name: row.get("root_name"),
            e2ee_state: row.get("root_e2ee_state"),
            updated_at: timestamps::api(row.get("root_updated_at")),
        },
        created_at: timestamps::api(row.get("created_at")),
        updated_at: timestamps::api(row.get("updated_at")),
        total_files: row.get("total_files"),
        total_folders: row.get("total_folders"),
        tree_version: row.get("tree_version"),
        counts_version: row.get("counts_version"),
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
        updated_at: timestamps::api(row.get("updated_at")),
    }
}

fn normalize_repository_name(value: &str) -> Result<String> {
    let name = value.trim();
    if name.is_empty() {
        return Err(error::ErrorBadRequest("repository name is required"));
    }
    if name.chars().count() > MAX_REPOSITORY_NAME_CHARS {
        return Err(error::ErrorBadRequest(
            "repository name must be 100 characters or fewer",
        ));
    }
    if matches!(name, "." | "..")
        || !name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err(error::ErrorBadRequest(
            "repository name may only contain letters, numbers, periods, hyphens, and underscores",
        ));
    }
    Ok(name.to_owned())
}

fn normalize_description(value: Option<&str>) -> Result<Option<String>> {
    let description = value.map(str::trim).unwrap_or_default();
    if description.chars().count() > MAX_REPOSITORY_DESCRIPTION_CHARS {
        return Err(error::ErrorBadRequest(
            "repository description must be 350 characters or fewer",
        ));
    }
    Ok((!description.is_empty()).then(|| description.to_owned()))
}

async fn require_header_csrf(state: &AppState, request: &HttpRequest) -> Result<()> {
    let csrf_token = request
        .headers()
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| error::ErrorForbidden("csrf token required"))?;

    require_csrf(state, request, csrf_token).await
}

#[cfg(test)]
mod tests {
    use super::{
        REFRESH_REPOSITORY_TOTALS_QUERY, REPOSITORY_DETAIL_CONTEXT_QUERY, normalize_description,
        normalize_repository_name,
    };

    #[test]
    fn detail_authorizes_and_builds_breadcrumbs_with_one_upward_walk() {
        assert!(REPOSITORY_DETAIL_CONTEXT_QUERY.contains("WITH RECURSIVE repository"));
        assert!(REPOSITORY_DETAIL_CONTEXT_QUERY.contains("requested_folder_id"));
        assert!(
            REPOSITORY_DETAIL_CONTEXT_QUERY
                .contains("INNER JOIN ancestors AS child ON child.parent_id = parent.id")
        );
        assert!(REPOSITORY_DETAIL_CONTEXT_QUERY.contains("authorization_path.id"));
        assert!(!REPOSITORY_DETAIL_CONTEXT_QUERY.contains("child.parent_id = tree.id"));

        let source = include_str!("repositories.rs");
        let detail = source
            .split_once("pub async fn detail(")
            .and_then(|(_, tail)| tail.split_once("pub async fn archive_manifest("))
            .map(|(detail, _)| detail)
            .expect("repository detail source should remain inspectable");
        assert!(detail.contains("get_repository_detail_context("));
        assert!(detail.contains("futures_util::try_join!("));
        assert!(!detail.contains("folder_is_in_repository("));
    }

    #[test]
    fn detail_only_recounts_a_changed_tree_and_version_gates_publication() {
        assert!(REFRESH_REPOSITORY_TOTALS_QUERY.contains("tree_version"));
        assert!(REFRESH_REPOSITORY_TOTALS_QUERY.contains("counts_version"));
        assert!(
            REFRESH_REPOSITORY_TOTALS_QUERY
                .contains("repositories.tree_version = repository_snapshot.tree_version")
        );
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
            super::REPOSITORY_DETAIL_CONTEXT_QUERY,
            super::REPOSITORY_CHILDREN_QUERY,
            super::REFRESH_REPOSITORY_TOTALS_QUERY,
        ] {
            client
                .prepare(query)
                .await
                .expect("repository query prepares");
        }
    }

    #[test]
    fn validates_and_normalizes_repository_names() {
        assert_eq!(
            normalize_repository_name("  aeralyth-ui_2.0  ").unwrap(),
            "aeralyth-ui_2.0"
        );

        for invalid in ["", "   ", ".", "..", "has spaces", "owner/repo"] {
            assert!(normalize_repository_name(invalid).is_err(), "{invalid}");
        }
        assert!(normalize_repository_name(&"a".repeat(101)).is_err());
    }

    #[test]
    fn normalizes_optional_repository_descriptions() {
        assert_eq!(normalize_description(None).unwrap(), None);
        assert_eq!(normalize_description(Some("   ")).unwrap(), None);
        assert_eq!(
            normalize_description(Some("  Private source mirror  ")).unwrap(),
            Some("Private source mirror".to_owned())
        );
        assert!(normalize_description(Some(&"a".repeat(351))).is_err());
    }
}
