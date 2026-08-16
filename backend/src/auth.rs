use actix_web::{HttpMessage, HttpRequest, Result, dev, error, web};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::future::Future;

use crate::state::AppState;
use crate::timestamps;

pub const SESSION_COOKIE: &str = "aeralyth_session";
pub const CSRF_FIELD: &str = "csrf_token";
const SESSION_PRINCIPAL_QUERY: &str = "
    SELECT sessions.id AS session_id, sessions.csrf_token,
           users.id, users.role, users.status
    FROM sessions
    INNER JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = $1
      AND sessions.expires_at > now()
      AND users.status = 'active'
    LIMIT 1
";

pub async fn parse_json_body<T: DeserializeOwned>(
    request: &HttpRequest,
    payload: web::Payload,
    limit: usize,
) -> Result<T> {
    decode_json_body(request, payload.into_inner(), limit).await
}

async fn decode_json_body<T: DeserializeOwned>(
    request: &HttpRequest,
    mut payload: dev::Payload,
    limit: usize,
) -> Result<T> {
    web::JsonBody::<T>::new(request, &mut payload, None, true)
        .limit(limit)
        .await
        .map_err(Into::into)
}

#[derive(Clone, Debug)]
pub struct SessionPrincipal {
    pub session_id: String,
    pub id: String,
    pub role: String,
    pub status: String,
    csrf_token: Option<String>,
}

impl SessionPrincipal {
    fn is_valid(&self) -> bool {
        !self.session_id.is_empty()
            && !self.id.is_empty()
            && matches!(self.role.as_str(), "admin" | "user")
            && self.status == "active"
    }

    pub fn is_admin(&self) -> bool {
        self.role == "admin"
    }

    pub fn csrf_token(&self) -> Option<&str> {
        self.csrf_token.as_deref()
    }
}

pub fn hash_session_token(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

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
    pub vault_auto_lock_minutes: i32,
    pub profile_image_url: Option<String>,
    pub e2ee_mode: String,
    pub vault_configured: bool,
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
                  password_hash,
                  role,
                  status,
                  display_name,
                  COALESCE(theme_preference, 'system') AS theme_preference,
                  COALESCE(accent_color, '#3088f0') AS accent_color,
                  COALESCE(folder_zip_prompt_enabled, TRUE) AS folder_zip_prompt_enabled,
                  COALESCE(vault_auto_lock_minutes, 15) AS vault_auto_lock_minutes,
                  profile_image_bytes IS NOT NULL AS has_profile_image,
                  COALESCE(profile_image_updated_at, updated_at)
                    AS profile_image_version_at,
                  EXISTS (SELECT 1 FROM user_vaults WHERE user_id = users.id) AS vault_configured
                FROM users
                WHERE lower(username) = lower($1)
                  AND status = 'active'
                LIMIT 1
            ",
            &[&username],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let candidate = user.map(|row| {
        let password_hash: String = row.get("password_hash");
        let user = auth_user_from_row(row, state.config.e2ee_mode.as_str());
        (user, password_hash)
    });

    // Bcrypt is CPU-bound. Return the scarce PostgreSQL connection before
    // waiting for the bounded blocking worker, including for invalid users.
    state.db.release_request_connection().await;
    let verified = state
        .passwords
        .verify_candidate(
            password,
            candidate
                .as_ref()
                .map(|(_, password_hash)| password_hash.as_str()),
        )
        .await
        .map_err(|password_error| match password_error {
            crate::passwords::PasswordError::Busy => {
                error::ErrorTooManyRequests("too many authentication requests")
            }
            _ => error::ErrorServiceUnavailable("authentication temporarily unavailable"),
        })?;

    Ok(candidate.and_then(|(user, _)| verified.then_some(user)))
}

