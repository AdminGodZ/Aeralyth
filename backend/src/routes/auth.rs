use actix_web::cookie::{Cookie, SameSite, time::Duration};
use actix_web::http::header::LOCATION;
use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};

use crate::state::AppState;

const SESSION_COOKIE: &str = "aeralyth_session";
const DEFAULT_SESSION_SECONDS: i64 = 24 * 60 * 60;
const REMEMBER_SESSION_SECONDS: i64 = 30 * 24 * 60 * 60;

#[derive(Deserialize)]
pub struct LoginForm {
    username: String,
    password: String,
    remember: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    id: String,
    username: String,
    role: String,
    status: String,
}

#[derive(Serialize)]
struct MeResponse {
    user: Option<AuthUser>,
}

pub async fn login(state: web::Data<AppState>, form: web::Form<LoginForm>) -> Result<HttpResponse> {
    let username = form.username.trim();

    if username.is_empty() || form.password.is_empty() {
        return Ok(redirect("/login?error=invalid"));
    }

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
            &[&username, &form.password],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    let Some(user) = user else {
        return Ok(redirect("/login?error=invalid"));
    };

    let user_id: String = user.get("id");
    let session_seconds = if form.remember.is_some() {
        REMEMBER_SESSION_SECONDS
    } else {
        DEFAULT_SESSION_SECONDS
    };
    let token = create_session_token()?;

    state
        .db
        .execute(
            "
                INSERT INTO sessions (id, user_id, token_hash, expires_at)
                VALUES (
                  gen_random_uuid()::text,
                  $1,
                  encode(digest($2::text, 'sha256'), 'hex'),
                  now() + ($3::bigint * interval '1 second')
                )
            ",
            &[&user_id, &token, &session_seconds],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    state
        .db
        .execute("DELETE FROM sessions WHERE expires_at <= now()", &[])
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::SeeOther()
        .insert_header((LOCATION, "/files"))
        .cookie(session_cookie(
            token,
            session_seconds,
            state.config.cookie_secure,
        ))
        .finish())
}

pub async fn logout(state: web::Data<AppState>, request: HttpRequest) -> Result<HttpResponse> {
    if let Some(cookie) = request.cookie(SESSION_COOKIE) {
        state
            .db
            .execute(
                "
                    DELETE FROM sessions
                    WHERE token_hash = encode(digest($1::text, 'sha256'), 'hex')
                ",
                &[&cookie.value()],
            )
            .await
            .map_err(error::ErrorInternalServerError)?;
    }

    Ok(HttpResponse::SeeOther()
        .insert_header((LOCATION, "/login"))
        .cookie(expired_session_cookie(state.config.cookie_secure))
        .finish())
}

pub async fn me(state: web::Data<AppState>, request: HttpRequest) -> Result<HttpResponse> {
    let user = current_user(&state, &request).await?;
    let mut status = if user.is_some() {
        HttpResponse::Ok()
    } else {
        HttpResponse::Unauthorized()
    };

    Ok(status.json(MeResponse { user }))
}

async fn current_user(state: &AppState, request: &HttpRequest) -> Result<Option<AuthUser>> {
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

    Ok(user.map(|row| AuthUser {
        id: row.get("id"),
        username: row.get("username"),
        role: row.get("role"),
        status: row.get("status"),
    }))
}

fn create_session_token() -> Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(error::ErrorInternalServerError)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn session_cookie(value: String, max_age_seconds: i64, secure: bool) -> Cookie<'static> {
    Cookie::build(SESSION_COOKIE, value)
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(secure)
        .max_age(Duration::seconds(max_age_seconds))
        .finish()
}

fn expired_session_cookie(secure: bool) -> Cookie<'static> {
    Cookie::build(SESSION_COOKIE, "")
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(secure)
        .max_age(Duration::seconds(0))
        .finish()
}

fn redirect(location: &'static str) -> HttpResponse {
    HttpResponse::SeeOther()
        .insert_header((LOCATION, location))
        .finish()
}
