use actix_multipart::Multipart;
use actix_web::http::header::LOCATION;
use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use futures_util::StreamExt;
use serde::Deserialize;

use crate::auth::{
    CSRF_FIELD, parse_json_body, require_csrf, require_header_csrf, require_principal,
};
use crate::passwords::PasswordError;
use crate::state::AppState;
use crate::timestamps;

use super::auth::expired_session_cookie;
use super::avatar;

const MAX_PROFILE_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const PASSWORD_CHANGE_JSON_LIMIT: usize = 1024;
const MIN_NEW_PASSWORD_BYTES: usize = 12;
const MAX_NEW_PASSWORD_BYTES: usize = 72;
const PROFILE_IMAGE_KEEP: i16 = 0;
const PROFILE_IMAGE_REMOVE: i16 = 1;
const PROFILE_IMAGE_REPLACE: i16 = 2;

const PROFILE_UPDATE_QUERY: &str = "
    UPDATE users
    SET display_name = CASE WHEN $2 THEN $1 ELSE display_name END,
        theme_preference = COALESCE($3, theme_preference),
        accent_color = COALESCE($4, accent_color),
        folder_zip_prompt_enabled = COALESCE($5, folder_zip_prompt_enabled),
        vault_auto_lock_minutes = COALESCE($6, vault_auto_lock_minutes),
        trash_retention_minutes = COALESCE($7, trash_retention_minutes),
        profile_image_bytes = CASE $8::smallint
          WHEN 1 THEN NULL
          WHEN 2 THEN $9
          ELSE profile_image_bytes
        END,
        profile_image_mime_type = CASE $8::smallint
          WHEN 1 THEN NULL
          WHEN 2 THEN $10
          ELSE profile_image_mime_type
        END,
        profile_image_size_bytes = CASE $8::smallint
          WHEN 1 THEN NULL
          WHEN 2 THEN $11
          ELSE profile_image_size_bytes
        END,
        profile_image_updated_at = CASE $8::smallint
          WHEN 1 THEN NULL
          WHEN 2 THEN now()
          ELSE profile_image_updated_at
        END,
        updated_at = now()
    WHERE id = $12
    RETURNING id
";

const PASSWORD_CHANGE_QUERY: &str = "
    WITH changed AS (
      UPDATE users
      SET password_hash = $1,
          updated_at = now()
      WHERE id = $2
        AND password_hash = $3
        AND status = 'active'
      RETURNING id
    ), revoked_sessions AS (
      DELETE FROM sessions
      WHERE user_id IN (SELECT id FROM changed)
      RETURNING id
    )
    SELECT changed.id,
           (SELECT count(*)::bigint FROM revoked_sessions) AS revoked_session_count
    FROM changed
";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordChangeRequest {
    current_password: String,
    new_password: String,
}

#[derive(Default)]
struct ProfileUpdate {
    display_name: Option<String>,
    theme_preference: Option<String>,
    accent_color: Option<String>,
    folder_zip_prompt_enabled: Option<bool>,
    vault_auto_lock_minutes: Option<i32>,
    trash_retention_minutes: Option<i32>,
    remove_profile_image: bool,
    profile_image: Option<ProfileImage>,
}

struct ProfileImage {
    bytes: Vec<u8>,
    mime_type: String,
    size_bytes: i64,
}

