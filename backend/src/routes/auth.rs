use actix_web::cookie::{Cookie, SameSite, time::Duration};
use actix_web::http::header::LOCATION;
use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr};

use crate::auth::{SESSION_COOKIE, authenticate_password, current_user, require_csrf};
use crate::state::AppState;

const DEFAULT_SESSION_SECONDS: i64 = 24 * 60 * 60;
const REMEMBER_SESSION_SECONDS: i64 = 30 * 24 * 60 * 60;

#[derive(Deserialize)]
pub struct LoginForm {
    username: String,
    password: String,
    remember: Option<String>,
    next: Option<String>,
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

pub async fn login(
    state: web::Data<AppState>,
    request: HttpRequest,
    form: web::Form<LoginForm>,
) -> Result<HttpResponse> {
    let username = form.username.trim();

    if username.is_empty() || form.password.is_empty() {
        return Ok(redirect(login_error_location(form.next.as_deref())));
    }

    let address = request
        .peer_addr()
        .map(|address| address.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    if !state.login_rate_limiter.allow(address, username) {
        return Ok(redirect(login_error_location(form.next.as_deref())));
    }

    let user = authenticate_password(&state, username, &form.password).await?;

    let Some(user) = user else {
        return Ok(redirect(login_error_location(form.next.as_deref())));
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

    let location = safe_next_path(form.next.as_deref())
        .unwrap_or("/files")
        .to_owned();

    Ok(HttpResponse::SeeOther()
        .insert_header((LOCATION, location))
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

fn redirect(location: String) -> HttpResponse {
    HttpResponse::SeeOther()
        .insert_header((LOCATION, location))
        .finish()
}

fn safe_next_path(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|next| {
        next.starts_with("/s/") && next.len() <= 512 && !next.contains(['\r', '\n', '#'])
    })
}

fn login_error_location(next: Option<&str>) -> String {
    let mut location = "/login?error=invalid".to_owned();
    if let Some(next) = safe_next_path(next) {
        location.push_str("&next=");
        location.push_str(&encode_query_component(next));
    }
    location
}

fn encode_query_component(value: &str) -> String {
    use std::fmt::Write as _;

    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(&mut encoded, "%{byte:02X}");
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::{encode_query_component, login_error_location, safe_next_path};

    #[test]
    fn accepts_only_local_share_return_paths() {
        assert_eq!(
            safe_next_path(Some("/s/abc_123?folder=fil_456")),
            Some("/s/abc_123?folder=fil_456")
        );
        assert_eq!(safe_next_path(Some("https://example.com")), None);
        assert_eq!(safe_next_path(Some("/files")), None);
        assert_eq!(safe_next_path(Some("/s/token#fragment")), None);
        assert_eq!(safe_next_path(Some("/s/token\r\nLocation: /admin")), None);
    }

    #[test]
    fn preserves_a_safe_return_path_on_login_errors() {
        assert_eq!(
            login_error_location(Some("/s/token?folder=fil_1")),
            "/login?error=invalid&next=%2Fs%2Ftoken%3Ffolder%3Dfil_1"
        );
        assert_eq!(
            login_error_location(Some("https://example.com")),
            "/login?error=invalid"
        );
    }

    #[test]
    fn encodes_every_non_unreserved_query_byte() {
        assert_eq!(
            encode_query_component("/s/a b?x=1&y=2"),
            "%2Fs%2Fa%20b%3Fx%3D1%26y%3D2"
        );
    }
}
