use actix_web::http::header::CACHE_CONTROL;
use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use tokio_postgres::{IsolationLevel, Row};

use crate::auth::{SessionPrincipal, parse_json_body, require_header_csrf, require_principal};
use crate::routes::pagination::{decode_cursor, encode_cursor, row_limit};
use crate::state::AppState;
use crate::timestamps;

use super::conditional;

const MAX_REPOSITORY_ENTRIES: i64 = 500;
const REPOSITORY_LIST_PAGE_SIZE: usize = 100;
const REPOSITORY_ARCHIVE_PAGE_SIZE: usize = 1_000;
const MAX_REPOSITORY_ARCHIVE_ENTRIES: i64 = 50_000;
const MAX_REPOSITORY_ARCHIVE_BYTES: i64 = 2 * 1024 * 1024 * 1024;
const MAX_REPOSITORY_DESCRIPTION_CHARS: usize = 350;
const MAX_REPOSITORY_NAME_CHARS: usize = 100;
const REPOSITORY_JSON_LIMIT: usize = 16 * 1024;
const PREPARE_REPOSITORY_ARCHIVE_QUERY: &str = r#"
    WITH RECURSIVE tree AS (
      SELECT f.id, ARRAY[f.id]::text[] AS visited_ids, 0::integer AS depth FROM visible_files f
      WHERE f.id=$3 AND f.owner_id=$2 AND f.state='active'
      UNION ALL
      SELECT f.id, t.visited_ids || f.id, t.depth+1 FROM visible_files f JOIN tree t ON f.parent_id=t.id
      WHERE f.owner_id=$2 AND f.state='active' AND t.depth < 100
        AND NOT f.id = ANY(t.visited_ids)
    ), selected_tree AS MATERIALIZED (
      SELECT * FROM tree LIMIT 50002
    ), manifest AS (
      INSERT INTO repository_archive_manifests(owner_id,repository_id,content_version)
      VALUES($2,$1,$4) ON CONFLICT(owner_id,repository_id,content_version) DO NOTHING RETURNING id
    ), entries AS (
      INSERT INTO repository_archive_entries (
        manifest_id,ordinal,id,original_name,mime_type,entry_type,parent_id,size_bytes,
        e2ee_state,updated_at,vault_generation_id,vault_record_version,vault_record_hash
      )
      SELECT m.id, row_number() OVER (ORDER BY t.depth,CASE WHEN f.entry_type='folder' THEN 0 ELSE 1 END,lower(f.original_name),f.id),
        f.id,f.original_name,f.mime_type,f.entry_type,f.parent_id,f.size_bytes,
        f.e2ee_state,f.updated_at,f.current_generation_id,h.record_version,h.record_hash
      FROM selected_tree t JOIN visible_files f ON f.id=t.id CROSS JOIN manifest m
      LEFT JOIN vault_node_heads h ON h.node_id=f.id WHERE t.depth>0
      ORDER BY t.depth,CASE WHEN f.entry_type='folder' THEN 0 ELSE 1 END,lower(f.original_name),f.id
      LIMIT 50001
      RETURNING entry_type,size_bytes,e2ee_state
    )
    SELECT (SELECT id::text FROM manifest) AS manifest_id,
      count(*)::bigint AS total_entries,
      count(*) FILTER(WHERE entry_type='file')::bigint AS total_files,
      COALESCE(sum(GREATEST(size_bytes,0)) FILTER(WHERE entry_type='file'),0)::bigint AS total_bytes,
      count(*) FILTER(WHERE e2ee_state='encrypted')::bigint AS total_encrypted_entries
    FROM entries
"#;
// Folder names and filenames mirrored from src/features/repositories/repository-languages.ts.
// Keep both lists in sync; repository-languages.test.ts compares them.
const LANGUAGE_IGNORED_DIRECTORIES: &[&str] = &[
    ".next",
    ".output",
    ".turbo",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "pods",
    "target",
    "vendor",
];
const LANGUAGE_FILENAMES: &[&str] = &["cmakelists.txt", "dockerfile", "justfile", "makefile"];
// Walks the same bounded tree as the archive manifest without materializing it.
// Readable names are grouped by extension (or by a recognized filename) here;
// entries at or below an encrypted node are returned individually because
// only the browser can read their names and plaintext sizes.
const REPOSITORY_LANGUAGE_STATS_QUERY: &str = r#"
    WITH RECURSIVE tree AS (
      SELECT f.id, f.parent_id, f.entry_type, f.original_name, f.size_bytes, f.e2ee_state,
        f.current_generation_id, ARRAY[f.id]::text[] AS visited_ids, 0::integer AS depth,
        FALSE AS hidden
      FROM visible_files f
      WHERE f.id=$2 AND f.owner_id=$1 AND f.state='active'
      UNION ALL
      SELECT f.id, f.parent_id, f.entry_type, f.original_name, f.size_bytes, f.e2ee_state,
        f.current_generation_id, t.visited_ids || f.id, t.depth+1,
        t.hidden OR f.e2ee_state='encrypted'
      FROM visible_files f JOIN tree t ON f.parent_id=t.id
      WHERE f.owner_id=$1 AND f.state='active' AND t.depth < 100
        AND NOT f.id = ANY(t.visited_ids)
        AND (f.e2ee_state='encrypted' OR NOT lower(f.original_name) = ANY($3::text[]))
    ), selected_tree AS MATERIALIZED (
      SELECT * FROM tree LIMIT 50002
    ), entries AS MATERIALIZED (
      SELECT * FROM selected_tree WHERE depth>0
    ), readable_files AS (
      SELECT lower(original_name) AS normalized_name, size_bytes FROM entries
      WHERE NOT hidden AND entry_type='file' AND size_bytes>0
        AND original_name !~* '(\.bundle\.|\.generated\.|\.min\.|\.snap$|\.map$)'
        AND original_name !~* '(^|[-.])lock(\.|$)'
    ), language_groups AS (
      SELECT CASE WHEN normalized_name = ANY($4::text[]) THEN 'filename' ELSE 'extension' END
          AS group_kind,
        CASE WHEN normalized_name = ANY($4::text[]) THEN normalized_name
          ELSE COALESCE(substring(normalized_name FROM '^.+\.([^.]+)$'), '') END AS group_key,
        size_bytes
      FROM readable_files
    )
    SELECT 0 AS row_rank, 'summary' AS row_kind, count(*)::bigint AS total_entries,
      NULL::text AS group_kind, NULL::text AS group_key, NULL::bigint AS files, NULL::bigint AS bytes,
      NULL::text AS id, NULL::text AS parent_id, NULL::text AS entry_type,
      NULL::text AS original_name, NULL::bigint AS size_bytes, NULL::text AS e2ee_state,
      NULL::bytea AS vault_generation_id, NULL::bigint AS vault_record_version,
      NULL::bytea AS vault_record_hash, 0 AS depth
    FROM entries
    UNION ALL
    SELECT 1, 'group', NULL, group_kind, group_key, count(*)::bigint, sum(size_bytes)::bigint,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0
    FROM language_groups GROUP BY group_kind, group_key
    UNION ALL
    SELECT 2, 'node', NULL, NULL, NULL, NULL, NULL,
      e.id, e.parent_id, e.entry_type,
      CASE WHEN e.e2ee_state='encrypted' THEN NULL ELSE e.original_name END,
      e.size_bytes, e.e2ee_state, e.current_generation_id, h.record_version, h.record_hash, e.depth
    FROM entries e LEFT JOIN vault_node_heads h ON h.node_id=e.id
    WHERE e.hidden
    ORDER BY row_rank, depth, group_kind, group_key, id