pub async fn update(
    state: web::Data<AppState>,
    request: HttpRequest,
    mut payload: Multipart,
) -> Result<HttpResponse> {
    let user = require_principal(&state, &request).await?;
    let mut csrf_validated = false;
    if let Some(token) = request
        .headers()
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
    {
        require_csrf(&state, &request, token).await?;
        csrf_validated = true;
    }
    let mut update = ProfileUpdate::default();

    while let Some(field_result) = payload.next().await {
        let mut field = field_result.map_err(error::ErrorBadRequest)?;
        let content_disposition = match field.content_disposition() {
            Some(content_disposition) => content_disposition,
            None if !csrf_validated => {
                return Err(error::ErrorForbidden(
                    "csrf token must be the first form field",
                ));
            }
            None => {
                drain_field(&mut field).await?;
                continue;
            }
        };
        let field_name = content_disposition
            .get_name()
            .map(str::to_owned)
            .unwrap_or_default();
        let filename = content_disposition.get_filename().map(str::to_owned);

        // Native multipart forms cannot set a CSRF header. Preserve that fallback
        // without exposing the image-read regression: the token must be the first
        // part, and no later field is polled until it has been validated.
        if !csrf_validated {
            if field_name != CSRF_FIELD {
                return Err(error::ErrorForbidden(
                    "csrf token must be the first form field",
                ));
            }
            let token = read_limited_text_field_without_drain(&mut field, 512).await?;
            require_csrf(&state, &request, &token).await?;
            csrf_validated = true;
            continue;
        }

        match field_name.as_str() {
            CSRF_FIELD => {
                drain_field(&mut field).await?;
            }
            "display_name" => {
                update.display_name = Some(read_limited_text_field(&mut field, 256).await?);
            }
            "theme_preference" => {
                update.theme_preference = Some(read_limited_text_field(&mut field, 32).await?);
            }
            "accent_color" => {
                update.accent_color = Some(read_limited_text_field(&mut field, 32).await?);
            }
            "folder_zip_prompt_enabled" => {
                let value = read_limited_text_field(&mut field, 32).await?;
                update.folder_zip_prompt_enabled = normalize_boolean_preference(&value);
            }
            "vault_auto_lock_minutes" => {
                let value = read_limited_text_field(&mut field, 8).await?;
                update.vault_auto_lock_minutes =
                    Some(normalize_vault_auto_lock_minutes(&value).ok_or_else(|| {
                        error::ErrorBadRequest("invalid automatic lock duration")
                    })?);
            }
            "trash_retention_days" => {
                let value = read_limited_text_field(&mut field, 8).await?;
                let minutes = value
                    .trim()
                    .parse::<i32>()
                    .ok()
                    .and_then(|days| days.checked_mul(1440))
                    .and_then(|minutes| normalize_trash_retention_minutes(&minutes.to_string()))
                    .ok_or_else(|| error::ErrorBadRequest("invalid trash retention duration"))?;
                update.trash_retention_minutes.get_or_insert(minutes);
            }
            "trash_retention_minutes" => {
                let value = read_limited_text_field(&mut field, 8).await?;
                update.trash_retention_minutes =
                    Some(normalize_trash_retention_minutes(&value).ok_or_else(|| {
                        error::ErrorBadRequest("trash retention must be 1 to 525600 minutes")
                    })?);
            }
            "remove_profile_image" => {
                let value = read_limited_text_field(&mut field, 32).await?;
                update.remove_profile_image = matches!(value.as_str(), "1" | "true" | "on");
            }
            "profile_image" => {
                if filename
                    .as_deref()
                    .map(str::trim)
                    .filter(|filename| !filename.is_empty())
                    .is_none()
                {
                    drain_field(&mut field).await?;
                    continue;
                }

                let Some(mime_type) = field.content_type().map(|mime| mime.to_string()) else {
                    drain_field(&mut field).await?;
                    return Ok(redirect("/settings?profile=invalid-image"));
                };

                if !is_allowed_profile_image_mime_type(&mime_type) {
                    drain_field(&mut field).await?;
                    return Ok(redirect("/settings?profile=invalid-image"));
                }

                let Some(bytes) =
                    read_limited_binary_field(&mut field, MAX_PROFILE_IMAGE_BYTES).await?
                else {
                    return Ok(redirect("/settings?profile=image-too-large"));
                };

                if bytes.is_empty() {
                    continue;
                }

                let size_bytes = i64::try_from(bytes.len())
                    .map_err(|_| error::ErrorBadRequest("profile image is too large"))?;
                update.profile_image = Some(ProfileImage {
                    bytes,
                    mime_type,
                    size_bytes,
                });
            }
            _ => {
                drain_field(&mut field).await?;
            }
        }
    }

    if !csrf_validated {
        return Err(error::ErrorForbidden("csrf token required"));
    }

    let display_name_present = update.display_name.is_some();
    let display_name = normalize_display_name(update.display_name.as_deref());
    let theme_preference = update
        .theme_preference
        .as_deref()
        .and_then(|theme_preference| normalize_theme_preference(Some(theme_preference)))
        .map(str::to_owned);
    let accent_color = update
        .accent_color
        .as_deref()
        .and_then(|accent_color| normalize_accent_color(Some(accent_color)));
    let (profile_image_action, profile_image_bytes, profile_image_mime_type, profile_image_size) =
        if update.remove_profile_image {
            (PROFILE_IMAGE_REMOVE, None, None, None)
        } else if let Some(profile_image) = update.profile_image {
            (
                PROFILE_IMAGE_REPLACE,
                Some(profile_image.bytes),
                Some(profile_image.mime_type),
                Some(profile_image.size_bytes),
            )
        } else {
            (PROFILE_IMAGE_KEEP, None, None, None)
        };

    let updated = state
        .db
        .query_opt(
            PROFILE_UPDATE_QUERY,
            &[
                &display_name,
                &display_name_present,
                &theme_preference,
                &accent_color,
                &update.folder_zip_prompt_enabled,
                &update.vault_auto_lock_minutes,
                &update.trash_retention_minutes,
                &profile_image_action,
                &profile_image_bytes,
                &profile_image_mime_type,
                &profile_image_size,
                &user.id,
            ],
        )
        .await
        .map_err(crate::db::http_error)?;
    if updated.is_none() {
        return Err(error::ErrorUnauthorized("authentication required"));
    }

    Ok(redirect("/settings?profile=updated"))
}