pub async fn current_user(state: &AppState, request: &HttpRequest) -> Result<Option<AuthUser>> {
    if let Some(user) = request.extensions().get::<AuthUser>().cloned() {
        return Ok(Some(user));
    }

    let Some(cookie) = request.cookie(SESSION_COOKIE) else {
        return Ok(None);
    };

    let cached_principal = request.extensions().get::<SessionPrincipal>().cloned();
    let user = if let Some(principal) = cached_principal {
        state
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
                      COALESCE(users.vault_auto_lock_minutes, 15) AS vault_auto_lock_minutes,
                      users.profile_image_bytes IS NOT NULL AS has_profile_image,
                      COALESCE(users.profile_image_updated_at, users.updated_at)
                        AS profile_image_version_at,
                      EXISTS (SELECT 1 FROM user_vaults WHERE user_id = users.id) AS vault_configured
                    FROM users
                    WHERE users.id = $1 AND users.status = 'active'
                    LIMIT 1
                ",
                &[&principal.id],
            )
            .await
            .map_err(error::ErrorInternalServerError)?
    } else {
        let token_hash = hash_session_token(cookie.value());
        state
            .db
            .query_opt(
                "
                SELECT
                  sessions.id AS session_id,
                  sessions.csrf_token,
                  users.id,
                  users.username,
                  users.role,
                  users.status,
                  users.display_name,
                  COALESCE(users.theme_preference, 'system') AS theme_preference,
                  COALESCE(users.accent_color, '#3088f0') AS accent_color,
                  COALESCE(users.folder_zip_prompt_enabled, TRUE) AS folder_zip_prompt_enabled,
                  COALESCE(users.vault_auto_lock_minutes, 15) AS vault_auto_lock_minutes,
                  users.profile_image_bytes IS NOT NULL AS has_profile_image,
                  COALESCE(users.profile_image_updated_at, users.updated_at)
                    AS profile_image_version_at,
                  EXISTS (SELECT 1 FROM user_vaults WHERE user_id = users.id) AS vault_configured
                FROM sessions
                INNER JOIN users ON users.id = sessions.user_id
                WHERE sessions.token_hash = $1
                  AND sessions.expires_at > now()
                  AND users.status = 'active'
                LIMIT 1
            ",
                &[&token_hash.as_slice()],
            )
            .await
            .map_err(error::ErrorInternalServerError)?
    };

    let Some(row) = user else {
        return Ok(None);
    };
    if request.extensions().get::<SessionPrincipal>().is_none() {
        request
            .extensions_mut()
            .insert(session_principal_from_row(&row));
    }
    let user = auth_user_from_row(row, state.config.e2ee_mode.as_str());
    request.extensions_mut().insert(user.clone());

    Ok(Some(user))
}

pub async fn session_principal(
    state: &AppState,
    request: &HttpRequest,
) -> Result<Option<SessionPrincipal>> {
    cached_or_load_principal(request, || async {
        let Some(cookie) = request.cookie(SESSION_COOKIE) else {
            return Ok(None);
        };
        let token_hash = hash_session_token(cookie.value());
        let row = state
            .db
            .query_opt(SESSION_PRINCIPAL_QUERY, &[&token_hash.as_slice()])
            .await
            .map_err(error::ErrorInternalServerError)?;
        Ok(row.as_ref().map(session_principal_from_row))
    })
    .await
}

async fn cached_or_load_principal<Load, Loaded>(
    request: &HttpRequest,
    load: Load,
) -> Result<Option<SessionPrincipal>>
where
    Load: FnOnce() -> Loaded,
    Loaded: Future<Output = Result<Option<SessionPrincipal>>>,
{
    if let Some(principal) = request.extensions().get::<SessionPrincipal>().cloned() {
        return Ok(Some(principal));
    }
    let principal = load().await?.filter(SessionPrincipal::is_valid);
    if let Some(principal) = principal.as_ref() {
        request.extensions_mut().insert(principal.clone());
    }
    Ok(principal)
}

pub async fn require_principal(
    state: &AppState,
    request: &HttpRequest,
) -> Result<SessionPrincipal> {
    session_principal(state, request)
        .await?
        .ok_or_else(|| error::ErrorUnauthorized("authentication required"))
}

pub async fn require_user(state: &AppState, request: &HttpRequest) -> Result<AuthUser> {
    current_user(state, request)
        .await?
        .ok_or_else(|| error::ErrorUnauthorized("authentication required"))
}

pub async fn require_admin(state: &AppState, request: &HttpRequest) -> Result<SessionPrincipal> {
    let principal = require_principal(state, request).await?;

    if principal.is_admin() {
        return Ok(principal);
    }

    Err(error::ErrorForbidden("admin access required"))
}

pub async fn require_admin_user(state: &AppState, request: &HttpRequest) -> Result<AuthUser> {
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

    let principal = require_principal(state, request).await?;
    if principal
        .csrf_token
        .as_deref()
        .is_some_and(|expected| constant_time_equal(expected.as_bytes(), csrf_token.as_bytes()))
    {
        return Ok(());
    }

    Err(error::ErrorForbidden("csrf token invalid"))
}

