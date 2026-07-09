use actix_web::http::header::LOCATION;
use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};

use crate::auth::{AuthUser, require_admin, require_csrf};
use crate::state::AppState;

const INVITATION_LIFETIME_DAYS: i64 = 7;

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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminUsersSummary {
    total_users: usize,
    active_users: usize,
    admins: usize,
    pending_invites: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminUser {
    id: String,
    username: String,
    role: String,
    status: String,
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
pub(crate) struct CsrfForm {
    csrf_token: String,
}

struct TargetUser {
    id: String,
    role: String,
    status: String,
}

pub async fn me(state: web::Data<AppState>, request: HttpRequest) -> Result<HttpResponse> {
    let user = require_admin(&state, &request).await?;

    Ok(HttpResponse::Ok().json(AdminSessionResponse { user }))
}

pub async fn users(state: web::Data<AppState>, request: HttpRequest) -> Result<HttpResponse> {
    require_admin(&state, &request).await?;
    expire_old_invitations(&state).await?;

    let users = list_users(&state).await?;
    let invitations = list_invitations(&state).await?;
    let summary = AdminUsersSummary {
        total_users: users.len(),
        active_users: users.iter().filter(|user| user.status == "active").count(),
        admins: users
            .iter()
            .filter(|user| user.role == "admin" && user.status == "active")
            .count(),
        pending_invites: invitations
            .iter()
            .filter(|invitation| invitation.status == "pending")
            .count(),
    };

    Ok(HttpResponse::Ok().json(AdminUsersResponse {
        users,
        invitations,
        summary,
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

    expire_old_invitations(&state).await?;

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

    Ok(redirect(format!(
        "/users?invite=created&token={token}"
    )))
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

    state
        .db
        .execute(
            "
                INSERT INTO users (id, username, password_hash, role, status)
                VALUES (
                  gen_random_uuid()::text,
                  $1,
                  crypt($2, gen_salt('bf')),
                  $3,
                  'active'
                )
            ",
            &[&username, &password, &role],
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
    let target_user_id = path.into_inner();
    let Some(role) = normalize_role(&form.role) else {
        return Ok(redirect("/users?user=invalid-role"));
    };

    if target_user_id == current_user.id && role != "admin" {
        return Ok(redirect("/users?user=self-protected"));
    }

    let Some(target_user) = get_target_user(&state, &target_user_id).await? else {
        return Ok(redirect("/users?user=missing"));
    };

    if target_user.role == "admin"
        && target_user.status == "active"
        && role != "admin"
        && active_admin_count(&state).await? <= 1
    {
        return Ok(redirect("/users?user=last-admin"));
    }

    state
        .db
        .execute(
            "UPDATE users SET role = $1, updated_at = now() WHERE id = $2",
            &[&role, &target_user.id],
        )
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
    let target_user_id = path.into_inner();
    let Some(status) = normalize_status(&form.status) else {
        return Ok(redirect("/users?user=invalid-status"));
    };

    if target_user_id == current_user.id && status == "disabled" {
        return Ok(redirect("/users?user=self-protected"));
    }

    let Some(target_user) = get_target_user(&state, &target_user_id).await? else {
        return Ok(redirect("/users?user=missing"));
    };

    if target_user.role == "admin"
        && target_user.status == "active"
        && status == "disabled"
        && active_admin_count(&state).await? <= 1
    {
        return Ok(redirect("/users?user=last-admin"));
    }

    state
        .db
        .execute(
            "UPDATE users SET status = $1, updated_at = now() WHERE id = $2",
            &[&status, &target_user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(redirect("/users?user=updated"))
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

    Ok(redirect(format!(
        "/users?invite=created&token={token}"
    )))
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

async fn list_users(state: &AppState) -> Result<Vec<AdminUser>> {
    let rows = state
        .db
        .query(
            "
                SELECT
                  id,
                  username,
                  role,
                  status,
                  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at,
                  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS updated_at
                FROM users
                ORDER BY created_at ASC
            ",
            &[],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(rows
        .into_iter()
        .map(|row| AdminUser {
            id: row.get("id"),
            username: row.get("username"),
            role: row.get("role"),
            status: row.get("status"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        })
        .collect())
}

async fn list_invitations(state: &AppState) -> Result<Vec<Invitation>> {
    let rows = state
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
                  to_char(invitations.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at
                FROM invitations
                INNER JOIN users ON users.id = invitations.created_by
                ORDER BY invitations.created_at DESC
            ",
            &[],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(rows
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
        .collect())
}

async fn get_target_user(state: &AppState, user_id: &str) -> Result<Option<TargetUser>> {
    let row = state
        .db
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

async fn active_admin_count(state: &AppState) -> Result<i64> {
    let row = state
        .db
        .query_one(
            "SELECT count(*) FROM users WHERE role = 'admin' AND status = 'active'",
            &[],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(row.get(0))
}

async fn expire_old_invitations(state: &AppState) -> Result<()> {
    state
        .db
        .execute(
            "UPDATE invitations SET status = 'expired' WHERE status = 'pending' AND expires_at <= now()",
            &[],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(())
}

fn normalize_username(username: &str) -> String {
    username.trim().to_lowercase()
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
