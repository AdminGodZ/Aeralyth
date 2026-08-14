use actix_web::{HttpMessage, HttpRequest, Result, error};
use serde::Serialize;
use std::future::Future;

use crate::state::AppState;

pub const SESSION_COOKIE: &str = "aeralyth_session";
pub const CSRF_FIELD: &str = "csrf_token";
const SESSION_PRINCIPAL_QUERY: &str = "
    SELECT sessions.id AS session_id, sessions.csrf_token,
           users.id, users.role, users.status
    FROM sessions
    INNER JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = encode(digest($1::text, 'sha256'), 'hex')
      AND sessions.expires_at > now()
      AND users.status = 'active'
    LIMIT 1
";

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
                  role,
                  status,
                  display_name,
                  COALESCE(theme_preference, 'system') AS theme_preference,
                  COALESCE(accent_color, '#3088f0') AS accent_color,
                  COALESCE(folder_zip_prompt_enabled, TRUE) AS folder_zip_prompt_enabled,
                  COALESCE(vault_auto_lock_minutes, 15) AS vault_auto_lock_minutes,
                  profile_image_bytes IS NOT NULL AS has_profile_image,
                  to_char(
                    COALESCE(profile_image_updated_at, updated_at) AT TIME ZONE 'UTC',
                    'YYYYMMDDHH24MISSMS'
                  ) AS profile_image_version,
                  EXISTS (SELECT 1 FROM user_vaults WHERE user_id = users.id) AS vault_configured
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

    Ok(user.map(|row| auth_user_from_row(row, state.config.e2ee_mode.as_str())))
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
                      to_char(
                        COALESCE(users.profile_image_updated_at, users.updated_at) AT TIME ZONE 'UTC',
                        'YYYYMMDDHH24MISSMS'
                      ) AS profile_image_version,
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
                  to_char(
                    COALESCE(users.profile_image_updated_at, users.updated_at) AT TIME ZONE 'UTC',
                    'YYYYMMDDHH24MISSMS'
                  ) AS profile_image_version,
                  EXISTS (SELECT 1 FROM user_vaults WHERE user_id = users.id) AS vault_configured
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
        let row = state
            .db
            .query_opt(SESSION_PRINCIPAL_QUERY, &[&cookie.value()])
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
    };
    use actix_web::test as actix_test;
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