pub async fn avatar(state: web::Data<AppState>, request: HttpRequest) -> Result<HttpResponse> {
    let user = require_principal(&state, &request).await?;
    let Some(row) = state
        .db
        .query_opt(
            "
                SELECT profile_image_bytes, profile_image_mime_type,
                       COALESCE(profile_image_updated_at, updated_at)
                         AS profile_image_version_at
                FROM users
                WHERE id = $1
                  AND profile_image_bytes IS NOT NULL
                LIMIT 1
            ",
            &[&user.id],
        )
        .await
        .map_err(crate::db::http_error)?
    else {
        return Ok(HttpResponse::NotFound().finish());
    };

    let bytes: Option<Vec<u8>> = row.get("profile_image_bytes");
    let Some(bytes) = bytes else {
        return Ok(HttpResponse::NotFound().finish());
    };
    let mime_type: Option<String> = row.get("profile_image_mime_type");
    let version = timestamps::version_millis(row.get("profile_image_version_at"));

    Ok(avatar::response(
        &request,
        bytes,
        mime_type.unwrap_or_else(|| "application/octet-stream".to_owned()),
        &version,
    ))
}

pub async fn change_password(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Payload,
) -> Result<HttpResponse> {
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let body = parse_json_body::<PasswordChangeRequest>(&request, body, PASSWORD_CHANGE_JSON_LIMIT)
        .await?;

    validate_new_password(&body.new_password)?;

    let current_hash = state
        .db
        .query_opt(
            "SELECT password_hash FROM users WHERE id = $1 AND status = 'active' LIMIT 1",
            &[&user.id],
        )
        .await
        .map_err(crate::db::http_error)?
        .map(|row| row.get::<_, String>("password_hash"));
    state.db.release_request_connection().await;

    let current_password_valid = state
        .passwords
        .verify_candidate(&body.current_password, current_hash.as_deref())
        .await
        .map_err(map_password_error)?;
    if !current_password_valid {
        return Ok(HttpResponse::BadRequest().body("current password is incorrect"));
    }
    if body.current_password == body.new_password {
        return Ok(HttpResponse::BadRequest().body("new password must be different"));
    }

    let new_hash = state
        .passwords
        .hash(&body.new_password)
        .await
        .map_err(map_password_error)?;
    let changed = state
        .db
        .query_opt(PASSWORD_CHANGE_QUERY, &[&new_hash, &user.id, &current_hash])
        .await
        .map_err(crate::db::http_error)?;
    if changed.is_none() {
        return Ok(HttpResponse::Conflict().body("password changed concurrently; try again"));
    }

    Ok(HttpResponse::NoContent()
        .cookie(expired_session_cookie(state.config.cookie_secure))
        .finish())
}

fn validate_new_password(password: &str) -> Result<()> {
    if !(MIN_NEW_PASSWORD_BYTES..=MAX_NEW_PASSWORD_BYTES).contains(&password.len()) {
        return Err(error::ErrorBadRequest(
            "new password must contain 12 to 72 bytes",
        ));
    }

    Ok(())
}

fn map_password_error(password_error: PasswordError) -> actix_web::Error {
    match password_error {
        PasswordError::Busy => error::ErrorTooManyRequests("too many password requests"),
        _ => error::ErrorServiceUnavailable("password change temporarily unavailable"),
    }
}

async fn drain_field(field: &mut actix_multipart::Field) -> Result<()> {
    while let Some(chunk) = field.next().await {
        chunk.map_err(error::ErrorBadRequest)?;
    }

    Ok(())
}

