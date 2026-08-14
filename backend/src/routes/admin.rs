use actix_web::http::header::{CACHE_CONTROL, CONTENT_TYPE, LOCATION};
use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use deadpool_postgres::Transaction;
use serde::{Deserialize, Serialize};

use crate::auth::{AuthUser, SESSION_COOKIE, require_admin, require_admin_user, require_csrf};
use crate::state::AppState;

const INVITATION_LIFETIME_DAYS: i64 = 7;
const ADMIN_USER_MUTATION_LOCK_ID: i64 = 4_132_591_101;
const DEFAULT_ADMIN_PAGE_SIZE: usize = 50;
const MAX_ADMIN_PAGE_SIZE: usize = 100;

#[derive(Serialize)]
struct AdminSessionResponse {
    user: AuthUser,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminUsersResponse {
    users: Vec<AdminUser>,
    invitations: Vec<Invitation>,
    summary: AdminUsersSummary,
    users_next_cursor: Option<String>,
    users_has_more: bool,
    invitations_next_cursor: Option<String>,
    invitations_has_more: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminUsersSummary {
    total_users: i64,
    active_users: i64,
    admins: i64,
    pending_invites: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminUser {
    id: String,
    username: String,
    display_name: Option<String>,
    role: String,
    status: String,
    profile_image_url: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Invitation {
    id: String,
    invited_username: String,
    role: String,
    status: String,
    created_by_username: String,
    expires_at: String,
    created_at: String,
}

#[derive(Deserialize)]
pub(crate) struct AdminUsersQuery {
    users_cursor: Option<String>,
    invitations_cursor: Option<String>,
    q: Option<String>,
    limit: Option<usize>,
}

struct AdminPage<T> {
    items: Vec<T>,
    next_cursor: Option<String>,
    has_more: bool,
}

#[derive(Deserialize, Serialize)]
struct AdminCursor {
    kind: String,
    query: Option<String>,
    created_at: String,
    id: String,
}

#[derive(Deserialize)]
pub(crate) struct InvitationForm {
    username: String,
    role: String,
    csrf_token: String,
}

#[derive(Deserialize)]
pub(crate) struct CreateUserForm {
    username: String,
    password: String,
    role: String,
    csrf_token: String,
}

#[derive(Deserialize)]
pub(crate) struct RoleForm {
    role: String,
    csrf_token: String,
}

#[derive(Deserialize)]
pub(crate) struct StatusForm {
    status: String,
    csrf_token: String,
}

#[derive(Deserialize)]
pub(crate) struct UpdateUserForm {
    username: String,
    display_name: String,
    role: String,
    status: String,
    csrf_token: String,
}

#[derive(Deserialize)]
pub(crate) struct CsrfForm {
    csrf_token: String,
}

struct TargetUser {
    id: String,
    role: String,
    status: String,
}

pub async fn me(state: web::Data<AppState>, request: HttpRequest) -> Result<HttpResponse> {
    let user = require_admin_user(&state, &request).await?;

    Ok(HttpResponse::Ok().json(AdminSessionResponse { user }))
}

pub async fn users(
    state: web::Data<AppState>,
    request: HttpRequest,
    query: web::Query<AdminUsersQuery>,
) -> Result<HttpResponse> {
    require_admin(&state, &request).await?;

    let page_size = query
        .limit
        .unwrap_or(DEFAULT_ADMIN_PAGE_SIZE)
        .clamp(1, MAX_ADMIN_PAGE_SIZE);
    let search = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(100).collect::<String>());
    let users = list_users(
        &state,
        query.users_cursor.as_deref(),
        search.as_deref(),
        page_size,
    )
    .await?;
    let invitations = list_invitations(
        &state,
        query.invitations_cursor.as_deref(),
        search.as_deref(),
        page_size,
    )
    .await?;
    let summary_row = state
        .db
        .query_one(
            "
                SELECT total_users, active_users, active_admins, pending_invitations
                FROM admin_directory_counters
                WHERE singleton = TRUE
            ",
            &[],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let summary = AdminUsersSummary {
        total_users: summary_row.get("total_users"),
        active_users: summary_row.get("active_users"),
        admins: summary_row.get("active_admins"),
        pending_invites: summary_row.get("pending_invitations"),
    };

    Ok(HttpResponse::Ok().json(AdminUsersResponse {
        users: users.items,
        invitations: invitations.items,
        summary,
        users_next_cursor: users.next_cursor,
        users_has_more: users.has_more,
        invitations_next_cursor: invitations.next_cursor,
        invitations_has_more: invitations.has_more,
    }))
}

pub async fn create_invitation(
    state: web::Data<AppState>,
    request: HttpRequest,
    form: web::Form<InvitationForm>,
) -> Result<HttpResponse> {
    let current_user = require_admin(&state, &request).await?;
    require_csrf(&state, &request, &form.csrf_token).await?;
    let username = normalize_username(&form.username);
    let role = normalize_role(&form.role);

    if !is_valid_username(&username) {
        return Ok(redirect("/users?invite=invalid-username"));
    }

    let Some(role) = role else {
        return Ok(redirect("/users?invite=invalid-role"));
    };

    let existing_user = state
        .db
        .query_opt(
            "SELECT id FROM users WHERE lower(username) = lower($1) LIMIT 1",
            &[&username],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    if existing_user.is_some() {
        return Ok(redirect("/users?invite=user-exists"));
    }

    expire_invitations_for_username(&state, &username).await?;

    let existing_invite = state
        .db
        .query_opt(
            "
                SELECT id
                FROM invitations
                WHERE lower(invited_username) = lower($1)
                  AND status = 'pending'
                  AND expires_at > now()
                LIMIT 1
            ",
            &[&username],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    if existing_invite.is_some() {
        return Ok(redirect("/users?invite=invite-exists"));
    }

    let token = create_token()?;
    let expires_after_days = INVITATION_LIFETIME_DAYS;

    state
        .db
        .execute(
            "
                INSERT INTO invitations (
                  id,
                  invited_username,
                  role,
                  token_hash,
                  created_by,
                  expires_at
                )
                VALUES (
                  gen_random_uuid()::text,
                  $1,
                  $2,
                  encode(digest($3::text, 'sha256'), 'hex'),
                  $4,
                  now() + ($5::bigint * interval '1 day')
                )
            ",
            &[
                &username,
                &role,
                &token,
                &current_user.id,
                &expires_after_days,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(redirect(format!("/users?invite=created&token={token}")))
}

pub async fn create_user(
    state: web::Data<AppState>,
    request: HttpRequest,
    form: web::Form<CreateUserForm>,
) -> Result<HttpResponse> {
    require_admin(&state, &request).await?;
    require_csrf(&state, &request, &form.csrf_token).await?;
    let username = normalize_username(&form.username);
    let password = form.password.trim();
    let Some(role) = normalize_role(&form.role) else {
        return Ok(redirect("/users?user=invalid-role"));
    };

    if !is_valid_username(&username) {
        return Ok(redirect("/users?user=invalid-username"));
    }

    if password.len() < 8 {
        return Ok(redirect("/users?user=weak-password"));
    }

    let existing_user = state
        .db
        .query_opt(
            "SELECT id FROM users WHERE lower(username) = lower($1) LIMIT 1",
            &[&username],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    if existing_user.is_some() {
        return Ok(redirect("/users?user=user-exists"));
    }

    state.db.release_request_connection().await;
    let password_hash =
        state.passwords.hash(password).await.map_err(|_| {
            error::ErrorServiceUnavailable("password service temporarily unavailable")
        })?;

    state
        .db
        .execute(
            "
                INSERT INTO users (id, username, password_hash, role, status)
                VALUES (
                  gen_random_uuid()::text,
                  $1,
                  $2,
                  $3,
                  'active'
                )
            ",
            &[&username, &password_hash, &role],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    state
        .db
        .execute(
            "
                UPDATE invitations
                SET status = 'accepted',
                    accepted_at = now()
                WHERE lower(invited_username) = lower($1)
                  AND status = 'pending'
            ",
            &[&username],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(redirect("/users?user=created"))
}

pub async fn update_user_role(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    form: web::Form<RoleForm>,
) -> Result<HttpResponse> {
    let current_user = require_admin(&state, &request).await?;
    require_csrf(&state, &request, &form.csrf_token).await?;
    let session_token = get_session_token(&request)?;
    let target_user_id = path.into_inner();
    let Some(role) = normalize_role(&form.role) else {
        return Ok(redirect("/users?user=invalid-role"));
    };

    if target_user_id == current_user.id && role != "admin" {
        return Ok(redirect("/users?user=self-protected"));
    }

    let mut db = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = db
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    lock_admin_user_mutations(&transaction).await?;
    require_transaction_admin_session(
        &transaction,
        &current_user.id,
        &session_token,
        &form.csrf_token,
    )
    .await?;

    let Some(target_user) = get_target_user(&transaction, &target_user_id).await? else {
        return Ok(redirect("/users?user=missing"));
    };

    if target_user.role == "admin"
        && target_user.status == "active"
        && role != "admin"
        && active_admin_count(&transaction).await? <= 1
    {
        return Ok(redirect("/users?user=last-admin"));
    }

    transaction
        .execute(
            "UPDATE users SET role = $1, updated_at = now() WHERE id = $2",
            &[&role, &target_user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(redirect("/users?user=updated"))
}

pub async fn update_user_status(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    form: web::Form<StatusForm>,
) -> Result<HttpResponse> {
    let current_user = require_admin(&state, &request).await?;
    require_csrf(&state, &request, &form.csrf_token).await?;
    let session_token = get_session_token(&request)?;
    let target_user_id = path.into_inner();
    let Some(status) = normalize_status(&form.status) else {
        return Ok(redirect("/users?user=invalid-status"));
    };

    if target_user_id == current_user.id && status == "disabled" {
        return Ok(redirect("/users?user=self-protected"));
    }

    let mut db = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = db
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    lock_admin_user_mutations(&transaction).await?;
    require_transaction_admin_session(
        &transaction,
        &current_user.id,
        &session_token,
        &form.csrf_token,
    )
    .await?;

    let Some(target_user) = get_target_user(&transaction, &target_user_id).await? else {
        return Ok(redirect("/users?user=missing"));
    };

    if target_user.role == "admin"
        && target_user.status == "active"
        && status == "disabled"
        && active_admin_count(&transaction).await? <= 1
    {
        return Ok(redirect("/users?user=last-admin"));
    }

    transaction
        .execute(
            "UPDATE users SET status = $1, updated_at = now() WHERE id = $2",
            &[&status, &target_user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(redirect("/users?user=updated"))
}

pub async fn update_user(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    form: web::Form<UpdateUserForm>,
) -> Result<HttpResponse> {
    let current_user = require_admin(&state, &request).await?;
    require_csrf(&state, &request, &form.csrf_token).await?;
    let session_token = get_session_token(&request)?;
    let target_user_id = path.into_inner();
    let username = normalize_username(&form.username);
    let display_name = normalize_display_name(&form.display_name);
    let Some(role) = normalize_role(&form.role) else {
        return Ok(redirect("/users?user=invalid-role"));
    };
    let Some(status) = normalize_status(&form.status) else {
        return Ok(redirect("/users?user=invalid-status"));
    };

    if !is_valid_username(&username) {
        return Ok(redirect("/users?user=invalid-username"));
    }

    let mut db = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = db
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    lock_admin_user_mutations(&transaction).await?;
    require_transaction_admin_session(
        &transaction,
        &current_user.id,
        &session_token,
        &form.csrf_token,
    )
    .await?;

    let Some(target_user) = get_target_user(&transaction, &target_user_id).await? else {
        return Ok(redirect("/users?user=missing"));
    };

    if target_user.id == current_user.id && (role != "admin" || status != "active") {
        return Ok(redirect("/users?user=self-protected"));
    }

    if target_user.role == "admin"
        && target_user.status == "active"
        && (role != "admin" || status != "active")
        && active_admin_count(&transaction).await? <= 1
    {
        return Ok(redirect("/users?user=last-admin"));
    }

    let username_in_use = transaction
        .query_opt(
            "SELECT id FROM users WHERE lower(username) = lower($1) AND id <> $2 LIMIT 1",
            &[&username, &target_user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    if username_in_use.is_some() {
        return Ok(redirect("/users?user=user-exists"));
    }

    transaction
        .execute(
            "
                UPDATE users
                SET username = $1,
                    display_name = $2,
                    role = $3,
                    status = $4,
                    updated_at = now()
                WHERE id = $5
            ",
            &[&username, &display_name, &role, &status, &target_user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(redirect("/users?user=updated"))
}

pub async fn delete_user(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    form: web::Form<CsrfForm>,
) -> Result<HttpResponse> {
    let current_user = require_admin(&state, &request).await?;
    require_csrf(&state, &request, &form.csrf_token).await?;
    let session_token = get_session_token(&request)?;
    let target_user_id = path.into_inner();

    if target_user_id == current_user.id {
        return Ok(redirect("/users?user=self-protected"));
    }

    let mut db = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = db
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    lock_admin_user_mutations(&transaction).await?;
    require_transaction_admin_session(
        &transaction,
        &current_user.id,
        &session_token,
        &form.csrf_token,
    )
    .await?;

    let Some(target_user) = get_target_user(&transaction, &target_user_id).await? else {
        return Ok(redirect("/users?user=missing"));
    };

    if target_user.role == "admin"
        && target_user.status == "active"
        && active_admin_count(&transaction).await? <= 1
    {
        return Ok(redirect("/users?user=last-admin"));
    }

    transaction
        .execute(
            "
                UPDATE users
                SET status = 'deleting', updated_at = now()
                WHERE id = $1
            ",
            &[&target_user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute(
            "DELETE FROM sessions WHERE user_id = $1",
            &[&target_user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute(
            "
                INSERT INTO user_deletion_jobs (
                  user_id, phase, available_at, locked_until, last_error, updated_at
                ) VALUES ($1, 'file_uploads', now(), NULL, NULL, now())
                ON CONFLICT (user_id) DO UPDATE SET
                  available_at = LEAST(user_deletion_jobs.available_at, now()),
                  updated_at = now()
            ",
            &[&target_user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(redirect("/users?user=deleted"))
}

pub async fn user_avatar(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    require_admin(&state, &request).await?;
    let user_id = path.into_inner();
    let Some(row) = state
        .db
        .query_opt(
            "
                SELECT profile_image_bytes, profile_image_mime_type
                FROM users
                WHERE id = $1
                  AND profile_image_bytes IS NOT NULL
                LIMIT 1
            ",
            &[&user_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?
    else {
        return Ok(HttpResponse::NotFound().finish());
    };

    let bytes: Option<Vec<u8>> = row.get("profile_image_bytes");
    let Some(bytes) = bytes else {
        return Ok(HttpResponse::NotFound().finish());
    };
    let mime_type: Option<String> = row.get("profile_image_mime_type");

    Ok(HttpResponse::Ok()
        .insert_header((
            CONTENT_TYPE,
            mime_type.unwrap_or_else(|| "application/octet-stream".to_owned()),
        ))
        .insert_header((CACHE_CONTROL, "private, no-store"))
        .body(bytes))
}

pub async fn rotate_invitation(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    form: web::Form<CsrfForm>,
) -> Result<HttpResponse> {
    require_admin(&state, &request).await?;
    require_csrf(&state, &request, &form.csrf_token).await?;
    let invitation_id = path.into_inner();
    expire_invitations_for_id(&state, &invitation_id).await?;
    let token = create_token()?;
    let expires_after_days = INVITATION_LIFETIME_DAYS;
    let updated = state
        .db
        .execute(
            "
                UPDATE invitations AS target
                SET token_hash = encode(digest($1::text, 'sha256'), 'hex'),
                    status = 'pending',
                    expires_at = now() + ($2::bigint * interval '1 day'),
                    accepted_at = NULL
                WHERE target.id = $3
                  AND target.status <> 'accepted'
                  AND NOT EXISTS (
                    SELECT 1
                    FROM invitations AS existing
                    WHERE existing.id <> target.id
                      AND lower(existing.invited_username) = lower(target.invited_username)
                      AND existing.status = 'pending'
                      AND existing.expires_at > now()
                  )
            ",
            &[&token, &expires_after_days, &invitation_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    if updated == 0 {
        return Ok(redirect("/users?invite=missing"));
    }

    Ok(redirect(format!("/users?invite=created&token={token}")))
}

pub async fn revoke_invitation(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    form: web::Form<CsrfForm>,
) -> Result<HttpResponse> {
    require_admin(&state, &request).await?;
    require_csrf(&state, &request, &form.csrf_token).await?;
    let invitation_id = path.into_inner();

    state
        .db
        .execute(
            "
                UPDATE invitations
                SET status = 'revoked'
                WHERE id = $1
                  AND status = 'pending'
            ",
            &[&invitation_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(redirect("/users?invite=revoked"))
}

async fn list_users(
    state: &AppState,
    encoded_cursor: Option<&str>,
    search: Option<&str>,
    page_size: usize,
) -> Result<AdminPage<AdminUser>> {
    let cursor = decode_admin_cursor(encoded_cursor, "users", search)?;
    let search_pattern = search.map(|value| format!("%{value}%"));
    let cursor_date = cursor.as_ref().map(|value| value.created_at.clone());
    let cursor_id = cursor.as_ref().map(|value| value.id.clone());
    let row_limit = i64::try_from(page_size + 1)
        .map_err(|_| error::ErrorInternalServerError("invalid admin page size"))?;
    let mut rows = state
        .db
        .query(
            "
                SELECT
                  id,
                  username,
                  display_name,
                  role,
                  status,
                  profile_image_bytes IS NOT NULL AS has_profile_image,
                  to_char(
                    COALESCE(profile_image_updated_at, updated_at) AT TIME ZONE 'UTC',
                    'YYYYMMDDHH24MISSUS'
                  ) AS profile_image_version,
                  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at,
                  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS updated_at,
                  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cursor_created_at
                FROM users
                WHERE status <> 'deleting'
                  AND (
                  $1::text IS NULL
                  OR username ILIKE $1
                  OR COALESCE(display_name, '') ILIKE $1
                  OR role ILIKE $1
                  OR status ILIKE $1
                )
                  AND (
                    $2::text IS NULL
                    OR created_at > $2::text::timestamptz
                    OR (created_at = $2::text::timestamptz AND id > $3)
                  )
                ORDER BY created_at ASC, id ASC
                LIMIT $4
            ",
            &[&search_pattern, &cursor_date, &cursor_id, &row_limit],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let has_more = rows.len() > page_size;
    rows.truncate(page_size);
    let next_cursor = if has_more {
        rows.last()
            .map(|row| {
                encode_admin_cursor(&AdminCursor {
                    kind: "users".to_owned(),
                    query: search.map(str::to_owned),
                    created_at: row.get("cursor_created_at"),
                    id: row.get("id"),
                })
            })
            .transpose()?
    } else {
        None
    };

    let items = rows
        .into_iter()
        .map(|row| {
            let id: String = row.get("id");
            let has_profile_image: bool = row.get("has_profile_image");
            let profile_image_version: Option<String> = row.get("profile_image_version");
            let profile_image_url = has_profile_image.then(|| {
                let version = profile_image_version
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "1".to_owned());

                format!("/api/admin/users/{id}/avatar?v={version}")
            });

            AdminUser {
                id,
                username: row.get("username"),
                display_name: row.get("display_name"),
                role: row.get("role"),
                status: row.get("status"),
                profile_image_url,
                created_at: row.get("created_at"),
                updated_at: row.get("updated_at"),
            }
        })
        .collect();

    Ok(AdminPage {
        items,
        next_cursor,
        has_more,
    })
}

async fn list_invitations(
    state: &AppState,
    encoded_cursor: Option<&str>,
    search: Option<&str>,
    page_size: usize,
) -> Result<AdminPage<Invitation>> {
    let cursor = decode_admin_cursor(encoded_cursor, "invitations", search)?;
    let search_pattern = search.map(|value| format!("%{value}%"));
    let cursor_date = cursor.as_ref().map(|value| value.created_at.clone());
    let cursor_id = cursor.as_ref().map(|value| value.id.clone());
    let row_limit = i64::try_from(page_size + 1)
        .map_err(|_| error::ErrorInternalServerError("invalid admin page size"))?;
    let mut rows = state
        .db
        .query(
            "
                SELECT
                  invitations.id,
                  invitations.invited_username,
                  invitations.role,
                  invitations.status,
                  users.username AS created_by_username,
                  to_char(invitations.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS expires_at,
                  to_char(invitations.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at,
                  to_char(invitations.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cursor_created_at
                FROM invitations
                INNER JOIN users ON users.id = invitations.created_by
                WHERE (
                  $1::text IS NULL
                  OR invitations.invited_username ILIKE $1
                  OR invitations.role ILIKE $1
                  OR invitations.status ILIKE $1
                  OR users.username ILIKE $1
                )
                  AND (
                    $2::text IS NULL
                    OR invitations.created_at < $2::text::timestamptz
                    OR (
                      invitations.created_at = $2::text::timestamptz
                      AND invitations.id < $3
                    )
                  )
                ORDER BY invitations.created_at DESC, invitations.id DESC
                LIMIT $4
            ",
            &[&search_pattern, &cursor_date, &cursor_id, &row_limit],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let has_more = rows.len() > page_size;
    rows.truncate(page_size);
    let next_cursor = if has_more {
        rows.last()
            .map(|row| {
                encode_admin_cursor(&AdminCursor {
                    kind: "invitations".to_owned(),
                    query: search.map(str::to_owned),
                    created_at: row.get("cursor_created_at"),
                    id: row.get("id"),
                })
            })
            .transpose()?
    } else {
        None
    };

    let items = rows
        .into_iter()
        .map(|row| Invitation {
            id: row.get("id"),
            invited_username: row.get("invited_username"),
            role: row.get("role"),
            status: row.get("status"),
            created_by_username: row.get("created_by_username"),
            expires_at: row.get("expires_at"),
            created_at: row.get("created_at"),
        })
        .collect();

    Ok(AdminPage {
        items,
        next_cursor,
        has_more,
    })
}

fn decode_admin_cursor(
    encoded: Option<&str>,
    expected_kind: &str,
    search: Option<&str>,
) -> Result<Option<AdminCursor>> {
    let Some(encoded) = encoded else {
        return Ok(None);
    };

    if encoded.len() > 1024 {
        return Err(error::ErrorBadRequest("invalid admin cursor"));
    }

    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| error::ErrorBadRequest("invalid admin cursor"))?;
    let cursor = serde_json::from_slice::<AdminCursor>(&bytes)
        .map_err(|_| error::ErrorBadRequest("invalid admin cursor"))?;

    if cursor.kind != expected_kind || cursor.query.as_deref() != search {
        return Err(error::ErrorBadRequest(
            "admin cursor does not match this list",
        ));
    }

    Ok(Some(cursor))
}

fn encode_admin_cursor(cursor: &AdminCursor) -> Result<String> {
    let bytes = serde_json::to_vec(cursor).map_err(error::ErrorInternalServerError)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

async fn lock_admin_user_mutations(transaction: &Transaction<'_>) -> Result<()> {
    transaction
        .query_one(
            "SELECT pg_advisory_xact_lock($1)",
            &[&ADMIN_USER_MUTATION_LOCK_ID],
        )
        .await
        .map(|_| ())
        .map_err(error::ErrorInternalServerError)
}

async fn require_transaction_admin_session(
    transaction: &Transaction<'_>,
    user_id: &str,
    session_token: &str,
    csrf_token: &str,
) -> Result<()> {
    let active_admin_session = transaction
        .query_opt(
            "
                SELECT sessions.id
                FROM sessions
                INNER JOIN users ON users.id = sessions.user_id
                WHERE sessions.token_hash = encode(digest($1::text, 'sha256'), 'hex')
                  AND sessions.csrf_token = $2
                  AND sessions.expires_at > now()
                  AND users.id = $3
                  AND users.role = 'admin'
                  AND users.status = 'active'
                LIMIT 1
                FOR SHARE OF sessions
            ",
            &[&session_token, &csrf_token.trim(), &user_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    if active_admin_session.is_none() {
        return Err(error::ErrorForbidden("admin access required"));
    }

    Ok(())
}

fn get_session_token(request: &HttpRequest) -> Result<String> {
    request
        .cookie(SESSION_COOKIE)
        .map(|cookie| cookie.value().to_owned())
        .ok_or_else(|| error::ErrorUnauthorized("authentication required"))
}

async fn get_target_user(
    transaction: &Transaction<'_>,
    user_id: &str,
) -> Result<Option<TargetUser>> {
    let row = transaction
        .query_opt(
            "SELECT id, role, status FROM users WHERE id = $1 LIMIT 1",
            &[&user_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(row.map(|row| TargetUser {
        id: row.get("id"),
        role: row.get("role"),
        status: row.get("status"),
    }))
}

async fn active_admin_count(transaction: &Transaction<'_>) -> Result<i64> {
    let row = transaction
        .query_one(
            "SELECT count(*) FROM users WHERE role = 'admin' AND status = 'active'",
            &[],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(row.get(0))
}

async fn expire_invitations_for_username(state: &AppState, username: &str) -> Result<()> {
    state
        .db
        .execute(
            "
                UPDATE invitations
                SET status = 'expired'
                WHERE lower(invited_username) = lower($1)
                  AND status = 'pending'
                  AND expires_at <= now()
            ",
            &[&username],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(())
}

async fn expire_invitations_for_id(state: &AppState, invitation_id: &str) -> Result<()> {
    state
        .db
        .execute(
            "
                UPDATE invitations
                SET status = 'expired'
                WHERE status = 'pending'
                  AND expires_at <= now()
                  AND lower(invited_username) = (
                    SELECT lower(invited_username)
                    FROM invitations
                    WHERE id = $1
                  )
            ",
            &[&invitation_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(())
}

fn normalize_username(username: &str) -> String {
    username.trim().to_lowercase()
}

fn normalize_display_name(display_name: &str) -> Option<String> {
    let display_name = display_name
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>();
    let display_name = display_name.trim();

    if display_name.is_empty() {
        return None;
    }

    Some(display_name.chars().take(80).collect())
}

fn is_valid_username(username: &str) -> bool {
    let len = username.len();

    (3..=32).contains(&len)
        && username.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
}

fn normalize_role(role: &str) -> Option<String> {
    match role {
        "admin" => Some("admin".to_owned()),
        "user" => Some("user".to_owned()),
        _ => None,
    }
}

fn normalize_status(status: &str) -> Option<String> {
    match status {
        "active" => Some("active".to_owned()),
        "disabled" => Some("disabled".to_owned()),
        _ => None,
    }
}

fn create_token() -> Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(error::ErrorInternalServerError)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn redirect(location: impl AsRef<str>) -> HttpResponse {
    HttpResponse::SeeOther()
        .insert_header((LOCATION, location.as_ref().to_owned()))
        .finish()
}
