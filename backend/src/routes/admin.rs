use actix_web::http::header::LOCATION;
use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};

use crate::auth::{AuthUser, require_admin, require_admin_user, require_csrf};
use crate::state::AppState;
use crate::timestamps;

use super::avatar;

const INVITATION_LIFETIME_DAYS: i64 = 7;
const ADMIN_USER_MUTATION_LOCK_ID: i64 = 4_132_591_101;
const DEFAULT_ADMIN_PAGE_SIZE: usize = 50;
const MAX_ADMIN_PAGE_SIZE: usize = 100;
const CREATE_INVITATION_QUERY: &str = r#"
    WITH decision AS MATERIALIZED (
      SELECT EXISTS (
               SELECT 1
               FROM users
               WHERE lower(username) = lower($1)
             ) AS user_exists
    ), inserted AS (
      INSERT INTO invitations (
        id, invited_username, role, token_hash, created_by, expires_at
      )
      SELECT gen_random_uuid()::text,
             $1,
             $2,
             encode(digest($3::text, 'sha256'), 'hex'),
             $4,
             now() + ($5::bigint * interval '1 day')
      FROM decision
      WHERE NOT decision.user_exists
      ON CONFLICT (lower(invited_username)) WHERE status = 'pending'
      DO UPDATE SET
        invited_username = EXCLUDED.invited_username,
        role = EXCLUDED.role,
        token_hash = EXCLUDED.token_hash,
        created_by = EXCLUDED.created_by,
        expires_at = EXCLUDED.expires_at,
        accepted_at = NULL,
        created_at = now()
      WHERE invitations.expires_at <= now()
      RETURNING id
    )
    SELECT decision.user_exists,
           NOT decision.user_exists
             AND NOT EXISTS (SELECT 1 FROM inserted) AS invitation_exists,
           EXISTS (SELECT 1 FROM inserted) AS inserted
    FROM decision
"#;
const CREATE_USER_QUERY: &str = r#"
    WITH inserted AS (
      INSERT INTO users (id, username, password_hash, role, status)
      VALUES (gen_random_uuid()::text, $1, $2, $3, 'active')
      ON CONFLICT DO NOTHING
      RETURNING username
    ), accepted_invitations AS (
      UPDATE invitations
      SET status = 'accepted', accepted_at = now()
      WHERE lower(invited_username) = lower($1)
        AND status = 'pending'
        AND EXISTS (SELECT 1 FROM inserted)
      RETURNING id
    )
    SELECT EXISTS (SELECT 1 FROM inserted) AS inserted,
           (SELECT count(*) FROM accepted_invitations) AS accepted_invitations
"#;
const UPDATE_USER_ROLE_QUERY: &str = "
    WITH mutation_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock($1)
    ), authorized AS MATERIALIZED (
      SELECT sessions.id
      FROM mutation_lock
      CROSS JOIN sessions
      INNER JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = $2
        AND sessions.csrf_token = $3
        AND sessions.expires_at > now()
        AND users.id = $4
        AND users.role = 'admin'
        AND users.status = 'active'
      LIMIT 1
      FOR SHARE OF sessions
    ), target AS MATERIALIZED (
      SELECT users.id, users.role, users.status
      FROM users
      WHERE users.id = $5
        AND EXISTS (SELECT 1 FROM authorized)
      FOR UPDATE
    ), decision AS MATERIALIZED (
      SELECT target.*,
             target.role = 'admin'
             AND target.status = 'active'
             AND $6::text <> 'admin'
             AND (
               SELECT count(*) FROM users
               WHERE role = 'admin' AND status = 'active'
             ) <= 1 AS last_admin_blocked
      FROM target
    ), updated AS (
      UPDATE users
      SET role = $6, updated_at = now()
      FROM decision
      WHERE users.id = decision.id
        AND NOT decision.last_admin_blocked
      RETURNING users.id
    )
    SELECT EXISTS (SELECT 1 FROM authorized) AS authorized,
           EXISTS (SELECT 1 FROM target) AS target_exists,
           COALESCE((SELECT last_admin_blocked FROM decision), FALSE)
             AS last_admin_blocked,
           EXISTS (SELECT 1 FROM updated) AS updated