async fn read_limited_text_field(
    field: &mut actix_multipart::Field,
    max_bytes: usize,
) -> Result<String> {
    let Some(bytes) = read_limited_binary_field(field, max_bytes).await? else {
        return Err(error::ErrorBadRequest("form field is too large"));
    };

    String::from_utf8(bytes).map_err(error::ErrorBadRequest)
}

async fn read_limited_text_field_without_drain(
    field: &mut actix_multipart::Field,
    max_bytes: usize,
) -> Result<String> {
    let mut bytes = Vec::new();

    while let Some(chunk_result) = field.next().await {
        let chunk = chunk_result.map_err(error::ErrorBadRequest)?;
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(error::ErrorBadRequest("form field is too large"));
        }
        bytes.extend_from_slice(&chunk);
    }

    String::from_utf8(bytes).map_err(error::ErrorBadRequest)
}

async fn read_limited_binary_field(
    field: &mut actix_multipart::Field,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();

    while let Some(chunk_result) = field.next().await {
        let chunk = chunk_result.map_err(error::ErrorBadRequest)?;

        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            drain_field(field).await?;
            return Ok(None);
        }

        bytes.extend_from_slice(&chunk);
    }

    Ok(Some(bytes))
}

fn normalize_display_name(value: Option<&str>) -> Option<String> {
    let display_name = value?
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>();
    let display_name = display_name.trim();

    if display_name.is_empty() {
        return None;
    }

    Some(display_name.chars().take(80).collect())
}

fn normalize_theme_preference(value: Option<&str>) -> Option<&'static str> {
    match value?.trim() {
        "system" => Some("system"),
        "light" => Some("light"),
        "dark" => Some("dark"),
        _ => None,
    }
}

fn normalize_accent_color(value: Option<&str>) -> Option<String> {
    let value = value?.trim();

    if value.len() != 7 || !value.starts_with('#') {
        return None;
    }

    if !value[1..]
        .chars()
        .all(|character| character.is_ascii_hexdigit())
    {
        return None;
    }

    Some(value.to_ascii_lowercase())
}

fn normalize_boolean_preference(value: &str) -> Option<bool> {
    match value.trim() {
        "1" | "true" | "on" => Some(true),
        "0" | "false" | "off" => Some(false),
        _ => None,
    }
}

fn normalize_vault_auto_lock_minutes(value: &str) -> Option<i32> {
    match value.trim().parse::<i32>().ok()? {
        value @ (0 | 5 | 15 | 30 | 60) => Some(value),
        _ => None,
    }
}

fn normalize_trash_retention_minutes(value: &str) -> Option<i32> {
    match value.trim().parse::<i32>().ok()? {
        minutes @ 1..=525600 => Some(minutes),
        _ => None,
    }
}

fn is_allowed_profile_image_mime_type(mime_type: &str) -> bool {
    matches!(
        mime_type,
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    )
}

fn redirect(location: &'static str) -> HttpResponse {
    HttpResponse::SeeOther()
        .insert_header((LOCATION, location))
        .finish()
}

#[cfg(test)]
mod tests {
    use super::{
        PASSWORD_CHANGE_QUERY, PROFILE_UPDATE_QUERY, normalize_trash_retention_minutes,
        normalize_vault_auto_lock_minutes, validate_new_password,
    };

    #[test]
    fn password_change_requires_a_bcrypt_safe_strong_length() {
        assert!(validate_new_password(&"a".repeat(11)).is_err());
        assert!(validate_new_password(&"a".repeat(12)).is_ok());
        assert!(validate_new_password(&"a".repeat(72)).is_ok());
        assert!(validate_new_password(&"a".repeat(73)).is_err());
    }

    #[test]
    fn trash_retention_accepts_minute_precision_up_to_one_year() {
        for minutes in [1, 2, 59, 60, 1441, 525600] {
            assert_eq!(
                normalize_trash_retention_minutes(&minutes.to_string()),
                Some(minutes)
            );
        }
        for value in ["0", "-1", "525601", "1.5", "1e3", "garbage"] {
            assert_eq!(normalize_trash_retention_minutes(value), None);
        }
    }

    #[test]
    fn automatic_lock_accepts_never_and_existing_durations() {
        for minutes in [0, 5, 15, 30, 60] {
            assert_eq!(
                normalize_vault_auto_lock_minutes(&minutes.to_string()),
                Some(minutes)
            );
        }
        for value in ["-1", "1", "1440", "forever"] {
            assert_eq!(normalize_vault_auto_lock_minutes(value), None);
        }
    }

