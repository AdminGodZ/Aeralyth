use actix_web::http::header::{
    CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, LOCATION,
};
use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tokio::fs::File as AsyncFile;

use crate::auth::{
    parse_json_body, require_header_csrf, require_principal, session_principal, sha256_hex,
};
use crate::routes::local_file_stream::local_file_stream;
use crate::routes::pagination::{decode_cursor, encode_cursor, row_limit};
use crate::routes::tree_jobs::{self, Action, MutationResult};
use crate::state::AppState;
use crate::timestamps;

use super::conditional;

pub(crate) const SHARE_TOKEN_HEADER: &str = "x-aeralyth-share-token";
const MIN_LINK_LIFETIME_SECONDS: i64 = 5 * 60;
const MAX_LINK_LIFETIME_SECONDS: i64 = 365 * 24 * 60 * 60;
const SHARE_LINK_JSON_LIMIT: usize = 16 * 1024;
const OWNED_SHARE_LINK_PAGE_SIZE: usize = 50;
const SHARED_ENTRY_PAGE_SIZE: usize = 500;
const INITIAL_SHARE_TOKEN_VERSION: i64 = 1;
const SHARE_TOKEN_VERSION_LOCK_QUERY: &str = "
    SELECT token_version
    FROM share_links
    WHERE id = $1
      AND owner_id = $2
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
    FOR UPDATE
";
const SHARE_TOKEN_ROTATE_QUERY: &str = "
    UPDATE share_links
    SET token_hash = encode(digest($1::text, 'sha256'), 'hex'),
        token_version = $2,
        updated_at = now()
    WHERE id = $3
      AND owner_id = $4
      AND token_version = $5
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
    RETURNING id
";
const SHARE_ACCESS_CONTEXT_QUERY: &str = r#"
    WITH RECURSIVE share_grant AS MATERIALIZED (
      SELECT
        links.id,
        links.owner_id,
        owners.username AS owner_username,
        links.root_file_id,
        roots.entry_type AS root_entry_type,
        links.access_scope,
        links.permission,
        links.recipient_id,
        links.expires_at,
        roots.original_name AS root_name,
        roots.mime_type AS root_mime_type,
        roots.size_bytes AS root_size_bytes,
        roots.updated_at AS root_updated_at
      FROM share_links AS links
      INNER JOIN users AS owners ON owners.id = links.owner_id
      INNER JOIN visible_files AS roots ON roots.id = links.root_file_id
      WHERE links.token_hash = encode(digest($1::text, 'sha256'), 'hex')
        AND links.revoked_at IS NULL
        AND (links.expires_at IS NULL OR links.expires_at > now())
        AND owners.status = 'active'
        AND roots.state = 'active'
        AND roots.e2ee_state IN ('legacy', 'staged')
      LIMIT 1
    ),
    requested AS MATERIALIZED (
      SELECT
        share_grant.*,
        CASE
          WHEN share_grant.root_entry_type = 'folder'
            THEN COALESCE(NULLIF(btrim($2::text), ''), share_grant.root_file_id)
          ELSE share_grant.root_file_id
        END AS requested_node_id
      FROM share_grant
    ),
    ancestors AS (
      SELECT
        node.id,
        node.parent_id,
        node.original_name,
        requested.root_file_id,
        ARRAY[node.id]::text[] AS visited_ids,
        0::integer AS depth
      FROM requested
      INNER JOIN visible_files AS node ON node.id = requested.requested_node_id
      WHERE node.owner_id = requested.owner_id
        AND node.state = 'active'
        AND (
          (requested.root_entry_type = 'folder' AND node.entry_type = 'folder')
          OR (
            requested.root_entry_type = 'file'
            AND node.id = requested.root_file_id
            AND node.entry_type = 'file'
          )
        )

      UNION ALL

      SELECT
        parent.id,
        parent.parent_id,
        parent.original_name,
        child.root_file_id,
        child.visited_ids || parent.id,
        child.depth + 1
      FROM visible_files AS parent
      INNER JOIN ancestors AS child ON child.parent_id = parent.id
      INNER JOIN requested ON requested.owner_id = parent.owner_id
      WHERE parent.state = 'active'
        AND child.id <> child.root_file_id
        AND child.depth < 100
        AND NOT parent.id = ANY(child.visited_ids)
    )
    SELECT
      requested.id,
      requested.owner_id,
      requested.owner_username,
      requested.root_file_id,
      requested.root_entry_type,
      requested.access_scope,
      requested.permission,
      requested.recipient_id,
      requested.expires_at,
      requested.root_file_id AS root_id,
      requested.root_name,
      requested.root_mime_type,
      requested.root_entry_type AS root_type,
      requested.root_size_bytes,
      requested.root_updated_at,
      requested.requested_node_id,
      EXISTS (
        SELECT 1
        FROM ancestors AS authorization_path
        WHERE authorization_path.id = authorization_path.root_file_id
      ) AS node_authorized,
      ancestors.id AS breadcrumb_id,
      ancestors.original_name AS breadcrumb_name
    FROM requested
    LEFT JOIN ancestors ON TRUE
    ORDER BY ancestors.depth DESC
"#;