"#;
const REPOSITORY_ARCHIVE_PAGE_QUERY: &str = r#"
    SELECT id,original_name,mime_type,entry_type,parent_id,size_bytes,e2ee_state,
      updated_at,vault_generation_id,vault_record_version,vault_record_hash,ordinal
    FROM repository_archive_entries
    WHERE manifest_id=$1::text::uuid AND ordinal>$2 AND ordinal<=$2+$3::bigint
    ORDER BY ordinal LIMIT $3
"#;
const REPOSITORY_ARCHIVE_SNAPSHOT_QUERY: &str = r#"
    SELECT id::text AS manifest_id,total_entries,total_files,total_bytes,total_encrypted_entries
    FROM repository_archive_manifests
    WHERE id=$1::text::uuid AND repository_id=$2 AND owner_id=$3
      AND content_version=$4 AND expires_at>now()
"#;
const REPOSITORY_SUMMARY_QUERY: &str = r#"
    SELECT
      repositories.id,
      repositories.description,
      owners.username AS owner_username,
      roots.id AS root_id,
      roots.original_name AS root_name,
      roots.e2ee_state AS root_e2ee_state,
      roots.updated_at AS root_updated_at,
      roots.current_generation_id AS root_vault_generation_id,
      root_heads.record_version AS root_vault_record_version,
      root_heads.record_hash AS root_vault_record_hash,
      repositories.created_at,
      repositories.updated_at,
      repositories.total_files,
      repositories.total_folders,
      repository_content_version(repositories.id) AS tree_version,
      repositories.counts_version
    FROM repositories
    INNER JOIN users AS owners ON owners.id = repositories.owner_id
    INNER JOIN visible_files AS roots ON roots.id = repositories.root_file_id
    LEFT JOIN vault_node_heads AS root_heads ON root_heads.node_id = roots.id
    WHERE repositories.id = $1
      AND repositories.owner_id = $2
      AND roots.owner_id = repositories.owner_id
      AND roots.entry_type = 'folder'
      AND roots.state = 'active'
    LIMIT 1
"#;
const CREATE_REPOSITORY_QUERY: &str = r#"
    WITH root AS MATERIALIZED (
      SELECT files.id AS root_id, files.original_name AS root_name,
             files.e2ee_state AS root_e2ee_state,
             files.updated_at AS root_updated_at,
             files.current_generation_id AS root_vault_generation_id,
             owners.username AS owner_username
      FROM visible_files AS files
      INNER JOIN users AS owners ON owners.id = files.owner_id
      WHERE files.id = $2
        AND files.owner_id = $1
        AND files.entry_type = 'folder'
        AND files.state = 'active'
      LIMIT 1
    ),
    mutation AS (
      INSERT INTO repositories (id, owner_id, root_file_id, description)
      SELECT 'repo_' || replace(gen_random_uuid()::text, '-', ''), $1, root.root_id, $3
      FROM root
      ON CONFLICT (owner_id, root_file_id)
      DO UPDATE SET
        root_file_id = EXCLUDED.root_file_id,
        description = COALESCE(EXCLUDED.description, repositories.description),
        updated_at = now()
      RETURNING *
    )
    SELECT mutation.id, mutation.description, root.owner_username,
           root.root_id, root.root_name, root.root_e2ee_state,
           root.root_updated_at, root.root_vault_generation_id,
           heads.record_version AS root_vault_record_version,
           heads.record_hash AS root_vault_record_hash,
           mutation.created_at, mutation.updated_at,
           mutation.total_files, mutation.total_folders,
           repository_content_version(mutation.id) AS tree_version, mutation.counts_version
    FROM mutation
    INNER JOIN root ON root.root_id = mutation.root_file_id
    LEFT JOIN vault_node_heads AS heads ON heads.node_id = root.root_id