    #[test]
    fn password_change_revokes_sessions_only_after_the_hash_changes() {
        let normalized = PASSWORD_CHANGE_QUERY.to_ascii_lowercase();
        assert!(normalized.contains("update users"));
        assert!(normalized.contains("password_hash = $3"));
        assert!(normalized.contains("delete from sessions"));
        assert!(normalized.contains("select id from changed"));
    }

    #[test]
    fn password_change_authenticates_and_checks_csrf_before_parsing_json() {
        let source = include_str!("profile.rs");
        let handler = source
            .split_once("pub async fn change_password(")
            .and_then(|(_, tail)| tail.split_once("fn validate_new_password("))
            .map(|(handler, _)| handler)
            .expect("password handler should remain inspectable");
        let authentication = handler
            .find("require_principal(")
            .expect("password change must authenticate");
        let csrf = handler
            .find("require_header_csrf(")
            .expect("password change must validate CSRF");
        let body = handler
            .find("parse_json_body::<PasswordChangeRequest>")
            .expect("password change must parse its bounded body");
        assert!(authentication < csrf && csrf < body);
    }

    #[test]
    fn profile_update_checks_csrf_before_polling_any_image_bytes() {
        let source = include_str!("profile.rs");
        let handler = source
            .split_once("pub async fn update(")
            .and_then(|(_, tail)| tail.split_once("pub async fn avatar("))
            .map(|(handler, _)| handler)
            .expect("profile update handler should remain inspectable");
        let authentication = handler
            .find("require_principal(")
            .expect("profile update must authenticate");
        let csrf = handler
            .find(".get(\"x-csrf-token\")")
            .expect("profile update must inspect header CSRF first");
        let multipart = handler
            .find("payload.next()")
            .expect("profile update must parse its bounded multipart body");

        assert!(authentication < csrf && csrf < multipart);
        let fallback = handler
            .find("if !csrf_validated")
            .expect("native multipart fallback must be guarded");
        let missing_disposition = handler
            .find("None if !csrf_validated")
            .expect("missing first-part disposition must fail without draining");
        let field_dispatch = handler
            .find("match field_name.as_str()")
            .expect("profile fields must remain explicitly bounded");
        assert!(missing_disposition < fallback && fallback < field_dispatch);
        assert!(handler.contains("field_name != CSRF_FIELD"));
        assert!(handler.contains("read_limited_text_field_without_drain(&mut field, 512)"));

        let no_drain_reader = source
            .split_once("async fn read_limited_text_field_without_drain(")
            .and_then(|(_, tail)| tail.split_once("async fn read_limited_binary_field("))
            .map(|(reader, _)| reader)
            .expect("native CSRF reader should remain inspectable");
        assert!(!no_drain_reader.contains("drain_field"));
    }

