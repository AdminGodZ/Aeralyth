use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use actix_web::http::header::{CACHE_CONTROL, CONTENT_TYPE, LOCATION};
use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use tokio_postgres::{Client, Transaction};

use crate::auth::{AuthUser, SESSION_COOKIE, require_admin, require_csrf};
use crate::state::AppState;

const INVITATION_LIFETIME_DAYS: i64 = 7;
const ADMIN_USER_MUTATION_LOCK_ID: i64 = 4_132_591_101;
const USER_STORAGE_TOMBSTONE_PREFIX: &str = ".deleting-user-";

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

struct StagedUserStorage {
    original_path: PathBuf,
    tombstone_path: PathBuf,
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
    let session_token = get_session_token(&request)?;
    let target_user_id = path.into_inner();
    let Some(role) = normalize_role(&form.role) else {
        return Ok(redirect("/users?user=invalid-role"));
    };

    if target_user_id == current_user.id && role != "admin" {
        return Ok(redirect("/users?user=self-protected"));
    }

    let mut db = crate::db::connect(&state.config.database_url)
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

    let mut db = crate::db::connect(&state.config.database_url)
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

    let mut db = crate::db::connect(&state.config.database_url)
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

    let mut db = crate::db::connect(&state.config.database_url)
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

    let staged_storage = stage_user_storage_for_deletion(
        &state.config.storage_path,
        &target_user.id,
    )?;
    let deleted = match transaction
        .execute("DELETE FROM users WHERE id = $1", &[&target_user.id])
        .await
    {
        Ok(deleted) => deleted,
        Err(database_error) => {
            restore_staged_user_storage(staged_storage.as_ref());
            return Err(error::ErrorInternalServerError(database_error));
        }
    };

    if deleted == 0 {
        restore_staged_user_storage(staged_storage.as_ref());
        return Ok(redirect("/users?user=missing"));
    }

    if let Err(commit_error) = transaction.commit().await {
        reconcile_staged_user_storage(
            &state.db,
            &target_user.id,
            staged_storage.as_ref(),
        )
        .await;
        return Err(error::ErrorInternalServerError(commit_error));
    }

