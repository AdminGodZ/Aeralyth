use actix_multipart::Multipart;
use actix_web::http::header::{CACHE_CONTROL, CONTENT_TYPE, LOCATION};
use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use futures_util::StreamExt;

use crate::auth::{CSRF_FIELD, require_csrf, require_principal};
use crate::state::AppState;

const MAX_PROFILE_IMAGE_BYTES: usize = 2 * 1024 * 1024;
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
        profile_image_bytes = CASE $7::smallint
          WHEN 1 THEN NULL
          WHEN 2 THEN $8
          ELSE profile_image_bytes
        END,
        profile_image_mime_type = CASE $7::smallint
          WHEN 1 THEN NULL
          WHEN 2 THEN $9
          ELSE profile_image_mime_type
        END,
        profile_image_size_bytes = CASE $7::smallint
          WHEN 1 THEN NULL
          WHEN 2 THEN $10
          ELSE profile_image_size_bytes
        END,
        profile_image_updated_at = CASE $7::smallint
          WHEN 1 THEN NULL
          WHEN 2 THEN now()
          ELSE profile_image_updated_at
        END,
        updated_at = now()
    WHERE id = $11
    RETURNING id
";

#[derive(Default)]
struct ProfileUpdate {
    csrf_token: Option<String>,
    display_name: Option<String>,
    theme_preference: Option<String>,
    accent_color: Option<String>,
    folder_zip_prompt_enabled: Option<bool>,
    vault_auto_lock_minutes: Option<i32>,
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
    let mut update = ProfileUpdate::default();

    while let Some(field_result) = payload.next().await {
        let mut field = field_result.map_err(error::ErrorBadRequest)?;
        let Some(content_disposition) = field.content_disposition() else {
            drain_field(&mut field).await?;
            continue;
        };
        let field_name = content_disposition
            .get_name()
            .map(str::to_owned)
            .unwrap_or_default();
        let filename = content_disposition.get_filename().map(str::to_owned);

        match field_name.as_str() {
            CSRF_FIELD => {
                update.csrf_token = Some(read_limited_text_field(&mut field, 512).await?);
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
                update.vault_auto_lock_minutes = normalize_vault_auto_lock_minutes(&value);
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

    let Some(csrf_token) = update.csrf_token else {
        return Err(error::ErrorForbidden("csrf token required"));
    };
    require_csrf(&state, &request, &csrf_token).await?;

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
                &profile_image_action,
                &profile_image_bytes,
                &profile_image_mime_type,
                &profile_image_size,
                &user.id,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
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
                SELECT profile_image_bytes, profile_image_mime_type
                FROM users
                WHERE id = $1
                  AND profile_image_bytes IS NOT NULL
                LIMIT 1
            ",
            &[&user.id],
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
        value @ (5 | 15 | 30 | 60) => Some(value),
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
    use super::PROFILE_UPDATE_QUERY;

    #[test]
    fn profile_patch_is_one_update_without_a_settings_reload() {
        let normalized = PROFILE_UPDATE_QUERY.to_ascii_lowercase();
        assert_eq!(normalized.matches("update users").count(), 1);
        assert!(!normalized.contains("select "));
        assert!(normalized.contains("returning id"));
        assert!(normalized.contains("case when $2 then $1 else display_name end"));
        assert!(normalized.contains("coalesce($3, theme_preference)"));
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
                        folder_zip_prompt_enabled, vault_auto_lock_minutes
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
        transaction
            .rollback()
            .await
            .expect("profile fixture should roll back");
    }
}