    #[test]
    fn profile_patch_is_one_update_without_a_settings_reload() {
        let normalized = PROFILE_UPDATE_QUERY.to_ascii_lowercase();
        assert_eq!(normalized.matches("update users").count(), 1);
        assert!(!normalized.contains("select "));
        assert!(normalized.contains("returning id"));
        assert!(normalized.contains("case when $2 then $1 else display_name end"));
        assert!(normalized.contains("coalesce($3, theme_preference)"));
        assert!(normalized.contains("coalesce($7, trash_retention_minutes)"));
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn database_query_contracts_prepare() {
        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
        let (client, connection) = tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
            .await
            .expect("connect to PostgreSQL");
        actix_web::rt::spawn(async move {
            connection
                .await
                .expect("PostgreSQL connection stays healthy");
        });

        client
            .prepare(PROFILE_UPDATE_QUERY)
            .await
            .expect("profile patch query should prepare");
        client
            .prepare(PASSWORD_CHANGE_QUERY)
            .await
            .expect("password change query should prepare");
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn database_optimized_queries_execute() {
        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
        let (mut client, connection) =
            tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
                .await
                .expect("connect to PostgreSQL");
        actix_web::rt::spawn(async move {
            connection
                .await
                .expect("PostgreSQL connection stays healthy");
        });
        let transaction = client
            .transaction()
            .await
            .expect("test transaction should start");
        transaction
            .execute(
                "INSERT INTO users (
                   id, username, password_hash, role, status, display_name,
                   theme_preference, accent_color, folder_zip_prompt_enabled,
                   vault_auto_lock_minutes
                 ) VALUES (
                   'usr_perf_profile', 'perf_profile', 'not-a-login-hash',
                   'user', 'active', 'Before', 'system', '#112233', TRUE, 15
                 )",
                &[],
            )
            .await
            .expect("profile fixture should insert");
        let display_name = Some("Latency User");
        let theme = Some("dark");
        let accent: Option<&str> = None;
        let zip_prompt = Some(false);
        let auto_lock = Some(30_i32);
        let trash_retention = Some(7_i32);
        let image_bytes: Option<Vec<u8>> = None;
        let image_mime: Option<String> = None;
        let image_size: Option<i64> = None;
        let row = transaction
            .query_one(
                PROFILE_UPDATE_QUERY,
                &[
                    &display_name,
                    &true,
                    &theme,
                    &accent,
                    &zip_prompt,
                    &auto_lock,
                    &trash_retention,
                    &0_i16,
                    &image_bytes,
                    &image_mime,
                    &image_size,
                    &"usr_perf_profile",
                ],
            )
            .await
            .expect("one-statement profile patch should execute");
        assert_eq!(row.get::<_, String>("id"), "usr_perf_profile");
        let stored = transaction
            .query_one(
                "SELECT display_name, theme_preference, accent_color,
                        folder_zip_prompt_enabled, vault_auto_lock_minutes,
                        trash_retention_minutes
                 FROM users WHERE id = 'usr_perf_profile'",
                &[],
            )
            .await
            .expect("patched profile should remain readable");
        assert_eq!(
            stored.get::<_, Option<String>>("display_name").as_deref(),
            Some("Latency User")
        );
        assert_eq!(stored.get::<_, String>("theme_preference"), "dark");
        assert_eq!(stored.get::<_, String>("accent_color"), "#112233");
        assert!(!stored.get::<_, bool>("folder_zip_prompt_enabled"));
        assert_eq!(stored.get::<_, i32>("vault_auto_lock_minutes"), 30);
        assert_eq!(stored.get::<_, i32>("trash_retention_minutes"), 7);
        transaction
            .rollback()
            .await
            .expect("profile fixture should roll back");
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn database_password_change_revokes_every_session_atomically() {
        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
        let (mut client, connection) =
            tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
                .await
                .expect("connect to PostgreSQL");
        actix_web::rt::spawn(async move {
            connection
                .await
                .expect("PostgreSQL connection stays healthy");
        });
        let transaction = client
            .transaction()
            .await
            .expect("test transaction should start");
        let current_hash = bcrypt::hash("current-password", 6).expect("current hash");
        let new_hash = bcrypt::hash("new-password-value", 6).expect("new hash");
        transaction
            .execute(
                "INSERT INTO users (id, username, password_hash, role, status)
                 VALUES ('usr_password_change', 'password_change', $1, 'user', 'active')",
                &[&current_hash],
            )
            .await
            .expect("password fixture should insert");
        transaction
            .batch_execute(
                "INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at)
                 VALUES
                   ('ses_password_change_1', 'usr_password_change',
                    decode(repeat('b1', 32), 'hex'), 'csrf-password-1', now() + interval '1 hour'),
                   ('ses_password_change_2', 'usr_password_change',
                    decode(repeat('b2', 32), 'hex'), 'csrf-password-2', now() + interval '1 hour');",
            )
            .await
            .expect("session fixtures should insert");

        let changed = transaction
            .query_one(
                PASSWORD_CHANGE_QUERY,
                &[&new_hash, &"usr_password_change", &current_hash],
            )
            .await
            .expect("password change should execute");
        assert_eq!(changed.get::<_, i64>("revoked_session_count"), 2);
        let stored_hash: String = transaction
            .query_one(
                "SELECT password_hash FROM users WHERE id = 'usr_password_change'",
                &[],
            )
            .await
            .expect("changed user should remain readable")
            .get("password_hash");
        assert!(bcrypt::verify("new-password-value", &stored_hash).expect("new hash verifies"));
        let remaining_sessions: i64 = transaction
            .query_one(
                "SELECT count(*)::bigint AS count FROM sessions WHERE user_id = 'usr_password_change'",
                &[],
            )
            .await
            .expect("session count should execute")
            .get("count");
        assert_eq!(remaining_sessions, 0);

        transaction
            .rollback()
            .await
            .expect("password fixture should roll back");
    }
}