const SHARE_DOWNLOAD_CONTEXT_QUERY: &str = r#"
    WITH RECURSIVE share_grant AS MATERIALIZED (
      SELECT
        links.id,
        links.owner_id,
        owners.username AS owner_username,
        links.root_file_id,
        roots.entry_type AS root_entry_type,
        links.access_scope,
        links.permission,
        links.recipient_id,
        links.expires_at
      FROM share_links AS links
      INNER JOIN users AS owners ON owners.id = links.owner_id
      INNER JOIN visible_files AS roots ON roots.id = links.root_file_id
      WHERE links.token_hash = encode(digest($1::text, 'sha256'), 'hex')
        AND links.revoked_at IS NULL
        AND (links.expires_at IS NULL OR links.expires_at > now())
        AND owners.status = 'active'
        AND roots.state = 'active'
        AND roots.e2ee_state IN ('legacy', 'staged')
      LIMIT 1
    ),
    ancestors AS (
      SELECT
        target.id,
        target.parent_id,
        target.original_name,
        target.storage_name,
        target.mime_type,
        share_grant.root_file_id,
        ARRAY[target.id]::text[] AS visited_ids,
        0::integer AS depth
      FROM share_grant
      INNER JOIN visible_files AS target ON target.id = $2
      WHERE target.owner_id = share_grant.owner_id
        AND target.state = 'active'
        AND target.entry_type = 'file'
        AND target.e2ee_state IN ('legacy', 'staged')

      UNION ALL

      SELECT
        parent.id,
        parent.parent_id,
        parent.original_name,
        parent.storage_name,
        parent.mime_type,
        child.root_file_id,
        child.visited_ids || parent.id,
        child.depth + 1
      FROM visible_files AS parent
      INNER JOIN ancestors AS child ON child.parent_id = parent.id
      INNER JOIN share_grant ON share_grant.owner_id = parent.owner_id
      WHERE parent.state = 'active'
        AND child.id <> child.root_file_id
        AND child.depth < 100
        AND NOT parent.id = ANY(child.visited_ids)
    )
    SELECT
      share_grant.id,
      share_grant.owner_id,
      share_grant.owner_username,
      share_grant.root_file_id,
      share_grant.root_entry_type,
      share_grant.access_scope,
      share_grant.permission,
      share_grant.recipient_id,
      share_grant.expires_at,
      EXISTS (
        SELECT 1
        FROM ancestors AS authorization_path
        WHERE authorization_path.id = authorization_path.root_file_id
      ) AS node_authorized,
      target.original_name,
      target.storage_name,
      target.mime_type
    FROM share_grant
    LEFT JOIN ancestors AS target ON target.id = $2 AND target.depth = 0
    LIMIT 1