fn session_principal_from_row(row: &tokio_postgres::Row) -> SessionPrincipal {
    SessionPrincipal {
        session_id: row.get("session_id"),
        id: row.get("id"),
        role: row.get("role"),
        status: row.get("status"),
        csrf_token: row.get("csrf_token"),
    }
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn auth_user_from_row(row: tokio_postgres::Row, e2ee_mode: &str) -> AuthUser {
    let has_profile_image: bool = row.get("has_profile_image");
    let profile_image_version = timestamps::version_millis(row.get("profile_image_version_at"));
    let profile_image_url =
        has_profile_image.then(|| format!("/api/profile/avatar?v={profile_image_version}"));

    AuthUser {
        id: row.get("id"),
        username: row.get("username"),
        role: row.get("role"),
        status: row.get("status"),
        display_name: row.get("display_name"),
        theme_preference: row.get("theme_preference"),
        accent_color: row.get("accent_color"),
        folder_zip_prompt_enabled: row.get("folder_zip_prompt_enabled"),
        vault_auto_lock_minutes: row.get("vault_auto_lock_minutes"),
        profile_image_url,
        e2ee_mode: e2ee_mode.to_owned(),
        vault_configured: row.get("vault_configured"),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        SESSION_PRINCIPAL_QUERY, SessionPrincipal, cached_or_load_principal, constant_time_equal,
        decode_json_body, hash_session_token,
    };
    use actix_web::{http::StatusCode, test as actix_test};
    use serde::Deserialize;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn csrf_comparison_rejects_wrong_values_and_lengths() {
        assert!(constant_time_equal(b"csrf-token", b"csrf-token"));
        assert!(!constant_time_equal(b"csrf-token", b"csrf-tokem"));
        assert!(!constant_time_equal(b"csrf-token", b"csrf"));
    }

    #[test]
    fn session_principal_query_stays_narrow() {
        for forbidden in [
            "username",
            "display_name",
            "theme_preference",
            "accent_color",
            "profile_image",
            "user_vaults",
            "vault_configured",
        ] {
            assert!(
                !SESSION_PRINCIPAL_QUERY.contains(forbidden),
                "principal query unexpectedly selects {forbidden}"
            );
        }
    }

    #[test]
    fn username_identity_uses_one_case_insensitive_indexed_rule() {
        let authentication = include_str!("auth.rs");
        let administration = include_str!("routes/admin.rs");
        let files = include_str!("routes/files.rs");
        let invitations = include_str!("routes/invitations.rs");
        let share_links = include_str!("routes/share_links.rs");
        let vault = include_str!("routes/vault.rs");

        assert!(authentication.contains("WHERE lower(username) = lower($1)"));
        assert!(administration.contains("WHERE lower(username) = lower($1)"));
        assert!(files.contains("WHERE lower(username) = lower($1)"));
        assert!(invitations.contains("lower(username) = lower(target.invited_username)"));
        assert!(share_links.contains("WHERE lower(username) = lower($1)"));
        assert!(vault.contains("WHERE lower(users.username) = lower($2)"));

        let auth_schema = include_str!("../../database/init/001_auth.sql");
        assert!(auth_schema.contains("CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci_idx"));
        assert!(auth_schema.contains("ON users (lower(username))"));
    }

    #[test]
    fn session_tokens_are_hashed_in_application_to_fixed_width() {
        assert_eq!(
            hash_session_token("session-token"),
            [
                0xc1, 0x01, 0xe9, 0x11, 0x46, 0x9c, 0x96, 0x91, 0x71, 0x04, 0x0b, 0x50, 0xd7, 0x05,
                0x43, 0x31, 0x3c, 0xf9, 0x68, 0xfd, 0xef, 0x5b, 0xac, 0xc7, 0x80, 0x77, 0x6f, 0x8f,
                0xb3, 0x99, 0xab, 0x36,
            ]
        );
    }

    #[test]
    fn runtime_session_queries_never_hash_tokens_in_postgres() {
        let database_hash_call = ["encode(", "digest("].concat();
        let parameterized_database_hash = ["digest(", "$"].concat();
        for (name, source) in [
            ("authentication", include_str!("auth.rs")),
            ("session routes", include_str!("routes/auth.rs")),
        ] {
            assert!(
                !source.contains(&database_hash_call),
                "{name} reintroduced PostgreSQL session-token hashing"
            );
            assert!(
                !source.contains(&parameterized_database_hash),
                "{name} reintroduced parameterized PostgreSQL session-token hashing"
            );
        }

        let database_session_hash = ["sessions.token_hash = encode(", "digest("].concat();
        let parameterized_session_hash = ["sessions.token_hash = digest(", "$"].concat();
        let admin_source = include_str!("routes/admin.rs");
        assert!(
            !admin_source.contains(&database_session_hash)
                && !admin_source.contains(&parameterized_session_hash),
            "admin transaction checks reintroduced PostgreSQL session-token hashing"
        );
    }

    #[test]
    fn ordinary_route_modules_do_not_load_full_profiles() {
        for (name, source) in [
            ("files", include_str!("routes/files.rs")),
            ("repositories", include_str!("routes/repositories.rs")),
            ("share links", include_str!("routes/share_links.rs")),
            ("vault", include_str!("routes/vault.rs")),
            ("profile mutations", include_str!("routes/profile.rs")),
        ] {
            assert!(
                !source.contains("require_user("),
                "{name} route reintroduced full-profile authentication"
            );
            assert!(
                !source.contains("current_user("),
                "{name} route reintroduced full-profile authentication"
            );
        }

        let admin_routes = include_str!("routes/admin.rs");
        assert_eq!(
            admin_routes.matches("require_admin_user(").count(),
            1,
            "only the explicit admin session response may load a full profile"
        );
    }

    #[derive(Debug, Deserialize)]
    struct JsonProbe {
        value: String,
    }

    #[actix_web::test]
    async fn bounded_json_decode_preserves_json_validation_and_limits() {
        let (request, payload) = actix_test::TestRequest::post()
            .insert_header(("content-type", "application/json"))
            .set_payload(r#"{"value":"ok"}"#)
            .to_http_parts();
        let parsed = decode_json_body::<JsonProbe>(&request, payload, 64)
            .await
            .expect("small JSON should parse");
        assert_eq!(parsed.value, "ok");

        let (request, payload) = actix_test::TestRequest::post()
            .insert_header(("content-type", "application/json"))
            .set_payload(r#"{"value":"too large"}"#)
            .to_http_parts();
        let error = decode_json_body::<JsonProbe>(&request, payload, 8)
            .await
            .expect_err("oversized JSON should be rejected");
        assert_eq!(
            error.as_response_error().status_code(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }

    #[test]
    fn protected_json_routes_keep_body_parsing_inside_authenticated_handlers() {
        for (name, source, expected_payloads) in [
            ("files", include_str!("routes/files.rs"), 6),
            ("repositories", include_str!("routes/repositories.rs"), 3),
            ("share links", include_str!("routes/share_links.rs"), 1),
            ("profile", include_str!("routes/profile.rs"), 2),
            ("vault", include_str!("routes/vault.rs"), 8),
        ] {
            assert!(
                !source.contains("web::Json<"),
                "{name} reintroduced eager JSON extraction"
            );
            assert_eq!(
                source.matches("parse_json_body::<").count(),
                expected_payloads,
                "{name} JSON route coverage changed; authenticate before parsing any new body"
            );
        }
        let vault = include_str!("routes/vault.rs");
        assert_eq!(
            vault.matches("serde_json::from_slice::<").count(),
            5,
            "large compatibility publications must deserialize only inside bounded CPU work"
        );
    }

    #[test]
    fn application_password_paths_never_run_bcrypt_in_postgres() {
        for (name, source) in [
            ("authentication", include_str!("auth.rs")),
            ("admin user creation", include_str!("routes/admin.rs")),
            (
                "invitation acceptance",
                include_str!("routes/invitations.rs"),
            ),
            ("password change", include_str!("routes/profile.rs")),
        ] {
            let crypt_call = ["cr", "ypt("].concat();
            let salt_call = ["gen_", "salt("].concat();
            assert!(
                !source.contains(&crypt_call),
                "{name} moved bcrypt back into PostgreSQL"
            );
            assert!(
                !source.contains(&salt_call),
                "{name} moved hashing back into PostgreSQL"
            );
        }
    }

    #[actix_web::test]
    async fn session_principal_is_loaded_once_per_request() {
        let request = actix_test::TestRequest::default().to_http_request();
        let loads = AtomicUsize::new(0);
        let principal = || SessionPrincipal {
            session_id: "session-1".to_owned(),
            id: "user-1".to_owned(),
            role: "user".to_owned(),
            status: "active".to_owned(),
            csrf_token: Some("csrf-token".to_owned()),
        };

        let first = cached_or_load_principal(&request, || async {
            loads.fetch_add(1, Ordering::Relaxed);
            Ok(Some(principal()))
        })
        .await
        .expect("first principal lookup should succeed");
        let second = cached_or_load_principal(&request, || async {
            loads.fetch_add(1, Ordering::Relaxed);
            Ok(Some(principal()))
        })
        .await
        .expect("cached principal lookup should succeed");

        assert_eq!(loads.load(Ordering::Relaxed), 1);
        assert_eq!(first.expect("principal should exist").id, "user-1");
        assert_eq!(second.expect("principal should be cached").id, "user-1");
    }
}