"#;
const CREATE_EMPTY_REPOSITORY_QUERY: &str = r#"
    WITH root AS (
      INSERT INTO files (
        id, owner_id, original_name, storage_name, size_bytes, entry_type, parent_id
      )
      VALUES (
        gen_random_uuid()::text, $1, $2,
        'folder_' || replace(gen_random_uuid()::text, '-', ''), 0, 'folder', NULL
      )
      RETURNING id AS root_id, original_name AS root_name,
                e2ee_state AS root_e2ee_state, updated_at AS root_updated_at,
                current_generation_id AS root_vault_generation_id
    ),
    mutation AS (
      INSERT INTO repositories (id, owner_id, root_file_id, description)
      SELECT 'repo_' || replace(gen_random_uuid()::text, '-', ''), $1, root.root_id, $3
      FROM root
      RETURNING *
    )
    SELECT mutation.id, mutation.description, owners.username AS owner_username,
           root.root_id, root.root_name, root.root_e2ee_state,
           root.root_updated_at, root.root_vault_generation_id,
           heads.record_version AS root_vault_record_version,
           heads.record_hash AS root_vault_record_hash,
           mutation.created_at, mutation.updated_at,
           mutation.total_files, mutation.total_folders,
           repository_content_version(mutation.id) AS tree_version, mutation.counts_version
    FROM mutation
    INNER JOIN root ON root.root_id = mutation.root_file_id
    INNER JOIN users AS owners ON owners.id = mutation.owner_id
    LEFT JOIN vault_node_heads AS heads ON heads.node_id = root.root_id
"#;
const UPDATE_REPOSITORY_QUERY: &str = r#"
    WITH mutation AS (
      UPDATE repositories
      SET description = $1, updated_at = now()
      WHERE id = $2 AND owner_id = $3
        AND EXISTS (
          SELECT 1
          FROM visible_files AS roots
          WHERE roots.id = repositories.root_file_id
            AND roots.owner_id = repositories.owner_id
            AND roots.entry_type = 'folder'
            AND roots.state = 'active'
        )
      RETURNING *
    )
    SELECT mutation.id, mutation.description, owners.username AS owner_username,
           roots.id AS root_id, roots.original_name AS root_name,
           roots.e2ee_state AS root_e2ee_state,
           roots.updated_at AS root_updated_at,
           roots.current_generation_id AS root_vault_generation_id,
           heads.record_version AS root_vault_record_version,
           heads.record_hash AS root_vault_record_hash,
           mutation.created_at, mutation.updated_at,
           mutation.total_files, mutation.total_folders,
           repository_content_version(mutation.id) AS tree_version, mutation.counts_version
    FROM mutation
    INNER JOIN users AS owners ON owners.id = mutation.owner_id
    INNER JOIN visible_files AS roots ON roots.id = mutation.root_file_id
      AND roots.owner_id = mutation.owner_id
      AND roots.entry_type = 'folder'
      AND roots.state = 'active'
    LEFT JOIN vault_node_heads AS heads ON heads.node_id = roots.id