";
const UPDATE_USER_STATUS_QUERY: &str = "
    WITH mutation_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock($1)
    ), authorized AS MATERIALIZED (
      SELECT sessions.id
      FROM mutation_lock
      CROSS JOIN sessions
      INNER JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = $2
        AND sessions.csrf_token = $3
        AND sessions.expires_at > now()
        AND users.id = $4
        AND users.role = 'admin'
        AND users.status = 'active'
      LIMIT 1
      FOR SHARE OF sessions
    ), target AS MATERIALIZED (
      SELECT users.id, users.role, users.status
      FROM users
      WHERE users.id = $5
        AND EXISTS (SELECT 1 FROM authorized)
      FOR UPDATE
    ), decision AS MATERIALIZED (
      SELECT target.*,
             target.role = 'admin'
             AND target.status = 'active'
             AND $6::text = 'disabled'
             AND (
               SELECT count(*) FROM users
               WHERE role = 'admin' AND status = 'active'
             ) <= 1 AS last_admin_blocked
      FROM target
    ), updated AS (
      UPDATE users
      SET status = $6, updated_at = now()
      FROM decision
      WHERE users.id = decision.id
        AND NOT decision.last_admin_blocked
      RETURNING users.id
    )
    SELECT EXISTS (SELECT 1 FROM authorized) AS authorized,
           EXISTS (SELECT 1 FROM target) AS target_exists,
           COALESCE((SELECT last_admin_blocked FROM decision), FALSE)
             AS last_admin_blocked,
           EXISTS (SELECT 1 FROM updated) AS updated
";
const UPDATE_USER_QUERY: &str = "
    WITH mutation_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock($1)
    ), authorized AS MATERIALIZED (
      SELECT sessions.id
      FROM mutation_lock
      CROSS JOIN sessions
      INNER JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = $2
        AND sessions.csrf_token = $3
        AND sessions.expires_at > now()
        AND users.id = $4
        AND users.role = 'admin'
        AND users.status = 'active'
      LIMIT 1
      FOR SHARE OF sessions
    ), target AS MATERIALIZED (
      SELECT users.id, users.role, users.status
      FROM users
      WHERE users.id = $5
        AND EXISTS (SELECT 1 FROM authorized)
      FOR UPDATE
    ), decision AS MATERIALIZED (
      SELECT target.*,
             target.role = 'admin'
             AND target.status = 'active'
             AND ($8::text <> 'admin' OR $9::text <> 'active')
             AND (
               SELECT count(*) FROM users
               WHERE role = 'admin' AND status = 'active'
             ) <= 1 AS last_admin_blocked,
             EXISTS (
               SELECT 1 FROM users AS existing
               WHERE lower(existing.username) = lower($6)
                 AND existing.id <> target.id
             ) AS username_in_use
      FROM target
    ), updated AS (
      UPDATE users
      SET username = $6,
          display_name = $7,
          role = $8,
          status = $9,
          updated_at = now()
      FROM decision
      WHERE users.id = decision.id
        AND NOT decision.last_admin_blocked
        AND NOT decision.username_in_use
      RETURNING users.id
    )
    SELECT EXISTS (SELECT 1 FROM authorized) AS authorized,
           EXISTS (SELECT 1 FROM target) AS target_exists,
           COALESCE((SELECT last_admin_blocked FROM decision), FALSE)
             AS last_admin_blocked,
           COALESCE((SELECT username_in_use FROM decision), FALSE)
             AS username_in_use,
           EXISTS (SELECT 1 FROM updated) AS updated
";
const DELETE_USER_QUERY: &str = "
    WITH mutation_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock($1)
    ), authorized AS MATERIALIZED (
      SELECT sessions.id
      FROM mutation_lock
      CROSS JOIN sessions
      INNER JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = $2
        AND sessions.csrf_token = $3
        AND sessions.expires_at > now()
        AND users.id = $4
        AND users.role = 'admin'
        AND users.status = 'active'
      LIMIT 1
      FOR SHARE OF sessions
    ), target AS MATERIALIZED (
      SELECT users.id, users.role, users.status
      FROM users
      WHERE users.id = $5
        AND EXISTS (SELECT 1 FROM authorized)
      FOR UPDATE
    ), decision AS MATERIALIZED (
      SELECT target.*,
             target.role = 'admin'
             AND target.status = 'active'
             AND (
               SELECT count(*) FROM users
               WHERE role = 'admin' AND status = 'active'
             ) <= 1 AS last_admin_blocked
      FROM target
    ), updated AS (
      UPDATE users
      SET status = 'deleting', updated_at = now()
      FROM decision
      WHERE users.id = decision.id
        AND NOT decision.last_admin_blocked
      RETURNING users.id
    ), deleted_sessions AS (
      DELETE FROM sessions
      WHERE user_id IN (SELECT id FROM updated)
      RETURNING user_id
    ), queued AS (
      INSERT INTO user_deletion_jobs (
        user_id, phase, available_at, locked_until, last_error, updated_at
      )
      SELECT id, 'file_uploads', now(), NULL, NULL, now()
      FROM updated
      ON CONFLICT (user_id) DO UPDATE SET
        available_at = LEAST(user_deletion_jobs.available_at, now()),
        updated_at = now()
      RETURNING user_id
    )
    SELECT EXISTS (SELECT 1 FROM authorized) AS authorized,
           EXISTS (SELECT 1 FROM target) AS target_exists,
           COALESCE((SELECT last_admin_blocked FROM decision), FALSE)
             AS last_admin_blocked,
           EXISTS (SELECT 1 FROM updated) AS updated,
           (SELECT count(*) FROM deleted_sessions) AS deleted_sessions,
           EXISTS (SELECT 1 FROM queued) AS queued
