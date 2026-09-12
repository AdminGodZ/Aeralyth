use actix_web::http::header::CACHE_CONTROL;
use actix_web::{HttpRequest, HttpResponse, Result, web};
use serde::Serialize;

use crate::auth::{AuthUser, SESSION_COOKIE, auth_user_from_row, hash_session_token};
use crate::state::AppState;

const SESSION_BOOTSTRAP_QUERY: &str = "
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
      COALESCE(users.trash_retention_days, 30) AS trash_retention_days,
      COALESCE(users.trash_retention_minutes, 43200) AS trash_retention_minutes,
      COALESCE(users.auth_version, 0::smallint) AS auth_version,
      users.profile_image_bytes IS NOT NULL AS has_profile_image,
      COALESCE(users.profile_image_updated_at, users.updated_at) AS profile_image_version_at,
      EXISTS (SELECT 1 FROM user_vaults WHERE user_id = users.id) AS vault_configured,
      COALESCE((SELECT head FROM realtime_stream_state WHERE singleton), 0::bigint)
        AS realtime_cursor
    FROM sessions
    INNER JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = $1
      AND sessions.expires_at > now()
      AND users.status = 'active'
    LIMIT 1
";

const INITIALIZE_CSRF_QUERY: &str = "
    UPDATE sessions
    SET csrf_token = COALESCE(NULLIF(csrf_token, ''), $2)
    WHERE id = $1
      AND expires_at > now()
      AND EXISTS (SELECT 1 FROM users WHERE users.id = sessions.user_id AND status = 'active')
    RETURNING csrf_token
";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionBootstrapResponse {
    user: AuthUser,
    csrf_token: String,
    realtime_cursor: String,
}

pub async fn bootstrap(state: web::Data<AppState>, request: HttpRequest) -> Result<HttpResponse> {
    let Some(cookie) = request.cookie(SESSION_COOKIE) else {
        return Ok(unauthorized());
    };
    let token_hash = hash_session_token(cookie.value());
    // This snapshot precedes all dashboard data reads. Events published after
    // it remain replayable, including mutations waiting in the outbox.
    let row = state
        .db
        .query_opt(SESSION_BOOTSTRAP_QUERY, &[&token_hash.as_slice()])
        .await
        .map_err(crate::db::http_error)?;
    let Some(row) = row else {
        return Ok(unauthorized());
    };
    let csrf_token: Option<String> = row.get("csrf_token");
    let csrf_token = if let Some(token) = csrf_token.filter(|token| !token.is_empty()) {
        token
    } else {
        // Only legacy sessions need a write. Concurrent bootstraps retain the
        // first installed token rather than invalidating each other's token.
        let session_id: String = row.get("session_id");
        let candidate = super::auth::create_session_token()?;
        let updated = state
            .db
            .query_opt(INITIALIZE_CSRF_QUERY, &[&session_id, &candidate])
            .await
            .map_err(crate::db::http_error)?;
        let Some(updated) = updated else {
            return Ok(unauthorized());
        };
        updated.get("csrf_token")
    };
    let realtime_cursor = row.get::<_, i64>("realtime_cursor").to_string();
    let user = auth_user_from_row(row, state.config.e2ee_mode.as_str());
    state.db.release_request_connection().await;

    Ok(HttpResponse::Ok()
        .insert_header((CACHE_CONTROL, "private, no-store"))
        .json(SessionBootstrapResponse {
            user,
            csrf_token,
            realtime_cursor,
        }))
}

fn unauthorized() -> HttpResponse {
    HttpResponse::Unauthorized()
        .insert_header((CACHE_CONTROL, "private, no-store"))
        .finish()
}

#[cfg(test)]
mod tests {
    use super::{INITIALIZE_CSRF_QUERY, SESSION_BOOTSTRAP_QUERY};
    use crate::auth::{auth_user_from_row, hash_session_token};