"#;
const REPOSITORY_DETAIL_CONTEXT_QUERY: &str = r#"
    WITH RECURSIVE repository AS MATERIALIZED (
      SELECT
        repositories.id,
        repositories.description,
        repositories.root_file_id,
        repositories.total_files,
        repositories.total_folders,
        repository_content_version(repositories.id) AS tree_version,
        repositories.counts_version,
        owners.username AS owner_username,
        roots.original_name AS root_name,
        roots.e2ee_state AS root_e2ee_state,
        roots.updated_at AS root_updated_at_value,
        roots.current_generation_id AS root_vault_generation_id,
        root_heads.record_version AS root_vault_record_version,
        root_heads.record_hash AS root_vault_record_hash,
        repositories.created_at AS created_at_value,
        repositories.updated_at AS updated_at_value,
        COALESCE(NULLIF(btrim($3::text), ''), repositories.root_file_id)
          AS requested_folder_id
      FROM repositories
      INNER JOIN users AS owners ON owners.id = repositories.owner_id
      INNER JOIN visible_files AS roots ON roots.id = repositories.root_file_id
      LEFT JOIN vault_node_heads AS root_heads ON root_heads.node_id = roots.id
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
        folder.current_generation_id,
        repository.root_file_id,
        ARRAY[folder.id]::text[] AS visited_ids,
        0::integer AS depth
      FROM repository
      INNER JOIN visible_files AS folder ON folder.id = repository.requested_folder_id
      WHERE folder.owner_id = $2
        AND folder.entry_type = 'folder'
        AND folder.state = 'active'

      UNION ALL

      SELECT
        parent.id,
        parent.original_name,
        parent.parent_id,
        parent.e2ee_state,
        parent.current_generation_id,
        child.root_file_id,
        child.visited_ids || parent.id,
        child.depth + 1
      FROM visible_files AS parent
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
      repository.root_vault_generation_id,
      repository.root_vault_record_version,
      repository.root_vault_record_hash,
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
      ancestors.current_generation_id AS breadcrumb_vault_generation_id,
      breadcrumb_heads.record_version AS breadcrumb_vault_record_version,
      breadcrumb_heads.record_hash AS breadcrumb_vault_record_hash,
      COALESCE(ancestors.id <> repository.root_file_id, FALSE) AS include_breadcrumb
    FROM repository
    LEFT JOIN ancestors ON TRUE
    LEFT JOIN vault_node_heads AS breadcrumb_heads ON breadcrumb_heads.node_id = ancestors.id
    ORDER BY ancestors.depth DESC
"#;

const REPOSITORY_CHILDREN_QUERY: &str = r#"
    SELECT
      files.id,
      files.original_name,
      files.mime_type,
      files.entry_type,
      files.parent_id,
      files.size_bytes,
      files.e2ee_state,
      files.updated_at,
      files.current_generation_id AS vault_generation_id,
      heads.record_version AS vault_record_version,
      heads.record_hash AS vault_record_hash,
      CASE WHEN files.entry_type = 'folder' THEN 0 ELSE 1 END AS cursor_rank,
      lower(files.original_name) AS cursor_name
    FROM visible_files AS files
    LEFT JOIN vault_node_heads AS heads ON heads.node_id = files.id
    WHERE files.owner_id = $1
      AND files.parent_id = $2
      AND files.state = 'active'
      AND (
        $3::integer IS NULL
        OR CASE WHEN files.entry_type = 'folder' THEN 0 ELSE 1 END > $3
        OR (
          CASE WHEN files.entry_type = 'folder' THEN 0 ELSE 1 END = $3
          AND (
            lower(files.original_name) > $4
            OR (lower(files.original_name) = $4 AND files.id > $5)
          )
        )
      )
    ORDER BY CASE WHEN files.entry_type = 'folder' THEN 0 ELSE 1 END,
             lower(files.original_name),
             files.id
    LIMIT $6
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
pub(crate) struct RepositoryArchiveQuery {
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

#[derive(Deserialize, Serialize)]
struct RepositoryArchiveCursor {
    scope: String,
    repository_id: String,
    snapshot_version: i64,
    manifest_id: String,
    ordinal: i64,
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
struct RepositoryArchiveManifestPageResponse {
    repository: RepositorySummary,
    entries: Vec<RepositoryArchiveEntry>,
    snapshot_version: i64,
    total_bytes: i64,
    total_entries: i64,
    total_files: i64,
    total_encrypted_entries: i64,
    next_cursor: Option<String>,
    has_more: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryLanguageStatsResponse {
    repository_id: String,
    content_version: i64,
    language_groups: Vec<RepositoryLanguageGroup>,
    encrypted_entries: Vec<RepositoryLanguageEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryLanguageGroup {
    kind: String,
    key: String,
    files: i64,
    bytes: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryLanguageEntry {
    id: String,
    parent_id: Option<String>,
    entry_type: String,
    name: Option<String>,
    size_bytes: i64,
    e2ee_state: String,
    vault_generation_id: Option<String>,
    vault_record_version: Option<i64>,
    vault_record_hash: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryArchiveEntry {
    #[serde(flatten)]
    entry: RepositoryEntry,
    content_version: String,
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
    /// Changes with every file or vault-head change in the tree; clients key
    /// derived repository data such as language statistics on it.
    #[serde(rename = "contentVersion")]
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
    vault_generation_id: Option<String>,
    vault_record_version: Option<i64>,
    vault_record_hash: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryBreadcrumb {
    id: String,
    name: String,
    e2ee_state: String,
    vault_generation_id: Option<String>,
    vault_record_version: Option<i64>,
    vault_record_hash: Option<String>,
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
    vault_generation_id: Option<String>,
    vault_record_version: Option<i64>,
    vault_record_hash: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryTreeSummary {
    total_files: i64,
    total_folders: i64,
    stale: bool,
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
                  roots.current_generation_id AS root_vault_generation_id,
                  root_heads.record_version AS root_vault_record_version,
                  root_heads.record_hash AS root_vault_record_hash,
                  repositories.created_at,
                  repositories.updated_at,
                  repositories.total_files,
                  repositories.total_folders,
                  repository_content_version(repositories.id) AS tree_version,
                  repositories.counts_version,
                  repositories.updated_at AS cursor_updated_at,
                  lower(roots.original_name) AS cursor_name
                FROM repositories
                INNER JOIN users AS owners ON owners.id = repositories.owner_id
                INNER JOIN visible_files AS roots ON roots.id = repositories.root_file_id
                LEFT JOIN vault_node_heads AS root_heads ON root_heads.node_id = roots.id
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
        .map_err(crate::db::http_error)?;

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

    conditional::private_json(
        &request,
        &RepositoriesResponse {
            repositories: rows.iter().map(repository_summary_from_row).collect(),
            next_cursor,
            has_more,
        },
    )
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

    let row = state
        .db
        .query_opt(
            CREATE_REPOSITORY_QUERY,
            &[&owner.id, &root_folder_id, &description],
        )
        .await
        .map_err(crate::db::http_error)?;
    let Some(row) = row else {
        return Ok(HttpResponse::NotFound().body("repository folder not found"));
    };
    let repository = repository_summary_from_row(&row);

    Ok(HttpResponse::Created()
        .insert_header((CACHE_CONTROL, "private, no-store"))
        .json(repository))
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
    let mut client = state.db.get().await.map_err(crate::db::http_error)?;
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
                FROM visible_files AS files
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

    let repository = transaction
        .query_one(
            CREATE_EMPTY_REPOSITORY_QUERY,
            &[&owner.id, &name, &description],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let repository = repository_summary_from_row(&repository);
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::Created()
        .insert_header((CACHE_CONTROL, "private, no-store"))
        .json(repository))
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
            UPDATE_REPOSITORY_QUERY,
            &[&description, &repository_id, &owner.id],
        )
        .await
        .map_err(crate::db::http_error)?;
    let Some(updated) = updated else {
        return Ok(HttpResponse::NotFound().finish());
    };
    let repository = repository_summary_from_row(&updated);
    Ok(HttpResponse::Ok()
        .insert_header((CACHE_CONTROL, "private, no-store"))
        .json(repository))
}

pub async fn detail(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    query: web::Query<RepositoryQuery>,
) -> Result<HttpResponse> {
    let owner = require_principal(&state, &request).await?;
    let _recursive_permit = state.acquire_interactive_operation(&owner.id).await?;
    let repository_id = path.into_inner();
    let requested_folder_id = query
        .folder
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(context) =
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

    let validator = conditional::PrivateRevision::new(
        &request,
        "repository-detail-v1",
        &(&owner.id, &owner.role),
        &(
            &context.repository,
            &context.current_folder_id,
            &context.breadcrumbs,
            context.repository.tree_version,
            context.repository.counts_version,
            context.repository.total_files,
            context.repository.total_folders,
        ),
    )?;
    if let Some(response) = validator.not_modified(&request) {
        return Ok(response);
    }
    let entry_page = list_repository_children(
        &state,
        &owner.id,
        &repository_id,
        &context.current_folder_id,
        entry_cursor.as_ref(),
    )
    .await?;

    validator.json(&RepositoryDetailResponse {
        summary: RepositoryTreeSummary {
            total_files: context.repository.total_files,
            total_folders: context.repository.total_folders,
            stale: context.repository.counts_version != context.repository.tree_version,
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
    })
}

pub async fn archive_manifest(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    query: web::Query<RepositoryArchiveQuery>,
) -> Result<HttpResponse> {
    let owner = require_principal(&state, &request).await?;
    let _recursive_permit = state.acquire_recursive_operation(&owner.id).await?;
    let repository_id = path.into_inner();
    let cursor = decode_cursor::<RepositoryArchiveCursor>(query.cursor.as_deref())?;
    if cursor.as_ref().is_some_and(|cursor| {
        cursor.scope != "repository-archive" || cursor.repository_id != repository_id
    }) {
        return Err(error::ErrorBadRequest(
            "archive cursor does not match repository",
        ));
    }
    let mut client = state.db.get().await.map_err(crate::db::http_error)?;
    // Every page reads a single snapshot. Subsequent pages use indexed saved
    // ordinals and compare the current content revision before returning data.
    let transaction = client
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .start()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(repository_row) = transaction
        .query_opt(REPOSITORY_SUMMARY_QUERY, &[&repository_id, &owner.id])
        .await
        .map_err(error::ErrorInternalServerError)?
    else {
        return Ok(HttpResponse::NotFound().finish());
    };
    let repository = repository_summary_from_row(&repository_row);
    let snapshot_version = cursor
        .as_ref()
        .map(|cursor| cursor.snapshot_version)
        .unwrap_or(repository.tree_version);
    if snapshot_version != repository.tree_version {
        return Ok(HttpResponse::Conflict()
            .body("The repository changed while its archive manifest was being read."));
    }
    let snapshot = if let Some(cursor) = &cursor {
        transaction
            .query_opt(
                REPOSITORY_ARCHIVE_SNAPSHOT_QUERY,
                &[
                    &cursor.manifest_id,
                    &repository_id,
                    &owner.id,
                    &snapshot_version,
                ],
            )
            .await
            .map_err(error::ErrorInternalServerError)?
    } else {
        let existing = transaction.query_opt(
            "SELECT id::text AS manifest_id,total_entries,total_files,total_bytes,total_encrypted_entries
             FROM repository_archive_manifests WHERE repository_id=$1 AND owner_id=$2
               AND content_version=$3 AND expires_at>now()
             ORDER BY expires_at DESC LIMIT 1",
            &[&repository_id,&owner.id,&snapshot_version],
        ).await.map_err(error::ErrorInternalServerError)?;
        if existing.is_some() {
            existing
        } else {
            // Try-lock prevents simultaneous cold requests from copying the
            // same tree. A competing request retries after preparation commits.
            let locked: bool = transaction.query_one(
                "SELECT pg_try_advisory_xact_lock(hashtextextended('aeralyth:archive-manifest:' || $1,0))",
                &[&repository_id],
            ).await.map_err(error::ErrorInternalServerError)?.get(0);
            if !locked {
                return Ok(HttpResponse::Conflict()
                    .body("The repository archive is being prepared. Please retry."));
            }
            if let Err(failure) = transaction.execute(
                "DELETE FROM repository_archive_manifests WHERE repository_id=$1 AND owner_id=$2 AND content_version=$3 AND expires_at<=now()",
                &[&repository_id,&owner.id,&snapshot_version],
            ).await {
                if failure.code() == Some(&tokio_postgres::error::SqlState::T_R_SERIALIZATION_FAILURE) {
                    return Ok(HttpResponse::Conflict().body("The repository archive is being prepared. Please retry."));
                }
                return Err(error::ErrorInternalServerError(failure));
            }
            let prepared = transaction
                .query_one(
                    PREPARE_REPOSITORY_ARCHIVE_QUERY,
                    &[
                        &repository_id,
                        &owner.id,
                        &repository.root.id,
                        &snapshot_version,
                    ],
                )
                .await;
            let row = match prepared {
                Ok(row) => row,
                Err(failure)
                    if failure.code()
                        == Some(&tokio_postgres::error::SqlState::T_R_SERIALIZATION_FAILURE) =>
                {
                    return Ok(HttpResponse::Conflict()
                        .body("The repository archive is being prepared. Please retry."));
                }
                Err(failure) => return Err(error::ErrorInternalServerError(failure)),
            };
            let Some(manifest_id) = row.get::<_, Option<String>>("manifest_id") else {
                return Ok(HttpResponse::Conflict()
                    .body("The repository archive is being prepared. Please retry."));
            };
            transaction.execute(
                "UPDATE repository_archive_manifests SET total_entries=$2,total_files=$3,total_bytes=$4,total_encrypted_entries=$5 WHERE id=$1::text::uuid",
                &[&manifest_id,&row.get::<_,i64>("total_entries"),&row.get::<_,i64>("total_files"),&row.get::<_,i64>("total_bytes"),&row.get::<_,i64>("total_encrypted_entries")],
            ).await.map_err(error::ErrorInternalServerError)?;
            Some(row)
        }
    };
    let Some(snapshot) = snapshot else {
        return Ok(HttpResponse::Conflict().body(
            "The repository archive snapshot expired or changed. Please restart the download.",
        ));
    };
    let manifest_id: String = snapshot.get("manifest_id");
    let total_entries: i64 = snapshot.get("total_entries");
    let total_files: i64 = snapshot.get("total_files");
    let total_bytes: i64 = snapshot.get("total_bytes");
    let total_encrypted_entries: i64 = snapshot.get("total_encrypted_entries");
    let ordinal = cursor.as_ref().map_or(0, |cursor| cursor.ordinal);
    if ordinal < 0 || (cursor.is_some() && ordinal >= total_entries) {
        return Err(error::ErrorBadRequest("archive cursor is invalid"));
    }
    let limit = row_limit(REPOSITORY_ARCHIVE_PAGE_SIZE)?;
    let mut rows = transaction
        .query(
            REPOSITORY_ARCHIVE_PAGE_QUERY,
            &[&manifest_id, &ordinal, &limit],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if total_entries < 0
        || total_files < 0
        || total_files > total_entries
        || total_encrypted_entries < 0
        || total_encrypted_entries > total_entries
    {
        return Err(error::ErrorInternalServerError(
            "archive manifest totals are invalid",
        ));
    }
    if total_entries > MAX_REPOSITORY_ARCHIVE_ENTRIES {
        return Ok(HttpResponse::PayloadTooLarge()
            .body("This repository has too many entries to download as one ZIP archive."));
    }
    if total_bytes > MAX_REPOSITORY_ARCHIVE_BYTES {
        return Ok(HttpResponse::PayloadTooLarge()
            .body("This repository is larger than the 2 GB browser ZIP safety limit."));
    }
    let has_more = rows.len() > REPOSITORY_ARCHIVE_PAGE_SIZE;
    rows.truncate(REPOSITORY_ARCHIVE_PAGE_SIZE);
    let next_cursor = if has_more {
        rows.last()
            .map(|row| {
                encode_cursor(&RepositoryArchiveCursor {
                    scope: "repository-archive".to_owned(),
                    repository_id: repository_id.clone(),
                    snapshot_version,
                    manifest_id: manifest_id.clone(),
                    ordinal: row.get("ordinal"),
                })
            })
            .transpose()?
    } else {
        None
    };
    let entries = rows
        .into_iter()
        .map(|row| {
            let content_version = timestamps::cursor(row.get("updated_at"));
            RepositoryArchiveEntry {
                entry: repository_entry_from_row(row),
                content_version,
            }
        })
        .collect();
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    conditional::private_json(
        &request,
        &RepositoryArchiveManifestPageResponse {
            repository,
            entries,
            snapshot_version,
            total_bytes,
            total_entries,
            total_files,
            total_encrypted_entries,
            next_cursor,
            has_more,
        },
    )
}

pub async fn language_stats(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    let owner = require_principal(&state, &request).await?;
    let _interactive_permit = state.acquire_interactive_operation(&owner.id).await?;
    let repository_id = path.into_inner();
    let Some(repository_row) = state
        .db
        .query_opt(REPOSITORY_SUMMARY_QUERY, &[&repository_id, &owner.id])
        .await
        .map_err(crate::db::http_error)?
    else {
        return Ok(HttpResponse::NotFound().finish());
    };
    let repository = repository_summary_from_row(&repository_row);
    // The content version changes with every file and vault-head change in
    // the tree, so a matching validator skips the subtree walk entirely.
    let validator = conditional::PrivateRevision::new(
        &request,
        "repository-language-stats-v1",
        &(&owner.id, &owner.role),
        &(&repository.id, &repository.root.id, repository.tree_version),
    )?;
    if let Some(response) = validator.not_modified(&request) {
        return Ok(response);
    }
    let rows = state
        .db
        .query(
            REPOSITORY_LANGUAGE_STATS_QUERY,
            &[
                &owner.id,
                &repository.root.id,
                &LANGUAGE_IGNORED_DIRECTORIES,
                &LANGUAGE_FILENAMES,
            ],
        )
        .await
        .map_err(crate::db::http_error)?;
    let mut language_groups = Vec::new();
    let mut encrypted_entries = Vec::new();
    for row in rows {
        match row.get::<_, &str>("row_kind") {
            "summary" => {
                if row.get::<_, i64>("total_entries") > MAX_REPOSITORY_ARCHIVE_ENTRIES {
                    return Ok(HttpResponse::PayloadTooLarge()
                        .body("This repository has too many entries to analyze its languages."));
                }
            }
            "group" => language_groups.push(RepositoryLanguageGroup {
                kind: row.get("group_kind"),
                key: row.get("group_key"),
                files: row.get("files"),
                bytes: row.get("bytes"),
            }),
            _ => encrypted_entries.push(RepositoryLanguageEntry {
                id: row.get("id"),
                parent_id: row.get("parent_id"),
                entry_type: row.get("entry_type"),
                name: row.get("original_name"),
                size_bytes: row.get("size_bytes"),
                e2ee_state: row.get("e2ee_state"),
                vault_generation_id: encode_optional_bytes(row.get("vault_generation_id")),
                vault_record_version: row.get("vault_record_version"),
                vault_record_hash: encode_optional_bytes(row.get("vault_record_hash")),
            }),
        }
    }

    validator.json(&RepositoryLanguageStatsResponse {
        repository_id: repository.id,
        content_version: repository.tree_version,
        language_groups,
        encrypted_entries,
    })
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
        .map_err(crate::db::http_error)?;
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
                vault_generation_id: encode_optional_bytes(
                    row.get("breadcrumb_vault_generation_id"),
                ),
                vault_record_version: row.get("breadcrumb_vault_record_version"),
                vault_record_hash: encode_optional_bytes(row.get("breadcrumb_vault_record_hash")),
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
        .map_err(crate::db::http_error)?;
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
            vault_generation_id: encode_optional_bytes(row.get("root_vault_generation_id")),
            vault_record_version: row.get("root_vault_record_version"),
            vault_record_hash: encode_optional_bytes(row.get("root_vault_record_hash")),
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
        vault_generation_id: encode_optional_bytes(row.get("vault_generation_id")),
        vault_record_version: row.get("vault_record_version"),
        vault_record_hash: encode_optional_bytes(row.get("vault_record_hash")),
    }
}

fn encode_optional_bytes(value: Option<Vec<u8>>) -> Option<String> {
    value.map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
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

#[cfg(test)]
mod tests {
    use super::{
        CREATE_EMPTY_REPOSITORY_QUERY, CREATE_REPOSITORY_QUERY, LANGUAGE_FILENAMES,
        LANGUAGE_IGNORED_DIRECTORIES, MAX_REPOSITORY_ARCHIVE_BYTES,
        PREPARE_REPOSITORY_ARCHIVE_QUERY, REPOSITORY_ARCHIVE_PAGE_QUERY,
        REPOSITORY_ARCHIVE_SNAPSHOT_QUERY, REPOSITORY_DETAIL_CONTEXT_QUERY,
        REPOSITORY_LANGUAGE_STATS_QUERY, REPOSITORY_SUMMARY_QUERY, UPDATE_REPOSITORY_QUERY,
        normalize_description, normalize_repository_name,
    };

    #[test]
    fn browser_repository_archive_fallback_is_memory_bounded() {
        assert_eq!(MAX_REPOSITORY_ARCHIVE_BYTES, 2 * 1024 * 1024 * 1024);
        assert!(include_str!("repositories.rs").contains("2 GB browser ZIP safety limit"));
        assert!(PREPARE_REPOSITORY_ARCHIVE_QUERY.contains("current_generation_id"));
        assert!(PREPARE_REPOSITORY_ARCHIVE_QUERY.contains("h.record_hash"));
        assert!(REPOSITORY_ARCHIVE_SNAPSHOT_QUERY.contains("content_version=$4"));
        assert!(REPOSITORY_ARCHIVE_PAGE_QUERY.contains("LIMIT $3"));
        assert!(!REPOSITORY_ARCHIVE_PAGE_QUERY.contains("RECURSIVE"));

        let source = include_str!("repositories.rs");
        let handler = source
            .split_once("pub async fn archive_manifest(")
            .and_then(|(_, tail)| tail.split_once("pub async fn language_stats("))
            .map(|(handler, _)| handler)
            .expect("archive handler should remain inspectable");
        assert!(!handler.contains("walk_subtree("));
        assert!(!handler.contains("Vec::with_capacity"));
    }

    #[test]
    fn language_stats_aggregate_without_materializing_a_manifest() {
        let query = REPOSITORY_LANGUAGE_STATS_QUERY;
        assert!(query.contains("WITH RECURSIVE tree"));
        assert!(query.contains("t.depth < 100"));
        assert!(query.contains("LIMIT 50002"));
        assert!(query.contains("GROUP BY group_kind, group_key"));
        assert!(query.contains("vault_node_heads"));
        assert!(!query.contains("repository_archive_entries"));
        assert!(!query.contains("repository_archive_manifests"));
        assert!(!query.contains("INSERT"));
        assert!(LANGUAGE_IGNORED_DIRECTORIES.contains(&"node_modules"));
        assert!(LANGUAGE_FILENAMES.contains(&"dockerfile"));

        let source = include_str!("repositories.rs");
        let handler = source
            .split_once("pub async fn language_stats(")
            .and_then(|(_, tail)| tail.split_once("async fn get_repository_detail_context("))
            .map(|(handler, _)| handler)
            .expect("language stats handler should remain inspectable");
        let principal = handler
            .find("require_principal")
            .expect("language stats require a session");
        let admission = handler
            .find("acquire_interactive_operation")
            .expect("language stats admission should be present");
        let not_modified = handler
            .find("not_modified")
            .expect("unchanged trees revalidate without a walk");
        let walk = handler
            .find("REPOSITORY_LANGUAGE_STATS_QUERY")
            .expect("language stats query should be present");
        assert!(principal < admission && admission < not_modified && not_modified < walk);
        assert!(handler.contains("MAX_REPOSITORY_ARCHIVE_ENTRIES"));
        assert!(handler.contains("tree_version"));
        assert!(!handler.contains("PREPARE_REPOSITORY_ARCHIVE_QUERY"));
    }

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
        assert!(!detail.contains("refresh_repository_totals"));
        assert!(!detail.contains("folder_is_in_repository("));
        let admission = detail
            .find("acquire_interactive_operation")
            .expect("repository detail admission should be present");
        let recursive_query = detail
            .find("get_repository_detail_context(")
            .expect("repository detail query should be present");
        assert!(admission < recursive_query);
    }

    #[test]
    fn repository_mutations_return_complete_summaries_without_reload_queries() {
        for query in [
            CREATE_REPOSITORY_QUERY,
            CREATE_EMPTY_REPOSITORY_QUERY,
            UPDATE_REPOSITORY_QUERY,
        ] {
            assert!(query.contains("RETURNING *"));
            assert!(query.contains("owner_username"));
            assert!(query.contains("root_vault_record_hash"));
            assert!(query.contains("tree_version"));
        }

        let source = include_str!("repositories.rs");
        let mutations = source
            .split_once("pub async fn create(")
            .and_then(|(_, tail)| tail.split_once("pub async fn detail("))
            .map(|(handlers, _)| handlers)
            .expect("repository mutation handlers should remain inspectable");
        assert!(!mutations.contains("get_repository_summary("));
        assert!(mutations.contains("repository_summary_from_row("));
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
            REPOSITORY_ARCHIVE_PAGE_QUERY,
            PREPARE_REPOSITORY_ARCHIVE_QUERY,
            REPOSITORY_ARCHIVE_SNAPSHOT_QUERY,
            REPOSITORY_LANGUAGE_STATS_QUERY,
            REPOSITORY_DETAIL_CONTEXT_QUERY,
            REPOSITORY_SUMMARY_QUERY,
            CREATE_REPOSITORY_QUERY,
            CREATE_EMPTY_REPOSITORY_QUERY,
            UPDATE_REPOSITORY_QUERY,
            super::REPOSITORY_CHILDREN_QUERY,
        ] {
            client
                .prepare(query)
                .await
                .expect("repository query prepares");
        }
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn database_language_stats_count_fixture_rows() {
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
        let transaction = client.transaction().await.expect("begin fixture");
        let owner: String = transaction
            .query_one(
                "SELECT 'usr_lang_' || replace(gen_random_uuid()::text, '-', '')",
                &[],
            )
            .await
            .expect("fixture owner id")
            .get(0);
        transaction
            .execute(
                "INSERT INTO users(id,username,password_hash,role) VALUES($1,$1,'test-only','user')",
                &[&owner],
            )
            .await
            .expect("insert fixture owner");
        // (id, parent, name, entry type, bytes, e2ee state, state)
        let fixture: &[(&str, &str, &str, &str, i64, &str, &str)] = &[
            ("root", "", "repo", "folder", 0, "legacy", "active"),
            ("src", "root", "src", "folder", 0, "legacy", "active"),
            ("main", "src", "main.ts", "file", 300, "legacy", "active"),
            ("view", "src", "View.TSX", "file", 100, "legacy", "active"),
            (
                "minified",
                "src",
                "util.min.js",
                "file",
                500,
                "legacy",
                "active",
            ),
            ("empty", "src", "empty.rs", "file", 0, "legacy", "active"),
            (
                "docker",
                "root",
                "Dockerfile",
                "file",
                50,
                "legacy",
                "active",
            ),
            (
                "cmake",
                "root",
                "CMakeLists.txt",
                "file",
                40,
                "legacy",
                "active",
            ),
            (
                "readme",
                "root",
                "README.md",
                "file",
                70,
                "legacy",
                "active",
            ),
            (
                "lock",
                "root",
                "package-lock.json",
                "file",
                999,
                "legacy",
                "active",
            ),
            ("license", "root", "LICENSE", "file", 10, "legacy", "active"),
            (
                "trashed",
                "root",
                "trashed.py",
                "file",
                999,
                "legacy",
                "trashed",
            ),
            (
                "modules",
                "root",
                "node_modules",
                "folder",
                0,
                "legacy",
                "active",
            ),
            (
                "vendored", "modules", "lib.js", "file", 1000, "legacy", "active",
            ),
            ("dist", "root", "Dist", "folder", 0, "legacy", "active"),
            ("built", "dist", "out.js", "file", 1000, "legacy", "active"),
            (
                "secret",
                "root",
                "opaque",
                "folder",
                0,
                "encrypted",
                "active",
            ),
            (
                "hidden",
                "secret",
                "opaque",
                "file",
                77,
                "encrypted",
                "active",
            ),
            (
                "visible",
                "secret",
                "legacy.py",
                "file",
                30,
                "legacy",
                "active",
            ),
        ];
        let id = |key: &str| format!("{owner}_{key}");
        for (key, parent, name, entry_type, size_bytes, e2ee_state, file_state) in fixture {
            let parent_id = (!parent.is_empty()).then(|| id(parent));
            transaction
                .execute(
                    "INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id,e2ee_state,state,trashed_at)
                     VALUES($1,$2,$3,$1,$4,$5,$6,$7,$8,CASE WHEN $8='trashed' THEN now() END)",
                    &[&id(key), &owner, name, size_bytes, entry_type, &parent_id, e2ee_state, file_state],
                )
                .await
                .expect("insert fixture file");
        }

        let rows = transaction
            .query(
                REPOSITORY_LANGUAGE_STATS_QUERY,
                &[
                    &owner,
                    &id("root"),
                    &LANGUAGE_IGNORED_DIRECTORIES,
                    &LANGUAGE_FILENAMES,
                ],
            )
            .await
            .expect("language stats query runs");
        let summary = rows
            .iter()
            .find(|row| row.get::<_, &str>("row_kind") == "summary")
            .expect("summary row is always returned");
        // Pruned: node_modules and Dist subtrees. Excluded: the trashed file.
        assert_eq!(summary.get::<_, i64>("total_entries"), 13);
        let groups = rows
            .iter()
            .filter(|row| row.get::<_, &str>("row_kind") == "group")
            .map(|row| {
                (
                    row.get::<_, String>("group_kind"),
                    row.get::<_, String>("group_key"),
                    row.get::<_, i64>("files"),
                    row.get::<_, i64>("bytes"),
                )
            })
            .collect::<Vec<_>>();
        let expected = [
            ("extension", "", 1, 10),
            ("extension", "md", 1, 70),
            ("extension", "ts", 1, 300),
            ("extension", "tsx", 1, 100),
            ("filename", "cmakelists.txt", 1, 40),
            ("filename", "dockerfile", 1, 50),
        ]
        .map(|(kind, key, files, bytes)| (kind.to_owned(), key.to_owned(), files, bytes));
        assert_eq!(groups, expected);
        let nodes = rows
            .iter()
            .filter(|row| row.get::<_, &str>("row_kind") == "node")
            .map(|row| {
                (
                    row.get::<_, String>("id"),
                    row.get::<_, Option<String>>("original_name"),
                    row.get::<_, i64>("size_bytes"),
                )
            })
            .collect::<Vec<_>>();
        let mut expected_nodes = vec![
            (id("hidden"), None, 77),
            (id("visible"), Some("legacy.py".to_owned()), 30),
        ];
        expected_nodes.sort();
        expected_nodes.insert(0, (id("secret"), None, 0));
        assert_eq!(nodes, expected_nodes);
        transaction.rollback().await.expect("discard fixture");
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
