use actix_web::{HttpRequest, Result, error};
use serde::Serialize;

use crate::state::AppState;

pub const SESSION_COOKIE: &str = "aeralyth_session";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub username: String,
    pub role: String,
    pub status: String,
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
                SELECT id, username, role, status
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
                SELECT users.id, users.username, users.role, users.status
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

fn auth_user_from_row(row: tokio_postgres::Row) -> AuthUser {
    AuthUser {
        id: row.get("id"),
        username: row.get("username"),
        role: row.get("role"),
        status: row.get("status"),
    }
}