    remove_staged_user_storage(staged_storage.as_ref());
    remove_deleted_user_storage(Path::new(&state.config.storage_path), &target_user.id);

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
                  display_name,
                  role,
                  status,
                  profile_image_bytes IS NOT NULL AS has_profile_image,
                  to_char(
                    COALESCE(profile_image_updated_at, updated_at) AT TIME ZONE 'UTC',
                    'YYYYMMDDHH24MISSUS'
                  ) AS profile_image_version,
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

fn stage_user_storage_for_deletion(
    storage_path: &str,
    user_id: &str,
) -> Result<Option<StagedUserStorage>> {
    let original_path = Path::new(storage_path).join(user_id);
    let metadata = match fs::symlink_metadata(&original_path) {
        Ok(metadata) => metadata,
        Err(storage_error) if storage_error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(storage_error) => return Err(error::ErrorInternalServerError(storage_error)),
    };

    if !metadata.file_type().is_dir() {
        return Err(error::ErrorInternalServerError(
            "user storage path is not a directory",
        ));
    }

    let mut random_bytes = [0_u8; 12];
    getrandom::fill(&mut random_bytes).map_err(error::ErrorInternalServerError)?;
    let encoded_user_id = URL_SAFE_NO_PAD.encode(user_id.as_bytes());
    let random_suffix = URL_SAFE_NO_PAD.encode(random_bytes);
    let tombstone_path = Path::new(storage_path).join(format!(
        "{USER_STORAGE_TOMBSTONE_PREFIX}{encoded_user_id}~{random_suffix}"
    ));

    fs::rename(&original_path, &tombstone_path)
        .map_err(error::ErrorInternalServerError)?;

    Ok(Some(StagedUserStorage {
        original_path,
        tombstone_path,
    }))
}

fn restore_staged_user_storage(staged_storage: Option<&StagedUserStorage>) {
    let Some(staged_storage) = staged_storage else {
        return;
    };

    if !staged_storage.original_path.exists() {
        match fs::rename(
            &staged_storage.tombstone_path,
            &staged_storage.original_path,
        ) {
            Ok(()) => return,
            Err(storage_error) if staged_storage.original_path.exists() => {
                log::info!(
                    "merging concurrently recreated user storage after rename conflict: {}",
                    storage_error
                );
            }
            Err(storage_error) => {
                log::error!(
                    "failed to restore staged user storage {}: {}",
                    staged_storage.tombstone_path.display(),
                    storage_error
                );
                return;
            }
        }
    }

    let entries = match fs::read_dir(&staged_storage.tombstone_path) {
        Ok(entries) => entries,
        Err(storage_error) if storage_error.kind() == ErrorKind::NotFound => return,
        Err(storage_error) => {
            log::error!(
                "failed to read staged user storage {}: {}",
                staged_storage.tombstone_path.display(),
                storage_error
            );
            return;
        }
    };

    for entry_result in entries {
        let Ok(entry) = entry_result else {
            continue;
        };
        let destination = staged_storage.original_path.join(entry.file_name());

        if destination.exists() {
            log::error!(
                "could not restore staged storage entry because the destination exists: {}",
                destination.display()
            );
            continue;
        }

        if let Err(storage_error) = fs::rename(entry.path(), &destination) {
            log::error!(
                "failed to merge staged storage entry into {}: {}",
                destination.display(),
                storage_error
            );
        }
    }

    match fs::remove_dir(&staged_storage.tombstone_path) {
        Ok(()) => {}
        Err(storage_error) if storage_error.kind() == ErrorKind::NotFound => {}
        Err(storage_error) => {
            log::warn!(
                "staged user storage still contains unresolved entries {}: {}",
                staged_storage.tombstone_path.display(),
                storage_error
            );
        }
    }
}

fn remove_staged_user_storage(staged_storage: Option<&StagedUserStorage>) {
    let Some(staged_storage) = staged_storage else {
        return;
    };

    match fs::remove_dir_all(&staged_storage.tombstone_path) {
        Ok(()) => {}
        Err(storage_error) if storage_error.kind() == ErrorKind::NotFound => {}
        Err(storage_error) => {
            log::warn!(
                "deferred cleanup for deleted user storage {}: {}",
                staged_storage.tombstone_path.display(),
                storage_error
            );
        }
    }
}

fn remove_deleted_user_storage(storage_path: &Path, user_id: &str) {
    let storage_directory = storage_path.join(user_id);

    match fs::remove_dir_all(&storage_directory) {
        Ok(()) => {}
        Err(storage_error) if storage_error.kind() == ErrorKind::NotFound => {}
        Err(storage_error) => log::warn!(
            "deferred cleanup for recreated deleted-user storage {}: {}",
            storage_directory.display(),
            storage_error
        ),
    }
}

async fn reconcile_staged_user_storage(
    db: &Client,
    user_id: &str,
    staged_storage: Option<&StagedUserStorage>,
) {
    let Some(staged_storage) = staged_storage else {
        return;
    };
    let user_exists = db
        .query_opt("SELECT 1 FROM users WHERE id = $1 LIMIT 1", &[&user_id])
        .await;

    match user_exists {
        Ok(Some(_)) => restore_staged_user_storage(Some(staged_storage)),
        Ok(None) => {
            remove_staged_user_storage(Some(staged_storage));
            if let Some(storage_path) = staged_storage.original_path.parent() {
                remove_deleted_user_storage(storage_path, user_id);
            }
        }
        Err(database_error) => log::error!(
            "could not reconcile staged storage {} after commit failure: {}",
            staged_storage.tombstone_path.display(),
            database_error
        ),
    }
}

pub(crate) async fn cleanup_pending_user_storage(storage_path: &str, db: &Client) {
    let entries = match fs::read_dir(storage_path) {
        Ok(entries) => entries,
        Err(storage_error) if storage_error.kind() == ErrorKind::NotFound => return,
        Err(storage_error) => {
            log::warn!("could not inspect pending user storage cleanup: {storage_error}");
            return;
        }
    };

    for entry_result in entries {
        let Ok(entry) = entry_result else {
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if !file_type.is_dir() {
            continue;
        }

        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        let Some(encoded_user_id) = file_name
            .strip_prefix(USER_STORAGE_TOMBSTONE_PREFIX)
            .and_then(|value| value.split_once('~').map(|(user_id, _)| user_id))
        else {
            continue;
        };
        let Some(user_id) = URL_SAFE_NO_PAD
            .decode(encoded_user_id)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
        else {
            log::warn!("ignored invalid user storage tombstone {file_name}");
            continue;
        };
        let original_path = Path::new(storage_path).join(&user_id);
        let staged_storage = StagedUserStorage {
            original_path,
            tombstone_path: entry.path(),
        };

        reconcile_staged_user_storage(db, &user_id, Some(&staged_storage)).await;
    }
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