";

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

struct AdminMutationOutcome {
    authorized: bool,
    target_exists: bool,
    last_admin_blocked: bool,
    username_in_use: bool,
    updated: bool,
    queued: bool,
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
    // All three reads share the request-scoped client and can be pipelined by
    // tokio-postgres instead of paying three serial network round trips.
    let (users, invitations, summary) = futures_util::try_join!(
        list_users(
            &state,
            query.users_cursor.as_deref(),
            search.as_deref(),
            page_size,
        ),
        list_invitations(
            &state,
            query.invitations_cursor.as_deref(),
            search.as_deref(),
            page_size,
        ),
        load_admin_summary(&state),
    )?;

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

    let token = create_token()?;
    let expires_after_days = INVITATION_LIFETIME_DAYS;
    let outcome = state
        .db
        .query_one(
            CREATE_INVITATION_QUERY,
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
    if outcome.get("user_exists") {
        return Ok(redirect("/users?invite=user-exists"));
    }
    if !outcome.get::<_, bool>("inserted") {
        return Ok(redirect("/users?invite=invite-exists"));
    }

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

    state.db.release_request_connection().await;
    let password_hash =
        state.passwords.hash(password).await.map_err(|_| {
            error::ErrorServiceUnavailable("password service temporarily unavailable")
        })?;

    let outcome = state
        .db
        .query_one(CREATE_USER_QUERY, &[&username, &password_hash, &role])
        .await
        .map_err(error::ErrorInternalServerError)?;
    if !outcome.get::<_, bool>("inserted") {
        return Ok(redirect("/users?user=user-exists"));
    }

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
    let target_user_id = path.into_inner();
    let Some(role) = normalize_role(&form.role) else {
        return Ok(redirect("/users?user=invalid-role"));
    };

    if target_user_id == current_user.id && role != "admin" {
        return Ok(redirect("/users?user=self-protected"));
    }

    let outcome = state
        .db
        .query_one(
            UPDATE_USER_ROLE_QUERY,
            &[
                &ADMIN_USER_MUTATION_LOCK_ID,
                &current_user.session_id,
                &form.csrf_token.trim(),
                &current_user.id,
                &target_user_id,
                &role,
            ],
        )
        .await
        .map(admin_mutation_outcome)
        .map_err(error::ErrorInternalServerError)?;
    if let Some(response) = admin_mutation_failure(&outcome)? {
        return Ok(response);
    }
    if !outcome.updated {
        return Err(error::ErrorInternalServerError(
            "admin role was not updated",
        ));
    }
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
    let target_user_id = path.into_inner();
    let Some(status) = normalize_status(&form.status) else {
        return Ok(redirect("/users?user=invalid-status"));
    };

    if target_user_id == current_user.id && status == "disabled" {
        return Ok(redirect("/users?user=self-protected"));
    }

    let outcome = state
        .db
        .query_one(
            UPDATE_USER_STATUS_QUERY,
            &[
                &ADMIN_USER_MUTATION_LOCK_ID,
                &current_user.session_id,
                &form.csrf_token.trim(),
                &current_user.id,
                &target_user_id,
                &status,
            ],
        )
        .await
        .map(admin_mutation_outcome)
        .map_err(error::ErrorInternalServerError)?;
    if let Some(response) = admin_mutation_failure(&outcome)? {
        return Ok(response);
    }
    if !outcome.updated {
        return Err(error::ErrorInternalServerError(
            "admin status was not updated",
        ));
    }
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

    if target_user_id == current_user.id && (role != "admin" || status != "active") {
        return Ok(redirect("/users?user=self-protected"));
    }

    let outcome = state
        .db
        .query_one(
            UPDATE_USER_QUERY,
            &[
                &ADMIN_USER_MUTATION_LOCK_ID,
                &current_user.session_id,
                &form.csrf_token.trim(),
                &current_user.id,
                &target_user_id,
                &username,
                &display_name,
                &role,
                &status,
            ],
        )
        .await
        .map(admin_mutation_outcome)
        .map_err(error::ErrorInternalServerError)?;
    if let Some(response) = admin_mutation_failure(&outcome)? {
        return Ok(response);
    }
    if outcome.username_in_use {
        return Ok(redirect("/users?user=user-exists"));
    }
    if !outcome.updated {
        return Err(error::ErrorInternalServerError(
            "admin user was not updated",
        ));
    }
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
    let target_user_id = path.into_inner();

    if target_user_id == current_user.id {
        return Ok(redirect("/users?user=self-protected"));
    }

    let row = state
        .db
        .query_one(
            DELETE_USER_QUERY,
            &[
                &ADMIN_USER_MUTATION_LOCK_ID,
                &current_user.session_id,
                &form.csrf_token.trim(),
                &current_user.id,
                &target_user_id,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let outcome = admin_mutation_outcome(row);
    if let Some(response) = admin_mutation_failure(&outcome)? {
        return Ok(response);
    }
    if !outcome.updated || !outcome.queued {
        return Err(error::ErrorInternalServerError(
            "user deletion job was not queued",
        ));
    }

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
                SELECT profile_image_bytes, profile_image_mime_type,
                       COALESCE(profile_image_updated_at, updated_at)
                         AS profile_image_version_at
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
    let version = timestamps::version_micros(row.get("profile_image_version_at"));

    Ok(avatar::response(
        &request,
        bytes,
        mime_type.unwrap_or_else(|| "application/octet-stream".to_owned()),
        &version,
    ))
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
    let search_pattern = search.map(literal_ilike_pattern);
    let normalized_search = search.map(str::to_ascii_lowercase);
    let exact_role = normalized_search
        .as_deref()
        .filter(|value| matches!(*value, "admin" | "user"));
    let exact_status = normalized_search
        .as_deref()
        .filter(|value| matches!(*value, "active" | "disabled"));
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
                  COALESCE(profile_image_updated_at, updated_at)
                    AS profile_image_version_at,
                  created_at,
                  updated_at,
                  created_at AS cursor_created_at
                FROM users
                WHERE status <> 'deleting'
                  AND (
                  $1::text IS NULL
                  OR username ILIKE $1 ESCAPE '\\'
                  OR COALESCE(display_name, '') ILIKE $1 ESCAPE '\\'
                  OR role = $5
                  OR status = $6
                )
                  AND (
                    $2::text IS NULL
                    OR created_at > $2::text::timestamptz
                    OR (created_at = $2::text::timestamptz AND id > $3)
                  )
                ORDER BY created_at ASC, id ASC
                LIMIT $4
            ",
            &[
                &search_pattern,
                &cursor_date,
                &cursor_id,
                &row_limit,
                &exact_role,
                &exact_status,
            ],
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
                    created_at: timestamps::cursor(row.get("cursor_created_at")),
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
            let profile_image_version =
                timestamps::version_micros(row.get("profile_image_version_at"));
            let profile_image_url = has_profile_image
                .then(|| format!("/api/admin/users/{id}/avatar?v={profile_image_version}"));

            AdminUser {
                id,
                username: row.get("username"),
                display_name: row.get("display_name"),
                role: row.get("role"),
                status: row.get("status"),
                profile_image_url,
                created_at: timestamps::api(row.get("created_at")),
                updated_at: timestamps::api(row.get("updated_at")),
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
    let search_pattern = search.map(literal_ilike_pattern);
    let normalized_search = search.map(str::to_ascii_lowercase);
    let exact_role = normalized_search
        .as_deref()
        .filter(|value| matches!(*value, "admin" | "user"));
    let exact_status = normalized_search
        .as_deref()
        .filter(|value| matches!(*value, "pending" | "accepted" | "revoked" | "expired"));
    let cursor_date = cursor.as_ref().map(|value| value.created_at.clone());
    let cursor_id = cursor.as_ref().map(|value| value.id.clone());
    let row_limit = i64::try_from(page_size + 1)
        .map_err(|_| error::ErrorInternalServerError("invalid admin page size"))?;
    let mut rows = if search_pattern.is_some() {
        state
            .db
            .query(
                "
                    WITH candidate_ids AS MATERIALIZED (
                      (
                        SELECT invitations.id, invitations.created_at
                        FROM invitations
                        WHERE invitations.invited_username ILIKE $1 ESCAPE '\\'
                          AND (
                            $2::text IS NULL
                            OR invitations.created_at < $2::text::timestamptz
                            OR (invitations.created_at = $2::text::timestamptz AND invitations.id < $3)
                          )
                        ORDER BY invitations.created_at DESC, invitations.id DESC
                        LIMIT $4
                      )
                      UNION
                      (
                        SELECT invitations.id, invitations.created_at
                        FROM users
                        INNER JOIN invitations ON invitations.created_by = users.id
                        WHERE users.status <> 'deleting'
                          AND users.username ILIKE $1 ESCAPE '\\'
                          AND (
                            $2::text IS NULL
                            OR invitations.created_at < $2::text::timestamptz
                            OR (invitations.created_at = $2::text::timestamptz AND invitations.id < $3)
                          )
                        ORDER BY invitations.created_at DESC, invitations.id DESC
                        LIMIT $4
                      )
                      UNION
                      (
                        SELECT invitations.id, invitations.created_at
                        FROM invitations
                        WHERE invitations.role = $5
                          AND (
                            $2::text IS NULL
                            OR invitations.created_at < $2::text::timestamptz
                            OR (invitations.created_at = $2::text::timestamptz AND invitations.id < $3)
                          )
                        ORDER BY invitations.created_at DESC, invitations.id DESC
                        LIMIT $4
                      )
                      UNION
                      (
                        SELECT invitations.id, invitations.created_at
                        FROM invitations
                        WHERE invitations.status = $6
                          AND (
                            $2::text IS NULL
                            OR invitations.created_at < $2::text::timestamptz
                            OR (invitations.created_at = $2::text::timestamptz AND invitations.id < $3)
                          )
                        ORDER BY invitations.created_at DESC, invitations.id DESC
                        LIMIT $4
                      )
                    )
                    SELECT
                      invitations.id,
                      invitations.invited_username,
                      invitations.role,
                      invitations.status,
                      users.username AS created_by_username,
                      invitations.expires_at,
                      invitations.created_at,
                      invitations.created_at AS cursor_created_at
                    FROM candidate_ids
                    INNER JOIN invitations ON invitations.id = candidate_ids.id
                    INNER JOIN users ON users.id = invitations.created_by
                    ORDER BY candidate_ids.created_at DESC, candidate_ids.id DESC
                    LIMIT $4
                ",
                &[
                    &search_pattern,
                    &cursor_date,
                    &cursor_id,
                    &row_limit,
                    &exact_role,
                    &exact_status,
                ],
            )
            .await
    } else {
        state
            .db
            .query(
                "
                    SELECT
                      invitations.id,
                      invitations.invited_username,
                      invitations.role,
                      invitations.status,
                      users.username AS created_by_username,
                      invitations.expires_at,
                      invitations.created_at,
                      invitations.created_at AS cursor_created_at
                    FROM invitations
                    INNER JOIN users ON users.id = invitations.created_by
                    WHERE (
                      $1::text IS NULL
                      OR invitations.created_at < $1::text::timestamptz
                      OR (invitations.created_at = $1::text::timestamptz AND invitations.id < $2)
                    )
                    ORDER BY invitations.created_at DESC, invitations.id DESC
                    LIMIT $3
                ",
                &[&cursor_date, &cursor_id, &row_limit],
            )
            .await
    }
    .map_err(error::ErrorInternalServerError)?;
    let has_more = rows.len() > page_size;
    rows.truncate(page_size);
    let next_cursor = if has_more {
        rows.last()
            .map(|row| {
                encode_admin_cursor(&AdminCursor {
                    kind: "invitations".to_owned(),
                    query: search.map(str::to_owned),
                    created_at: timestamps::cursor(row.get("cursor_created_at")),
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
            expires_at: timestamps::api(row.get("expires_at")),
            created_at: timestamps::api(row.get("created_at")),
        })
        .collect();

    Ok(AdminPage {
        items,
        next_cursor,
        has_more,
    })
}

async fn load_admin_summary(state: &AppState) -> Result<AdminUsersSummary> {
    let row = state
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

    Ok(AdminUsersSummary {
        total_users: row.get("total_users"),
        active_users: row.get("active_users"),
        admins: row.get("active_admins"),
        pending_invites: row.get("pending_invitations"),
    })
}

fn literal_ilike_pattern(value: &str) -> String {
    let mut pattern = String::with_capacity(value.len() + 2);
    pattern.push('%');
    for character in value.chars() {
        if matches!(character, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push('%');
    pattern
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

fn admin_mutation_outcome(row: tokio_postgres::Row) -> AdminMutationOutcome {
    AdminMutationOutcome {
        authorized: row.get("authorized"),
        target_exists: row.get("target_exists"),
        last_admin_blocked: row.get("last_admin_blocked"),
        username_in_use: row.try_get("username_in_use").unwrap_or(false),
        updated: row.get("updated"),
        queued: row.try_get("queued").unwrap_or(false),
    }
}

fn admin_mutation_failure(outcome: &AdminMutationOutcome) -> Result<Option<HttpResponse>> {
    if !outcome.authorized {
        return Err(error::ErrorForbidden("admin access required"));
    }
    if !outcome.target_exists {
        return Ok(Some(redirect("/users?user=missing")));
    }
    if outcome.last_admin_blocked {
        return Ok(Some(redirect("/users?user=last-admin")));
    }

    Ok(None)
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

#[cfg(test)]
mod tests {
    use super::{
        ADMIN_USER_MUTATION_LOCK_ID, CREATE_INVITATION_QUERY, CREATE_USER_QUERY, DELETE_USER_QUERY,
        INVITATION_LIFETIME_DAYS, UPDATE_USER_QUERY, UPDATE_USER_ROLE_QUERY,
        UPDATE_USER_STATUS_QUERY, admin_mutation_outcome, literal_ilike_pattern,
    };

    #[test]
    fn admin_search_treats_wildcards_as_literal_text() {
        assert_eq!(literal_ilike_pattern(r"a%b_c\d"), r"%a\%b\_c\\d%");
    }

    #[test]
    fn directory_reads_remain_concurrent_and_exact_filters_are_normalized() {
        let source = include_str!("admin.rs");
        let handler = source
            .split_once("pub async fn users(")
            .and_then(|(_, tail)| tail.split_once("pub async fn create_invitation("))
            .map(|(handler, _)| handler)
            .expect("admin directory handler should remain inspectable");
        assert!(handler.contains("futures_util::try_join!("));
        assert!(handler.contains("load_admin_summary(&state)"));
        assert!(!source.contains(&("role ".to_owned() + "ILIKE")));
        assert!(!source.contains(&("status ".to_owned() + "ILIKE")));
        assert!(source.contains("OR role = $5"));
        assert!(source.contains("OR invitations.status = $6"));
    }

    #[test]
    fn admin_mutations_keep_invariants_in_one_statement_each() {
        for query in [
            UPDATE_USER_ROLE_QUERY,
            UPDATE_USER_STATUS_QUERY,
            UPDATE_USER_QUERY,
            DELETE_USER_QUERY,
        ] {
            assert!(query.contains("pg_advisory_xact_lock"));
            assert!(query.contains("authorized AS MATERIALIZED"));
            assert!(query.contains("target AS MATERIALIZED"));
            assert_eq!(query.matches("UPDATE users").count(), 1);
            assert!(query.contains("RETURNING users.id"));
        }

        assert!(UPDATE_USER_QUERY.contains("username_in_use"));
        assert!(DELETE_USER_QUERY.contains("DELETE FROM sessions"));
        assert!(DELETE_USER_QUERY.contains("INSERT INTO user_deletion_jobs"));

        let source = include_str!("admin.rs");
        for (start, end) in [
            (
                "pub async fn update_user_role(",
                "pub async fn update_user_status(",
            ),
            (
                "pub async fn update_user_status(",
                "pub async fn update_user(",
            ),
            ("pub async fn update_user(", "pub async fn delete_user("),
            ("pub async fn delete_user(", "pub async fn user_avatar("),
        ] {
            let handler = source
                .split_once(start)
                .and_then(|(_, tail)| tail.split_once(end))
                .map(|(handler, _)| handler)
                .expect("admin mutation handler should remain inspectable");
            assert_eq!(handler.matches(".query_one(").count(), 1);
            assert!(!handler.contains(".transaction()"));
            assert!(!handler.contains(".commit()"));
            assert!(!handler.contains("get_target_user"));
            assert!(!handler.contains("active_admin_count"));
        }
    }

    #[test]
    fn admin_creation_paths_are_one_atomic_statement_after_validation() {
        assert!(CREATE_INVITATION_QUERY.contains("WITH decision AS"));
        assert!(
            CREATE_INVITATION_QUERY
                .contains("ON CONFLICT (lower(invited_username)) WHERE status = 'pending'")
        );
        assert!(CREATE_INVITATION_QUERY.contains("DO UPDATE SET"));
        assert!(CREATE_INVITATION_QUERY.contains("WHERE invitations.expires_at <= now()"));
        assert!(CREATE_INVITATION_QUERY.contains("user_exists"));
        assert!(CREATE_INVITATION_QUERY.contains("invitation_exists"));
        assert!(CREATE_USER_QUERY.contains("WITH inserted AS"));
        assert!(CREATE_USER_QUERY.contains("ON CONFLICT DO NOTHING"));
        assert!(CREATE_USER_QUERY.contains("accepted_invitations"));

        let source = include_str!("admin.rs");
        for (start, end, query_name) in [
            (
                "pub async fn create_invitation(",
                "pub async fn create_user(",
                "CREATE_INVITATION_QUERY",
            ),
            (
                "pub async fn create_user(",
                "pub async fn update_user_role(",
                "CREATE_USER_QUERY",
            ),
        ] {
            let handler = source
                .split_once(start)
                .and_then(|(_, tail)| tail.split_once(end))
                .map(|(handler, _)| handler)
                .expect("admin creation handler should remain inspectable");
            assert_eq!(handler.matches(".query_one(").count(), 1);
            assert!(handler.contains(query_name));
            assert!(!handler.contains(".query_opt("));
            assert!(!handler.contains(".execute("));
        }
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
            CREATE_INVITATION_QUERY,
            CREATE_USER_QUERY,
            UPDATE_USER_ROLE_QUERY,
            UPDATE_USER_STATUS_QUERY,
            UPDATE_USER_QUERY,
            DELETE_USER_QUERY,
        ] {
            client
                .prepare(query)
                .await
                .expect("admin mutation query should prepare");
        }
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn concurrent_duplicate_creation_has_one_deterministic_winner() {
        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
        let (client_a, connection_a) =
            tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
                .await
                .expect("connect first PostgreSQL client");
        let (client_b, connection_b) =
            tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
                .await
                .expect("connect second PostgreSQL client");
        actix_web::rt::spawn(async move {
            connection_a.await.expect("first connection stays healthy");
        });
        actix_web::rt::spawn(async move {
            connection_b.await.expect("second connection stays healthy");
        });

        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock is after the Unix epoch")
            .as_nanos();
        let admin_id = format!("usr_perf_create_admin_{suffix}");
        let admin_username = format!("perf_create_admin_{suffix}");
        let invitation_username = format!("perf_invite_{suffix}");
        let user_username = format!("perf_user_{suffix}");
        client_a
            .execute(
                "INSERT INTO users (id, username, password_hash, role, status)
                 VALUES ($1, $2, 'not-a-login-hash', 'admin', 'active')",
                &[&admin_id, &admin_username],
            )
            .await
            .expect("admin fixture inserts");

        let role = "user";
        let lifetime_days = INVITATION_LIFETIME_DAYS;
        let token_a = format!("invite-a-{suffix}");
        let token_b = format!("invite-b-{suffix}");
        let invite_params_a: [&(dyn tokio_postgres::types::ToSql + Sync); 5] = [
            &invitation_username,
            &role,
            &token_a,
            &admin_id,
            &lifetime_days,
        ];
        let invite_params_b: [&(dyn tokio_postgres::types::ToSql + Sync); 5] = [
            &invitation_username,
            &role,
            &token_b,
            &admin_id,
            &lifetime_days,
        ];
        let (invite_a, invite_b) = futures_util::try_join!(
            client_a.query_one(CREATE_INVITATION_QUERY, &invite_params_a),
            client_b.query_one(CREATE_INVITATION_QUERY, &invite_params_b),
        )
        .expect("concurrent invitation statements complete");
        let invite_rows = [invite_a, invite_b];
        assert_eq!(
            invite_rows
                .iter()
                .filter(|row| row.get::<_, bool>("inserted"))
                .count(),
            1
        );
        assert!(invite_rows.iter().all(|row| {
            row.get::<_, bool>("inserted") || row.get::<_, bool>("invitation_exists")
        }));
        let pending_invitations: i64 = client_a
            .query_one(
                "SELECT count(*) FROM invitations
                 WHERE lower(invited_username) = lower($1)
                   AND status = 'pending'",
                &[&invitation_username],
            )
            .await
            .expect("pending invitation count loads")
            .get(0);
        assert_eq!(pending_invitations, 1);

        let setup_token = format!("user-invite-{suffix}");
        let setup_invitation = client_a
            .query_one(
                CREATE_INVITATION_QUERY,
                &[
                    &user_username,
                    &role,
                    &setup_token,
                    &admin_id,
                    &lifetime_days,
                ],
            )
            .await
            .expect("user invitation fixture inserts");
        assert!(setup_invitation.get::<_, bool>("inserted"));

        let user_params_a: [&(dyn tokio_postgres::types::ToSql + Sync); 3] =
            [&user_username, &"hash-a", &role];
        let user_params_b: [&(dyn tokio_postgres::types::ToSql + Sync); 3] =
            [&user_username, &"hash-b", &role];
        let (user_a, user_b) = futures_util::try_join!(
            client_a.query_one(CREATE_USER_QUERY, &user_params_a),
            client_b.query_one(CREATE_USER_QUERY, &user_params_b),
        )
        .expect("concurrent user statements complete");
        assert_eq!(
            [user_a, user_b]
                .iter()
                .filter(|row| row.get::<_, bool>("inserted"))
                .count(),
            1
        );
        let accepted_invitations: i64 = client_a
            .query_one(
                "SELECT count(*) FROM invitations
                 WHERE lower(invited_username) = lower($1)
                   AND status = 'accepted'",
                &[&user_username],
            )
            .await
            .expect("accepted invitation count loads")
            .get(0);
        assert_eq!(accepted_invitations, 1);

        client_a
            .execute(
                "DELETE FROM invitations WHERE created_by = $1",
                &[&admin_id],
            )
            .await
            .expect("invitation fixtures clean up");
        client_a
            .execute(
                "DELETE FROM users WHERE lower(username) = lower($1)",
                &[&user_username],
            )
            .await
            .expect("user fixture cleans up");
        client_a
            .execute("DELETE FROM users WHERE id = $1", &[&admin_id])
            .await
            .expect("admin fixture cleans up");
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
                     ('usr_perf_admin', 'perf_admin', 'not-a-login-hash', 'admin', 'active'),
                     ('usr_perf_target', 'perf_target', 'not-a-login-hash', 'user', 'active');
                 INSERT INTO sessions (
                   id, user_id, token_hash, csrf_token, expires_at
                 ) VALUES (
                   'ses_perf_admin', 'usr_perf_admin',
                   decode(repeat('a1', 32), 'hex'), 'csrf-perf-admin', now() + interval '1 hour'
                 );",
            )
            .await
            .expect("admin mutation fixtures should insert");

        let role = transaction
            .query_one(
                UPDATE_USER_ROLE_QUERY,
                &[
                    &ADMIN_USER_MUTATION_LOCK_ID,
                    &"ses_perf_admin",
                    &"csrf-perf-admin",
                    &"usr_perf_admin",
                    &"usr_perf_target",
                    &"admin",
                ],
            )
            .await
            .map(admin_mutation_outcome)
            .expect("one-statement role update should execute");
        assert!(role.authorized && role.target_exists && role.updated);
        assert!(!role.last_admin_blocked);

        let status = transaction
            .query_one(
                UPDATE_USER_STATUS_QUERY,
                &[
                    &ADMIN_USER_MUTATION_LOCK_ID,
                    &"ses_perf_admin",
                    &"csrf-perf-admin",
                    &"usr_perf_admin",
                    &"usr_perf_target",
                    &"disabled",
                ],
            )
            .await
            .map(admin_mutation_outcome)
            .expect("one-statement status update should execute");
        assert!(status.authorized && status.target_exists && status.updated);

        let display_name = Some("Updated Target");
        let update = transaction
            .query_one(
                UPDATE_USER_QUERY,
                &[
                    &ADMIN_USER_MUTATION_LOCK_ID,
                    &"ses_perf_admin",
                    &"csrf-perf-admin",
                    &"usr_perf_admin",
                    &"usr_perf_target",
                    &"perf_target_updated",
                    &display_name,
                    &"user",
                    &"active",
                ],
            )
            .await
            .map(admin_mutation_outcome)
            .expect("one-statement full update should execute");
        assert!(update.authorized && update.target_exists && update.updated);
        assert!(!update.username_in_use);

        let deletion = transaction
            .query_one(
                DELETE_USER_QUERY,
                &[
                    &ADMIN_USER_MUTATION_LOCK_ID,
                    &"ses_perf_admin",
                    &"csrf-perf-admin",
                    &"usr_perf_admin",
                    &"usr_perf_target",
                ],
            )
            .await
            .map(admin_mutation_outcome)
            .expect("one-statement deletion handoff should execute");
        assert!(deletion.authorized && deletion.target_exists && deletion.updated);
        assert!(deletion.queued);
        transaction
            .rollback()
            .await
            .expect("admin mutation fixtures should roll back");
    }
}