    #[actix_web::test]
    async fn bootstrap_query_binds_user_csrf_cursor_and_rejects_revoked_sessions() {
        if std::env::var("AERALYTH_DATABASE_INTEGRATION_TESTS").as_deref() != Ok("1") {
            return;
        }
        let config = crate::config::Config::from_env().expect("integration configuration");
        let (mut client, connection) =
            tokio_postgres::connect(&config.database_url, tokio_postgres::NoTls)
                .await
                .expect("test database connection");
        let connection_task = actix_web::rt::spawn(async move {
            connection.await.expect("test database remains connected");
        });
        let transaction = client.transaction().await.expect("test transaction");
        transaction
            .batch_execute(
                "
                CREATE TEMP TABLE users (
                  id TEXT PRIMARY KEY, username TEXT, role TEXT DEFAULT 'user',
                  status TEXT DEFAULT 'active', display_name TEXT, theme_preference TEXT,
                  accent_color TEXT, folder_zip_prompt_enabled BOOLEAN,
                  vault_auto_lock_minutes INTEGER, trash_retention_days INTEGER,
                  trash_retention_minutes INTEGER, auth_version SMALLINT,
                  profile_image_bytes BYTEA, profile_image_updated_at TIMESTAMPTZ,
                  updated_at TIMESTAMPTZ DEFAULT now()
                ) ON COMMIT DROP;
                CREATE TEMP TABLE sessions (
                  id TEXT PRIMARY KEY, user_id TEXT, token_hash BYTEA,
                  csrf_token TEXT, expires_at TIMESTAMPTZ
                ) ON COMMIT DROP;
                CREATE TEMP TABLE user_vaults (user_id TEXT) ON COMMIT DROP;
                CREATE TEMP TABLE realtime_stream_state (singleton BOOLEAN, head BIGINT)
                  ON COMMIT DROP;
                INSERT INTO users (id, username) VALUES ('user-1', 'one'), ('user-2', 'two');
                INSERT INTO user_vaults VALUES ('user-1');
                INSERT INTO realtime_stream_state VALUES (TRUE, 9007199254740994);
                ",
            )
            .await
            .expect("private integration fixtures");
        let first_hash = hash_session_token("first-session");
        let second_hash = hash_session_token("second-session");
        transaction
            .execute(
                "INSERT INTO sessions VALUES
                  ('session-1', 'user-1', $1, 'csrf-1', now() + interval '1 hour'),
                  ('session-2', 'user-2', $2, NULL, now() + interval '1 hour')",
                &[&first_hash.as_slice(), &second_hash.as_slice()],
            )
            .await
            .expect("test sessions");

        let row = transaction
            .query_one(SESSION_BOOTSTRAP_QUERY, &[&first_hash.as_slice()])
            .await
            .expect("one authorization query returns the complete bootstrap");
        assert_eq!(row.get::<_, String>("csrf_token"), "csrf-1");
        assert_eq!(
            row.get::<_, i64>("realtime_cursor").to_string(),
            "9007199254740994"
        );
        let user = auth_user_from_row(row, "required");
        assert_eq!(user.id, "user-1");
        assert_eq!(user.username, "one");
        assert!(user.vault_configured);
        assert_eq!(user.theme_preference, "system");

        // A retry carrying a different random candidate must preserve the
        // already bound token, as a concurrent initializer would after locking.
        for candidate in ["initial-token", "racing-token"] {
            let row = transaction
                .query_one(INITIALIZE_CSRF_QUERY, &[&"session-2", &candidate])
                .await
                .expect("initialize or retain the legacy CSRF token");
            assert_eq!(row.get::<_, String>("csrf_token"), "initial-token");
        }
        let row = transaction
            .query_one(SESSION_BOOTSTRAP_QUERY, &[&second_hash.as_slice()])
            .await
            .expect("second session bootstrap");
        assert_eq!(row.get::<_, String>("id"), "user-2");
        assert_eq!(row.get::<_, String>("csrf_token"), "initial-token");

        for revoke in [
            "UPDATE users SET status = 'disabled' WHERE id = 'user-1'",
            "UPDATE users SET status = 'active' WHERE id = 'user-1';
             UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = 'session-1'",
            "DELETE FROM sessions WHERE id = 'session-1'",
        ] {
            transaction
                .batch_execute(revoke)
                .await
                .expect("revoke session");
            assert!(
                transaction
                    .query_opt(SESSION_BOOTSTRAP_QUERY, &[&first_hash.as_slice()])
                    .await
                    .expect("revocation lookup")
                    .is_none()
            );
        }
        let unknown_hash = hash_session_token("unknown");
        assert!(
            transaction
                .query_opt(SESSION_BOOTSTRAP_QUERY, &[&unknown_hash.as_slice()])
                .await
                .expect("unknown session lookup")
                .is_none()
        );
        transaction
            .rollback()
            .await
            .expect("discard private fixtures");
        drop(client);
        connection_task.await.expect("database test task");
    }
}