"#;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateShareLinkRequest {
    file_id: String,
    access_scope: String,
    permission: String,
    recipient_username: Option<String>,
    expires_in_seconds: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnedShareLinksQuery {
    file_id: String,
    cursor: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct ShareAccessQuery {
    folder: Option<String>,
    cursor: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct OwnedShareLinkCursor {
    scope: String,
    file_id: String,
    created_at: String,
    id: String,
}

#[derive(Deserialize, Serialize)]
struct SharedEntryCursor {
    scope: String,
    root_file_id: String,
    folder_id: String,
    rank: i32,
    name: String,
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedShareLinkResponse {
    id: String,
    url_path: String,
    access_scope: String,
    permission: String,
    recipient_username: Option<String>,
    expires_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OwnedShareLinkResponse {
    id: String,
    access_scope: String,
    permission: String,
    recipient_username: Option<String>,
    expires_at: Option<String>,
    created_at: String,
    status: String,
    url_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OwnedShareLinksResponse {
    links: Vec<OwnedShareLinkResponse>,
    next_cursor: Option<String>,
    has_more: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RotatedShareLinkResponse {
    url_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareAccessResponse {
    access_scope: String,
    permission: String,
    expires_at: Option<String>,
    owner_username: String,
    root: SharedEntryResponse,
    current_folder_id: Option<String>,
    breadcrumbs: Vec<SharedBreadcrumbResponse>,
    entries: Vec<SharedEntryResponse>,
    next_cursor: Option<String>,
    has_more: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedEntryResponse {
    id: String,
    name: String,
    mime_type: Option<String>,
    entry_type: String,
    size_bytes: i64,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedBreadcrumbResponse {
    id: String,
    name: String,
}

#[derive(Clone)]
pub(crate) struct EditorShareGrant {
    pub id: String,
    pub owner_id: String,
    pub root_file_id: String,
    pub root_entry_type: String,
}

struct ShareGrant {
    id: String,
    owner_id: String,
    owner_username: String,
    root_file_id: String,
    root_entry_type: String,
    access_scope: String,
    permission: String,
    expires_at: Option<String>,
    recipient_id: Option<String>,
}

struct ShareAccessContext {
    grant: ShareGrant,
    root: SharedEntryResponse,
    current_folder_id: Option<String>,
    breadcrumbs: Vec<SharedBreadcrumbResponse>,
    node_authorized: bool,
}

struct SharedEntryPage {
    entries: Vec<SharedEntryResponse>,
    next_cursor: Option<String>,
    has_more: bool,
}

struct ShareDownloadContext {
    grant: ShareGrant,
    file: Option<DownloadFile>,
    node_authorized: bool,
}

struct DownloadFile {
    owner_id: String,
    original_name: String,
    storage_name: String,
    mime_type: Option<String>,
}

pub async fn create(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Payload,
) -> Result<HttpResponse> {
    let owner = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let body =
        parse_json_body::<CreateShareLinkRequest>(&request, body, SHARE_LINK_JSON_LIMIT).await?;
    let access_scope = validate_access_scope(&body.access_scope)?;
    let permission = validate_permission(&body.permission)?;
    let expires_in_seconds = validate_expiration(body.expires_in_seconds)?;

    let root = state
        .db
        .query_opt(
            "
                SELECT id, e2ee_state
                FROM visible_files AS files
                WHERE id = $1 AND owner_id = $2 AND state = 'active'
                LIMIT 1
            ",
            &[&body.file_id, &owner.id],
        )
        .await
        .map_err(crate::db::http_error)?;
    let Some(root) = root else {
        return Ok(HttpResponse::NotFound().body("item not found"));
    };
    let e2ee_state: String = root.get("e2ee_state");
    if e2ee_state == "encrypted" {
        return Ok(HttpResponse::Conflict().body(
            "encrypted items must use recipient-key sharing; anonymous encrypted links are not available",
        ));
    }

    let (recipient_id, recipient_username) = if access_scope == "account" {
        let username = body
            .recipient_username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| error::ErrorBadRequest("recipient username is required"))?;
        let recipient = state
            .db
            .query_opt(
                "SELECT id, username FROM users WHERE lower(username) = lower($1) AND status = 'active' LIMIT 1",
                &[&username],
            )
            .await
            .map_err(crate::db::http_error)?;
        let Some(recipient) = recipient else {
            return Ok(HttpResponse::NotFound().body("recipient not found"));
        };
        let recipient_id: String = recipient.get("id");
        if recipient_id == owner.id {
            return Err(error::ErrorBadRequest(
                "you cannot share an item with yourself",
            ));
        }
        (
            Some(recipient_id),
            Some(recipient.get::<_, String>("username")),
        )
    } else {
        (None, None)
    };

    let link_id: String = state
        .db
        .query_one("SELECT gen_random_uuid()::text AS id", &[])
        .await
        .map_err(crate::db::http_error)?
        .get("id");
    let token = token_for_link(
        &state.config.share_link_secret,
        &link_id,
        INITIAL_SHARE_TOKEN_VERSION,
    )?;
    let row = state
        .db
        .query_one(
            "
                INSERT INTO share_links (
                  id, token_hash, token_version, owner_id, root_file_id,
                  access_scope, permission, recipient_id, expires_at
                )
                VALUES (
                  $1,
                  encode(digest($2::text, 'sha256'), 'hex'),
                  $3, $4, $5, $6, $7, $8,
                  CASE
                    WHEN $9::bigint IS NULL THEN NULL
                    ELSE now() + ($9::bigint * interval '1 second')
                  END
                )
                RETURNING expires_at
            ",
            &[
                &link_id,
                &token,
                &INITIAL_SHARE_TOKEN_VERSION,
                &owner.id,
                &body.file_id,
                &access_scope,
                &permission,
                &recipient_id,
                &expires_in_seconds,
            ],
        )
        .await
        .map_err(crate::db::http_error)?;

    Ok(HttpResponse::Created()
        .insert_header((CACHE_CONTROL, "private, no-store"))
        .json(CreatedShareLinkResponse {
            id: link_id,
            url_path: format!("/s/{token}"),
            access_scope: access_scope.to_owned(),
            permission: permission.to_owned(),
            recipient_username,
            expires_at: timestamps::optional_api(row.get("expires_at")),
        }))
}

pub async fn list_owned(
    state: web::Data<AppState>,
    request: HttpRequest,
    query: web::Query<OwnedShareLinksQuery>,
) -> Result<HttpResponse> {
    let owner = require_principal(&state, &request).await?;
    let cursor = decode_cursor::<OwnedShareLinkCursor>(query.cursor.as_deref())?;
    if cursor.as_ref().is_some_and(|cursor| {
        cursor.scope != "owned-share-links" || cursor.file_id != query.file_id
    }) {
        return Err(error::ErrorBadRequest(
            "pagination cursor does not match shared item",
        ));
    }
    let cursor_created_at = cursor.as_ref().map(|cursor| cursor.created_at.clone());
    let cursor_id = cursor.as_ref().map(|cursor| cursor.id.clone());
    let limit = row_limit(OWNED_SHARE_LINK_PAGE_SIZE)?;
    let mut rows = state
        .db
        .query(
            "
                SELECT links.id, links.access_scope, links.permission,
                       links.token_hash, links.token_version,
                       recipients.username AS recipient_username,
                       links.expires_at,
                       links.created_at,
                       links.created_at AS cursor_created_at,
                       CASE
                         WHEN links.revoked_at IS NOT NULL THEN 'revoked'
                         WHEN links.expires_at IS NOT NULL AND links.expires_at <= now() THEN 'expired'
                         ELSE 'active'
                       END AS status
                FROM share_links AS links
                LEFT JOIN users AS recipients ON recipients.id = links.recipient_id
                WHERE links.owner_id = $1 AND links.root_file_id = $2
                  AND (
                    $3::text IS NULL
                    OR links.created_at < $3::text::timestamptz
                    OR (links.created_at = $3::text::timestamptz AND links.id < $4)
                  )
                ORDER BY links.created_at DESC, links.id DESC
                LIMIT $5
            ",
            &[
                &owner.id,
                &query.file_id,
                &cursor_created_at,
                &cursor_id,
                &limit,
            ],
        )
        .await
        .map_err(crate::db::http_error)?;
    let has_more = rows.len() > OWNED_SHARE_LINK_PAGE_SIZE;
    rows.truncate(OWNED_SHARE_LINK_PAGE_SIZE);
    let next_cursor = if has_more {
        rows.last()
            .map(|row| {
                encode_cursor(&OwnedShareLinkCursor {
                    scope: "owned-share-links".to_owned(),
                    file_id: query.file_id.clone(),
                    created_at: timestamps::cursor(row.get("cursor_created_at")),
                    id: row.get("id"),
                })
            })
            .transpose()?
    } else {
        None
    };
    let links = rows
        .into_iter()
        .map(|row| {
            let id: String = row.get("id");
            let token_version: i64 = row.get("token_version");
            let token = token_for_link(&state.config.share_link_secret, &id, token_version)?;
            let token_hash: String = row.get("token_hash");
            let url_path = (sha256_hex(&token) == token_hash).then(|| format!("/s/{token}"));
            Ok(OwnedShareLinkResponse {
                id,
                access_scope: row.get("access_scope"),
                permission: row.get("permission"),
                recipient_username: row.get("recipient_username"),
                expires_at: timestamps::optional_api(row.get("expires_at")),
                created_at: timestamps::api(row.get("created_at")),
                status: row.get("status"),
                url_path,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    conditional::private_json(
        &request,
        &OwnedShareLinksResponse {
            links,
            next_cursor,
            has_more,
        },
    )
}

pub async fn rotate(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    let owner = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let link_id = path.into_inner();
    let mut client = state.db.get().await.map_err(crate::db::http_error)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let current = transaction
        .query_opt(SHARE_TOKEN_VERSION_LOCK_QUERY, &[&link_id, &owner.id])
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(current) = current else {
        transaction
            .rollback()
            .await
            .map_err(error::ErrorInternalServerError)?;
        return Ok(HttpResponse::NotFound().body("active share link not found"));
    };
    let current_version: i64 = current.get("token_version");
    let next_version = current_version
        .checked_add(1)
        .ok_or_else(|| error::ErrorInternalServerError("share token version exhausted"))?;
    let token = token_for_link(&state.config.share_link_secret, &link_id, next_version)?;
    let updated = transaction
        .query_opt(
            SHARE_TOKEN_ROTATE_QUERY,
            &[&token, &next_version, &link_id, &owner.id, &current_version],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if updated.is_none() {
        transaction
            .rollback()
            .await
            .map_err(error::ErrorInternalServerError)?;
        return Ok(HttpResponse::NotFound().body("active share link not found"));
    }
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::Ok()
        .insert_header((CACHE_CONTROL, "private, no-store"))
        .json(RotatedShareLinkResponse {
            url_path: format!("/s/{token}"),
        }))
}

// Revoking a link also expires its unfinished uploads, so the storage sweeper aborts
// them and frees the owner's pending slots right away.
const REVOKE_SHARE_LINK_QUERY: &str = "
    WITH revoked AS (
      UPDATE share_links
      SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
      WHERE id = $1 AND owner_id = $2
      RETURNING id
    )
    UPDATE file_uploads
    SET expires_at = LEAST(expires_at, now())
    WHERE share_link_id IN (SELECT id FROM revoked)
      AND owner_id = $2
      AND status IN ('initializing', 'pending')
";

pub async fn revoke(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    let owner = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    state
        .db
        .execute(REVOKE_SHARE_LINK_QUERY, &[&path.into_inner(), &owner.id])
        .await
        .map_err(crate::db::http_error)?;

    Ok(HttpResponse::NoContent()
        .insert_header((CACHE_CONTROL, "private, no-store"))
        .finish())
}

pub async fn access(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    query: web::Query<ShareAccessQuery>,
) -> Result<HttpResponse> {
    let token = path.into_inner();
    validate_token(&token)?;
    let admission_key = sha256_hex(&token);
    let _recursive_permit = state.acquire_interactive_operation(&admission_key).await?;
    let requested_folder_id = query
        .folder
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let context = get_share_access_context(&state, &token, requested_folder_id).await?;
    authorize_share_recipient(&state, &request, &context.grant).await?;
    if !context.node_authorized {
        return Err(error::ErrorNotFound("shared item not found"));
    }
    let cursor = decode_cursor::<SharedEntryCursor>(query.cursor.as_deref())?;
    if cursor.as_ref().is_some_and(|cursor| {
        context.current_folder_id.as_deref() != Some(cursor.folder_id.as_str())
            || cursor.scope != "shared-entries"
            || cursor.root_file_id != context.grant.root_file_id
    }) {
        return Err(error::ErrorBadRequest(
            "pagination cursor does not match shared folder",
        ));
    }

    let entry_page = if let Some(folder_id) = context.current_folder_id.as_deref() {
        list_shared_children(&state, &context.grant, folder_id, cursor.as_ref()).await?
    } else {
        SharedEntryPage {
            entries: Vec::new(),
            next_cursor: None,
            has_more: false,
        }
    };

    conditional::private_json(
        &request,
        &ShareAccessResponse {
            access_scope: context.grant.access_scope,
            permission: context.grant.permission,
            expires_at: context.grant.expires_at,
            owner_username: context.grant.owner_username,
            root: context.root,
            current_folder_id: context.current_folder_id,
            breadcrumbs: context.breadcrumbs,
            entries: entry_page.entries,
            next_cursor: entry_page.next_cursor,
            has_more: entry_page.has_more,
        },
    )
}

pub async fn download(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse> {
    let (token, file_id) = path.into_inner();
    validate_token(&token)?;
    let admission_key = sha256_hex(&token);
    let _recursive_permit = state.acquire_interactive_operation(&admission_key).await?;
    let context = get_share_download_context(&state, &token, &file_id).await?;
    authorize_share_recipient(&state, &request, &context.grant).await?;
    let Some(file) = context.file.filter(|_| context.node_authorized) else {
        return Ok(HttpResponse::NotFound().finish());
    };
    drop(_recursive_permit);
    state.db.release_request_connection().await;

    if let Some(download_url) = state
        .storage_operations
        .run(
            &file.owner_id,
            state
                .storage
                .download_url(&file.storage_name, &file.original_name),
        )
        .await?
        .map_err(error::ErrorBadGateway)?
    {
        return Ok(no_store(&mut HttpResponse::Found())
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
    let body = local_file_stream(stored_file);

    Ok(no_store(&mut HttpResponse::Ok())
        .insert_header((
            CONTENT_TYPE,
            file.mime_type
                .unwrap_or_else(|| "application/octet-stream".to_owned()),
        ))
        .insert_header((
            CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"{}\"",
                file.original_name.replace(['\r', '\n', '"'], "")
            ),
        ))
        .insert_header((CONTENT_LENGTH, size_bytes.to_string()))
        .streaming(body))
}

pub async fn remove_entry(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse> {
    let (token, file_id) = path.into_inner();
    require_matching_mutation_header(&request, &token)?;
    let grant = resolve_grant(&state, &request, &token).await?;
    if grant.permission != "editor" {
        return Err(error::ErrorForbidden("editor permission required"));
    }
    if grant.root_entry_type != "folder" || file_id == grant.root_file_id {
        return Err(error::ErrorBadRequest(
            "the share root cannot be removed through its link",
        ));
    }
    let _recursive_permit = state.acquire_recursive_operation(&grant.owner_id).await?;
    require_shared_node(&state, &grant, &file_id, None).await?;
    match tree_jobs::mutate(
        &state.db,
        &grant.owner_id,
        &file_id,
        Action::Trash,
        Some("active"),
        Some(tree_jobs::EditorAuthorization {
            id: &grant.id,
            token: &token,
            access_scope: &grant.access_scope,
            recipient_id: grant.recipient_id.as_deref(),
        }),
    )
    .await?
    {
        MutationResult::Queued(job_id) => return Ok(tree_jobs::queued_response(job_id, &file_id)),
        MutationResult::Missing => return Ok(HttpResponse::NotFound().finish()),
        MutationResult::Complete => {}
    }

    Ok(HttpResponse::NoContent()
        .insert_header((CACHE_CONTROL, "private, no-store"))
        .finish())
}

pub(crate) async fn editor_grant_from_header(
    state: &AppState,
    request: &HttpRequest,
) -> Result<Option<EditorShareGrant>> {
    let Some(token) = request
        .headers()
        .get(SHARE_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let grant = resolve_grant(state, request, token).await?;
    if grant.permission != "editor" {
        return Err(error::ErrorForbidden("editor permission required"));
    }
    Ok(Some(EditorShareGrant {
        id: grant.id,
        owner_id: grant.owner_id,
        root_file_id: grant.root_file_id,
        root_entry_type: grant.root_entry_type,
    }))
}

pub(crate) async fn editor_parent(
    state: &AppState,
    grant: &EditorShareGrant,
    requested_parent: Option<&str>,
) -> Result<String> {
    if grant.root_entry_type != "folder" {
        return Err(error::ErrorBadRequest(
            "a file share can only replace its shared file",
        ));
    }
    let parent_id = requested_parent
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&grant.root_file_id);
    let pseudo_grant = ShareGrant {
        id: grant.id.clone(),
        owner_id: grant.owner_id.clone(),
        owner_username: String::new(),
        root_file_id: grant.root_file_id.clone(),
        root_entry_type: grant.root_entry_type.clone(),
        access_scope: String::new(),
        permission: "editor".to_owned(),
        expires_at: None,
        recipient_id: None,
    };
    require_shared_node(state, &pseudo_grant, parent_id, Some("folder")).await?;
    Ok(parent_id.to_owned())
}

pub(crate) fn validate_editor_replacement(
    grant: &EditorShareGrant,
    replacement_file_id: Option<&str>,
) -> Result<Option<String>> {
    if grant.root_entry_type == "folder" {
        if replacement_file_id.is_some() {
            return Err(error::ErrorBadRequest(
                "folder editors upload new files instead of replacing the share root",
            ));
        }
        return Ok(None);
    }
    let replacement_file_id = replacement_file_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| error::ErrorBadRequest("replacement file id is required"))?;
    if replacement_file_id != grant.root_file_id {
        return Err(error::ErrorForbidden(
            "an editor link can only replace its shared file",
        ));
    }
    Ok(Some(replacement_file_id.to_owned()))
}

async fn get_share_access_context(
    state: &AppState,
    token: &str,
    requested_folder_id: Option<&str>,
) -> Result<ShareAccessContext> {
    validate_token(token)?;
    let rows = state
        .db
        .query(SHARE_ACCESS_CONTEXT_QUERY, &[&token, &requested_folder_id])
        .await
        .map_err(crate::db::http_error)?;
    let Some(first_row) = rows.first() else {
        return Err(error::ErrorGone(
            "share link expired, revoked, or unavailable",
        ));
    };

    let grant = share_grant_from_row(first_row);
    let node_authorized: bool = first_row.get("node_authorized");
    let is_folder = grant.root_entry_type == "folder";
    let breadcrumbs = if is_folder && node_authorized {
        rows.iter()
            .map(|row| SharedBreadcrumbResponse {
                id: row.get("breadcrumb_id"),
                name: row.get("breadcrumb_name"),
            })
            .collect()
    } else {
        Vec::new()
    };

    Ok(ShareAccessContext {
        root: SharedEntryResponse {
            id: first_row.get("root_id"),
            name: first_row.get("root_name"),
            mime_type: first_row.get("root_mime_type"),
            entry_type: first_row.get("root_type"),
            size_bytes: first_row.get("root_size_bytes"),
            updated_at: timestamps::api(first_row.get("root_updated_at")),
        },
        current_folder_id: is_folder.then(|| first_row.get("requested_node_id")),
        grant,
        breadcrumbs,
        node_authorized,
    })
}

async fn get_share_download_context(
    state: &AppState,
    token: &str,
    file_id: &str,
) -> Result<ShareDownloadContext> {
    validate_token(token)?;
    let row = state
        .db
        .query_opt(SHARE_DOWNLOAD_CONTEXT_QUERY, &[&token, &file_id])
        .await
        .map_err(crate::db::http_error)?;
    let Some(row) = row else {
        return Err(error::ErrorGone(
            "share link expired, revoked, or unavailable",
        ));
    };

    let grant = share_grant_from_row(&row);
    let original_name: Option<String> = row.get("original_name");
    let storage_name: Option<String> = row.get("storage_name");
    let file = original_name
        .zip(storage_name)
        .map(|(original_name, storage_name)| DownloadFile {
            owner_id: grant.owner_id.clone(),
            original_name,
            storage_name,
            mime_type: row.get("mime_type"),
        });

    Ok(ShareDownloadContext {
        grant,
        file,
        node_authorized: row.get("node_authorized"),
    })
}

fn share_grant_from_row(row: &tokio_postgres::Row) -> ShareGrant {
    ShareGrant {
        id: row.get("id"),
        owner_id: row.get("owner_id"),
        owner_username: row.get("owner_username"),
        root_file_id: row.get("root_file_id"),
        root_entry_type: row.get("root_entry_type"),
        access_scope: row.get("access_scope"),
        permission: row.get("permission"),
        expires_at: timestamps::optional_api(row.get("expires_at")),
        recipient_id: row.get("recipient_id"),
    }
}

async fn authorize_share_recipient(
    state: &AppState,
    request: &HttpRequest,
    grant: &ShareGrant,
) -> Result<()> {
    if grant.access_scope != "account" {
        return Ok(());
    }
    let user = session_principal(state, request)
        .await?
        .ok_or_else(|| error::ErrorUnauthorized("sign in to open this share"))?;
    if grant.recipient_id.as_deref() != Some(user.id.as_str()) {
        return Err(error::ErrorForbidden(
            "this share belongs to a different account",
        ));
    }
    Ok(())
}

async fn resolve_grant(state: &AppState, request: &HttpRequest, token: &str) -> Result<ShareGrant> {
    validate_token(token)?;
    let row = state
        .db
        .query_opt(
            "
                SELECT links.id, links.owner_id, owners.username AS owner_username,
                       links.root_file_id, files.entry_type AS root_entry_type,
                       links.access_scope, links.permission, links.recipient_id,
                       links.expires_at
                FROM share_links AS links
                INNER JOIN users AS owners ON owners.id = links.owner_id
                INNER JOIN visible_files AS files ON files.id = links.root_file_id
                WHERE links.token_hash = encode(digest($1::text, 'sha256'), 'hex')
                  AND links.revoked_at IS NULL
                  AND (links.expires_at IS NULL OR links.expires_at > now())
                  AND owners.status = 'active'
                  AND files.state = 'active'
                  AND files.e2ee_state IN ('legacy', 'staged')
                LIMIT 1
            ",
            &[&token],
        )
        .await
        .map_err(crate::db::http_error)?;
    let Some(row) = row else {
        return Err(error::ErrorGone(
            "share link expired, revoked, or unavailable",
        ));
    };
    let grant = share_grant_from_row(&row);
    authorize_share_recipient(state, request, &grant).await?;
    Ok(grant)
}

async fn require_shared_node(
    state: &AppState,
    grant: &ShareGrant,
    node_id: &str,
    entry_type: Option<&str>,
) -> Result<()> {
    let row = state
        .db
        .query_opt(
            "
                WITH RECURSIVE ancestors AS (
                  SELECT id, parent_id, entry_type,
                         ARRAY[id]::text[] AS visited_ids, 0::integer AS depth
                  FROM visible_files AS files
                  WHERE id = $1 AND owner_id = $2 AND state = 'active'
                  UNION ALL
                  SELECT parent.id, parent.parent_id, parent.entry_type,
                         child.visited_ids || parent.id, child.depth + 1
                  FROM visible_files AS parent
                  INNER JOIN ancestors AS child ON child.parent_id = parent.id
                  WHERE parent.owner_id = $2 AND parent.state = 'active'
                    AND child.depth < 100
                    AND NOT parent.id = ANY(child.visited_ids)
                )
                SELECT entry_type
                FROM ancestors
                WHERE id = $1
                  AND EXISTS (SELECT 1 FROM ancestors WHERE id = $3)
                LIMIT 1
            ",
            &[&node_id, &grant.owner_id, &grant.root_file_id],
        )
        .await
        .map_err(crate::db::http_error)?;
    let Some(row) = row else {
        return Err(error::ErrorNotFound("shared item not found"));
    };
    let actual_type: String = row.get("entry_type");
    if entry_type.is_some_and(|expected| expected != actual_type) {
        return Err(error::ErrorNotFound("shared item not found"));
    }
    Ok(())
}

async fn list_shared_children(
    state: &AppState,
    grant: &ShareGrant,
    folder_id: &str,
    cursor: Option<&SharedEntryCursor>,
) -> Result<SharedEntryPage> {
    let cursor_rank = cursor.map(|cursor| cursor.rank);
    let cursor_name = cursor.map(|cursor| cursor.name.clone());
    let cursor_id = cursor.map(|cursor| cursor.id.clone());
    let limit = row_limit(SHARED_ENTRY_PAGE_SIZE)?;
    let mut rows = state
        .db
        .query(
            "
                SELECT id, original_name, mime_type, entry_type, size_bytes,
                       updated_at,
                       CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END AS cursor_rank,
                       lower(original_name) AS cursor_name
                FROM visible_files AS files
                WHERE owner_id = $1 AND parent_id = $2 AND state = 'active'
                  AND e2ee_state IN ('legacy', 'staged')
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
                         lower(original_name), id
                LIMIT $6
            ",
            &[
                &grant.owner_id,
                &folder_id,
                &cursor_rank,
                &cursor_name,
                &cursor_id,
                &limit,
            ],
        )
        .await
        .map_err(crate::db::http_error)?;
    let has_more = rows.len() > SHARED_ENTRY_PAGE_SIZE;
    rows.truncate(SHARED_ENTRY_PAGE_SIZE);
    let next_cursor = if has_more {
        rows.last()
            .map(|row| {
                encode_cursor(&SharedEntryCursor {
                    scope: "shared-entries".to_owned(),
                    root_file_id: grant.root_file_id.clone(),
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
    Ok(SharedEntryPage {
        entries: rows.into_iter().map(shared_entry_from_row).collect(),
        next_cursor,
        has_more,
    })
}

fn shared_entry_from_row(row: tokio_postgres::Row) -> SharedEntryResponse {
    SharedEntryResponse {
        id: row.get("id"),
        name: row.get("original_name"),
        mime_type: row.get("mime_type"),
        entry_type: row.get("entry_type"),
        size_bytes: row.get("size_bytes"),
        updated_at: timestamps::api(row.get("updated_at")),
    }
}

fn require_matching_mutation_header(request: &HttpRequest, token: &str) -> Result<()> {
    let supplied = request
        .headers()
        .get(SHARE_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim);
    if supplied != Some(token) {
        return Err(error::ErrorForbidden("share mutation token is missing"));
    }
    Ok(())
}

fn validate_access_scope(value: &str) -> Result<&'static str> {
    match value.trim() {
        "public" => Ok("public"),
        "account" => Ok("account"),
        _ => Err(error::ErrorBadRequest("invalid share access scope")),
    }
}

fn validate_permission(value: &str) -> Result<&'static str> {
    match value.trim() {
        "viewer" => Ok("viewer"),
        "editor" => Ok("editor"),
        _ => Err(error::ErrorBadRequest("invalid share permission")),
    }
}

fn validate_expiration(value: Option<i64>) -> Result<Option<i64>> {
    if value.is_some_and(|seconds| {
        !(MIN_LINK_LIFETIME_SECONDS..=MAX_LINK_LIFETIME_SECONDS).contains(&seconds)
    }) {
        return Err(error::ErrorBadRequest(
            "share link lifetime must be between five minutes and one year",
        ));
    }
    Ok(value)
}

fn validate_token(token: &str) -> Result<()> {
    if token.len() != 43
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(error::ErrorNotFound("share link not found"));
    }
    Ok(())
}

fn token_for_link(secret: &str, link_id: &str, token_version: i64) -> Result<String> {
    if token_version < 0 {
        return Err(error::ErrorInternalServerError(
            "share token version is invalid",
        ));
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(error::ErrorInternalServerError)?;
    if token_version == 0 {
        // Version zero preserves links created before explicit rotation
        // versions were introduced.
        mac.update(b"aeralyth-share-link-v1\0");
        mac.update(link_id.as_bytes());
    } else {
        mac.update(b"aeralyth-share-link-v2\0");
        mac.update(link_id.as_bytes());
        mac.update(&token_version.to_be_bytes());
    }
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn no_store(builder: &mut actix_web::HttpResponseBuilder) -> &mut actix_web::HttpResponseBuilder {
    builder
        .insert_header((CACHE_CONTROL, "private, no-store"))
        .insert_header(("Referrer-Policy", "no-referrer"))
        .insert_header(("X-Robots-Tag", "noindex, nofollow, noarchive"))
}

#[cfg(test)]
mod tests {
    use super::{
        EditorShareGrant, SHARE_ACCESS_CONTEXT_QUERY, SHARE_DOWNLOAD_CONTEXT_QUERY,
        SHARE_TOKEN_ROTATE_QUERY, SHARE_TOKEN_VERSION_LOCK_QUERY, sha256_hex, token_for_link,
        validate_access_scope, validate_editor_replacement, validate_expiration,
        validate_permission, validate_token,
    };

    #[test]
    fn share_token_hash_uses_one_preallocated_lowercase_hex_buffer() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );

        let source = include_str!("../auth.rs");
        let encoder = source
            .split_once("pub fn sha256_hex(")
            .and_then(|(_, tail)| tail.split_once("#[derive("))
            .map(|(encoder, _)| encoder)
            .expect("share token hex encoder should remain inspectable");
        assert!(encoder.contains("String::with_capacity(digest.len() * 2)"));
        assert!(!encoder.contains("format!"));
    }

    #[test]
    fn browsing_combines_grant_root_and_upward_authorization() {
        assert!(SHARE_ACCESS_CONTEXT_QUERY.contains("WITH RECURSIVE share_grant"));
        assert!(SHARE_ACCESS_CONTEXT_QUERY.contains("requested_node_id"));
        assert!(SHARE_ACCESS_CONTEXT_QUERY.contains("authorization_path.id"));
        assert!(
            SHARE_ACCESS_CONTEXT_QUERY
                .contains("INNER JOIN ancestors AS child ON child.parent_id = parent.id")
        );

        let source = include_str!("share_links.rs");
        let access = source
            .split_once("pub async fn access(")
            .and_then(|(_, tail)| tail.split_once("pub async fn download("))
            .map(|(access, _)| access)
            .expect("share access source should remain inspectable");
        assert_eq!(access.matches("get_share_access_context(").count(), 1);
        assert_eq!(access.matches("list_shared_children(").count(), 1);
        assert!(!access.contains("resolve_grant("));
        assert!(!access.contains("require_shared_node("));
        let admission = access
            .find("acquire_interactive_operation")
            .expect("share access admission should be present");
        let recursive_query = access
            .find("get_share_access_context(")
            .expect("share access query should be present");
        assert!(admission < recursive_query);
    }

    #[test]
    fn download_returns_authorized_file_metadata_from_one_query() {
        assert!(SHARE_DOWNLOAD_CONTEXT_QUERY.contains("target.storage_name"));
        assert!(SHARE_DOWNLOAD_CONTEXT_QUERY.contains("authorization_path.id"));

        let source = include_str!("share_links.rs");
        let download = source
            .split_once("pub async fn download(")
            .and_then(|(_, tail)| tail.split_once("pub async fn remove_entry("))
            .map(|(download, _)| download)
            .expect("share download source should remain inspectable");
        assert_eq!(download.matches("get_share_download_context(").count(), 1);
        assert!(!download.contains("resolve_grant("));
        assert!(!download.contains("require_shared_node("));
        assert!(!download.contains("query_opt("));
        let admission = download
            .find("acquire_interactive_operation")
            .expect("share download admission should be present");
        let recursive_query = download
            .find("get_share_download_context(")
            .expect("share download query should be present");
        assert!(admission < recursive_query);
    }

    #[test]
    fn editor_removal_is_admitted_before_recursive_authorization() {
        let source = include_str!("share_links.rs");
        let remove = source
            .split_once("pub async fn remove_entry(")
            .and_then(|(_, tail)| tail.split_once("pub(crate) async fn editor_grant_from_header("))
            .map(|(remove, _)| remove)
            .expect("share removal source should remain inspectable");

        let admission = remove
            .find("acquire_recursive_operation")
            .expect("share removal admission should be present");
        let recursive_query = remove
            .find("require_shared_node(")
            .expect("share removal authorization should be present");
        assert!(admission < recursive_query);
        assert!(remove.contains("tree_jobs::mutate("));
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
            super::SHARE_ACCESS_CONTEXT_QUERY,
            super::SHARE_DOWNLOAD_CONTEXT_QUERY,
            SHARE_TOKEN_VERSION_LOCK_QUERY,
            SHARE_TOKEN_ROTATE_QUERY,
            super::REVOKE_SHARE_LINK_QUERY,
        ] {
            client.prepare(query).await.expect("share query prepares");
        }
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn database_token_rotation_invalidates_the_old_token() {
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
                   VALUES ('usr_token_rotation', 'token_rotation', 'not-a-login-hash', 'user', 'active');
                 INSERT INTO files (
                   id, owner_id, original_name, storage_name, size_bytes,
                   state, entry_type, e2ee_state
                 ) VALUES (
                   'fil_token_rotation', 'usr_token_rotation', 'rotation.txt',
                   'tests/token-rotation.txt', 1, 'active', 'file', 'legacy'
                 );",
            )
            .await
            .expect("share-link fixtures should insert");

        let secret = "0123456789abcdef0123456789abcdef";
        let legacy_token =
            token_for_link(secret, "link_token_rotation", 0).expect("legacy token should derive");
        let legacy_version: i64 = transaction
            .query_one(
                "INSERT INTO share_links (
                   id, token_hash, owner_id, root_file_id,
                   access_scope, permission
                 ) VALUES (
                   'link_token_rotation', encode(digest($1::text, 'sha256'), 'hex'),
                   'usr_token_rotation', 'fil_token_rotation', 'public', 'viewer'
                 )
                 RETURNING token_version",
                &[&legacy_token],
            )
            .await
            .expect("legacy writer share link should insert without a token version")
            .get("token_version");
        assert_eq!(
            legacy_version, 0,
            "the database default must preserve old-writer token derivation"
        );
        let locked = transaction
            .query_one(
                SHARE_TOKEN_VERSION_LOCK_QUERY,
                &[&"link_token_rotation", &"usr_token_rotation"],
            )
            .await
            .expect("active link should lock");
        let current_version: i64 = locked.get("token_version");
        let next_version = current_version + 1;
        let rotated_token = token_for_link(secret, "link_token_rotation", next_version)
            .expect("rotated token should derive");
        transaction
            .query_one(
                SHARE_TOKEN_ROTATE_QUERY,
                &[
                    &rotated_token,
                    &next_version,
                    &"link_token_rotation",
                    &"usr_token_rotation",
                    &current_version,
                ],
            )
            .await
            .expect("share token should rotate");

        let old_valid: bool = transaction
            .query_one(
                "SELECT EXISTS (
                   SELECT 1 FROM share_links
                   WHERE token_hash = encode(digest($1::text, 'sha256'), 'hex')
                     AND revoked_at IS NULL
                 ) AS valid",
                &[&legacy_token],
            )
            .await
            .expect("old token lookup should execute")
            .get("valid");
        let new_valid: bool = transaction
            .query_one(
                "SELECT EXISTS (
                   SELECT 1 FROM share_links
                   WHERE token_hash = encode(digest($1::text, 'sha256'), 'hex')
                     AND revoked_at IS NULL
                 ) AS valid",
                &[&rotated_token],
            )
            .await
            .expect("new token lookup should execute")
            .get("valid");
        assert_ne!(legacy_token, rotated_token);
        assert!(
            !old_valid,
            "old bearer token must stop authorizing immediately"
        );
        assert!(new_valid, "rotated bearer token must authorize");

        let old_writer_error = transaction
            .execute(
                "UPDATE share_links
                 SET token_hash = encode(digest($1::text, 'sha256'), 'hex'),
                     updated_at = now()
                 WHERE id = 'link_token_rotation'",
                &[&legacy_token],
            )
            .await
            .expect_err("an old writer must not replace a versioned token");
        assert!(
            old_writer_error
                .as_db_error()
                .is_some_and(|error| error.message().contains("legacy share-link rotation")),
            "the rollout guard should reject the legacy update: {old_writer_error}"
        );

        transaction
            .rollback()
            .await
            .expect("share-link fixtures should roll back");
    }

    fn editor_grant(entry_type: &str) -> EditorShareGrant {
        EditorShareGrant {
            id: "link-1".to_owned(),
            owner_id: "owner-1".to_owned(),
            root_file_id: "file-1".to_owned(),
            root_entry_type: entry_type.to_owned(),
        }
    }

    #[test]
    fn generated_tokens_are_versioned_and_have_256_url_safe_bits() {
        let secret = "0123456789abcdef0123456789abcdef";
        let legacy = token_for_link(secret, "link-1", 0).expect("legacy token");
        let first = token_for_link(secret, "link-1", 1).expect("token");
        let repeated = token_for_link(secret, "link-1", 1).expect("token");
        let rotated = token_for_link(secret, "link-1", 2).expect("rotated token");
        let second = token_for_link(secret, "link-2", 1).expect("token");
        assert_eq!(
            legacy, "Lr2WgKghJZk_QU_d7xtxhHzNfD9i9OYvbi8iEKL7Wak",
            "version zero must preserve already-issued links"
        );
        assert_eq!(first.len(), 43);
        assert!(validate_token(&first).is_ok());
        assert_eq!(first, repeated);
        assert_ne!(legacy, first);
        assert_ne!(first, rotated);
        assert_ne!(first, second);
        assert!(token_for_link(secret, "link-1", -1).is_err());
    }

    #[test]
    fn rejects_malformed_tokens() {
        assert!(validate_token("").is_err());
        assert!(validate_token(&"a".repeat(42)).is_err());
        assert!(validate_token(&"a".repeat(44)).is_err());
        assert!(validate_token(&format!("{}!", "a".repeat(42))).is_err());
    }

    #[test]
    fn accepts_only_known_access_and_permission_values() {
        assert_eq!(validate_access_scope(" public ").expect("scope"), "public");
        assert_eq!(validate_access_scope("account").expect("scope"), "account");
        assert!(validate_access_scope("team").is_err());
        assert_eq!(validate_permission("viewer").expect("permission"), "viewer");
        assert_eq!(
            validate_permission(" editor ").expect("permission"),
            "editor"
        );
        assert!(validate_permission("owner").is_err());
    }

    #[test]
    fn accepts_never_or_bounded_expiration() {
        assert_eq!(validate_expiration(None).expect("never"), None);
        assert_eq!(
            validate_expiration(Some(13 * 60 * 60)).expect("custom hours"),
            Some(13 * 60 * 60)
        );
        assert!(validate_expiration(Some(60)).is_err());
        assert!(validate_expiration(Some(366 * 24 * 60 * 60)).is_err());
    }

    #[test]
    fn scopes_replacement_to_the_shared_root_file() {
        let file_grant = editor_grant("file");
        assert_eq!(
            validate_editor_replacement(&file_grant, Some("file-1")).expect("replacement"),
            Some("file-1".to_owned())
        );
        assert!(validate_editor_replacement(&file_grant, Some("file-2")).is_err());
        assert!(validate_editor_replacement(&file_grant, None).is_err());

        let folder_grant = editor_grant("folder");
        assert_eq!(
            validate_editor_replacement(&folder_grant, None).expect("folder upload"),
            None
        );
        assert!(validate_editor_replacement(&folder_grant, Some("file-1")).is_err());
    }
}
