use actix_web::cookie::{Cookie, SameSite, time::Duration};
use actix_web::http::header::LOCATION;
use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};

use crate::auth::{SESSION_COOKIE, authenticate_password, current_user, require_csrf};
use crate::state::AppState;

const DEFAULT_SESSION_SECONDS: i64 = 24 * 60 * 60;
const REMEMBER_SESSION_SECONDS: i64 = 30 * 24 * 60 * 60;

#[derive(Deserialize)]
pub struct LoginForm {
    username: String,
    password: String,
    remember: Option<String>,
}

#[derive(Deserialize)]
pub struct CsrfForm {
    #[serde(rename = "csrf_token")]
    csrf_token: String,
}

#[derive(Serialize)]
struct MeResponse {
    user: Option<crate::auth::AuthUser>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CsrfResponse {
    csrf_token: String,
}

pub async fn login(state: web::Data<AppState>, form: web::Form<LoginForm>) -> Result<HttpResponse> {
    let username = form.username.trim();

    if username.is_empty() || form.password.is_empty() {
        return Ok(redirect("/login?error=invalid"));
    }

    let user = authenticate_password(&state, username, &form.password).await?;

    let Some(user) = user else {
        return Ok(redirect("/login?error=invalid"));
    };

    let session_seconds = if form.remember.is_some() {
        REMEMBER_SESSION_SECONDS
    } else {
        DEFAULT_SESSION_SECONDS
    };
    let token = create_session_token()?;
    let csrf_token = create_session_token()?;

    state
        .db
        .execute(
            "
                INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at)
                VALUES (
                  gen_random_uuid()::text,
                  $1,
                  encode(digest($2::text, 'sha256'), 'hex'),
                  $3,
                  now() + ($4::bigint * interval '1 second')
                )
            ",
            &[&user.id, &token, &csrf_token, &session_seconds],
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

pub async fn logout(
    state: web::Data<AppState>,
    request: HttpRequest,
    form: web::Form<CsrfForm>,
) -> Result<HttpResponse> {
    require_csrf(&state, &request, &form.csrf_token).await?;

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

pub async fn csrf(state: web::Data<AppState>, request: HttpRequest) -> Result<HttpResponse> {
    let Some(cookie) = request.cookie(SESSION_COOKIE) else {
        return Ok(HttpResponse::Unauthorized().finish());
    };

    let existing = state
        .db
        .query_opt(
            "
                SELECT sessions.csrf_token
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

    let Some(existing) = existing else {
        return Ok(HttpResponse::Unauthorized().finish());
    };

    let csrf_token: Option<String> = existing.get("csrf_token");

    if let Some(csrf_token) = csrf_token.filter(|token| !token.is_empty()) {
        return Ok(HttpResponse::Ok().json(CsrfResponse { csrf_token }));
    }

    let csrf_token = create_session_token()?;
    let updated = state
        .db
        .query_opt(
            "
                UPDATE sessions
                SET csrf_token = $2
                WHERE token_hash = encode(digest($1::text, 'sha256'), 'hex')
                  AND expires_at > now()
                RETURNING csrf_token
            ",
            &[&cookie.value(), &csrf_token],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    if updated.is_none() {
        return Ok(HttpResponse::Unauthorized().finish());
    }

    Ok(HttpResponse::Ok().json(CsrfResponse { csrf_token }))
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
