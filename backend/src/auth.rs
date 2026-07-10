use actix_web::{HttpRequest, Result, error};
use serde::Serialize;

use crate::state::AppState;

pub const SESSION_COOKIE: &str = "aeralyth_session";
pub const CSRF_FIELD: &str = "csrf_token";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub username: String,
    pub role: String,
    pub status: String,
    pub display_name: Option<String>,
    pub theme_preference: String,
    pub accent_color: String,
    pub folder_zip_prompt_enabled: bool,
    pub profile_image_url: Option<String>,
}

impl AuthUser {
    pub fn is_admin(&self) -> bool {
        self.role == "admin"
    }
}

pub async fn authenticate_password(
    state: &AppState,
    username: &str,
    password: &str,
) -> Result<Option<AuthUser>> {
    let user = state
        .db
        .query_opt(
            "
                SELECT
                  id,
                  username,
                  role,
                  status,
                  display_name,
                  COALESCE(theme_preference, 'system') AS theme_preference,
                  COALESCE(accent_color, '#3088f0') AS accent_color,
                  COALESCE(folder_zip_prompt_enabled, TRUE) AS folder_zip_prompt_enabled,
                  profile_image_bytes IS NOT NULL AS has_profile_image,
                  to_char(
                    COALESCE(profile_image_updated_at, updated_at) AT TIME ZONE 'UTC',
                    'YYYYMMDDHH24MISSMS'
                  ) AS profile_image_version
                FROM users
                WHERE username = $1
                  AND status = 'active'
                  AND password_hash = crypt($2, password_hash)
                LIMIT 1
            ",
            &[&username, &password],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(user.map(auth_user_from_row))
}

pub async fn current_user(state: &AppState, request: &HttpRequest) -> Result<Option<AuthUser>> {
    let Some(cookie) = request.cookie(SESSION_COOKIE) else {
        return Ok(None);
    };

    let user = state
        .db
        .query_opt(
            "
                SELECT
                  users.id,
                  users.username,
                  users.role,
                  users.status,
                  users.display_name,
                  COALESCE(users.theme_preference, 'system') AS theme_preference,
                  COALESCE(users.accent_color, '#3088f0') AS accent_color,
                  COALESCE(users.folder_zip_prompt_enabled, TRUE) AS folder_zip_prompt_enabled,
                  users.profile_image_bytes IS NOT NULL AS has_profile_image,
                  to_char(
                    COALESCE(users.profile_image_updated_at, users.updated_at) AT TIME ZONE 'UTC',
                    'YYYYMMDDHH24MISSMS'
                  ) AS profile_image_version
                FROM sessions
                INNER JOIN users ON users.id = sessions.user_id
                WHERE sessions.token_hash = encode(digest($1::text, 'sha256'), 'hex')
                  AND sessions.expires_at > now()
                  AND users.status = 'active'
                LIMIT 1
            ",
            &[&cookie.value()],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(user.map(auth_user_from_row))
}

pub async fn require_user(state: &AppState, request: &HttpRequest) -> Result<AuthUser> {
    current_user(state, request)
        .await?
        .ok_or_else(|| error::ErrorUnauthorized("authentication required"))
}

pub async fn require_admin(state: &AppState, request: &HttpRequest) -> Result<AuthUser> {
    let user = require_user(state, request).await?;

    if user.is_admin() {
        return Ok(user);
    }

    Err(error::ErrorForbidden("admin access required"))
}

pub async fn require_csrf(state: &AppState, request: &HttpRequest, csrf_token: &str) -> Result<()> {
    let csrf_token = csrf_token.trim();

    if csrf_token.is_empty() {
        return Err(error::ErrorForbidden("csrf token required"));
    }

    let Some(cookie) = request.cookie(SESSION_COOKIE) else {
        return Err(error::ErrorUnauthorized("authentication required"));
    };

    let session = state
        .db
        .query_opt(
            "
                SELECT sessions.id
                FROM sessions
                INNER JOIN users ON users.id = sessions.user_id
                WHERE sessions.token_hash = encode(digest($1::text, 'sha256'), 'hex')
                  AND sessions.csrf_token = $2
                  AND sessions.expires_at > now()
                  AND users.status = 'active'
                LIMIT 1
            ",
            &[&cookie.value(), &csrf_token],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    if session.is_some() {
        return Ok(());
    }

    Err(error::ErrorForbidden("csrf token invalid"))
}

fn auth_user_from_row(row: tokio_postgres::Row) -> AuthUser {
    let has_profile_image: bool = row.get("has_profile_image");
    let profile_image_version: Option<String> = row.get("profile_image_version");
    let profile_image_url = has_profile_image.then(|| {
        let version = profile_image_version
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "1".to_owned());

        format!("/api/profile/avatar?v={version}")
    });

    AuthUser {
        id: row.get("id"),
        username: row.get("username"),
        role: row.get("role"),
        status: row.get("status"),
        display_name: row.get("display_name"),
        theme_preference: row.get("theme_preference"),
        accent_color: row.get("accent_color"),
        folder_zip_prompt_enabled: row.get("folder_zip_prompt_enabled"),
        profile_image_url,
    }
}
