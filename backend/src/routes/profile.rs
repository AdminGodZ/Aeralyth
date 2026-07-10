use actix_multipart::Multipart;
use actix_web::http::header::{CACHE_CONTROL, CONTENT_TYPE, LOCATION};
use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use futures_util::StreamExt;

use crate::auth::{CSRF_FIELD, require_csrf, require_user};
use crate::state::AppState;

const MAX_PROFILE_IMAGE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Default)]
struct ProfileUpdate {
    csrf_token: Option<String>,
    display_name: Option<String>,
    theme_preference: Option<String>,
    accent_color: Option<String>,
    folder_zip_prompt_enabled: Option<bool>,
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
    let user = require_user(&state, &request).await?;
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

                let Some(bytes) = read_limited_binary_field(
                    &mut field,
                    MAX_PROFILE_IMAGE_BYTES,
                )
                .await?
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

    let existing_settings = state
        .db
        .query_one(
            "
                SELECT
                  display_name,
                  COALESCE(theme_preference, 'system') AS theme_preference,
                  COALESCE(accent_color, '#3088f0') AS accent_color,
                  COALESCE(folder_zip_prompt_enabled, TRUE) AS folder_zip_prompt_enabled
                FROM users
                WHERE id = $1
                LIMIT 1
            ",
            &[&user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let existing_display_name: Option<String> = existing_settings.get("display_name");
    let existing_theme_preference: String = existing_settings.get("theme_preference");
    let existing_accent_color: String = existing_settings.get("accent_color");
    let existing_folder_zip_prompt_enabled: bool =
        existing_settings.get("folder_zip_prompt_enabled");
    let display_name = match update.display_name.as_deref() {
        Some(display_name) => normalize_display_name(Some(display_name)),
        None => existing_display_name,
    };
    let theme_preference = update
        .theme_preference
        .as_deref()
        .and_then(|theme_preference| normalize_theme_preference(Some(theme_preference)))
        .map(str::to_owned)
        .unwrap_or(existing_theme_preference);
    let accent_color = update
        .accent_color
        .as_deref()
        .and_then(|accent_color| normalize_accent_color(Some(accent_color)))
        .unwrap_or(existing_accent_color);
    let folder_zip_prompt_enabled = update
        .folder_zip_prompt_enabled
        .unwrap_or(existing_folder_zip_prompt_enabled);

    if update.remove_profile_image {
        state
            .db
            .execute(
                "
                    UPDATE users
                    SET display_name = $1,
                        theme_preference = $2,
                        accent_color = $3,
                        folder_zip_prompt_enabled = $4,
                        profile_image_bytes = NULL,
                        profile_image_mime_type = NULL,
                        profile_image_size_bytes = NULL,
                        profile_image_updated_at = NULL,
                        updated_at = now()
                    WHERE id = $5
                ",
                &[
                    &display_name,
                    &theme_preference,
                    &accent_color,
                    &folder_zip_prompt_enabled,
                    &user.id,
                ],
            )
            .await
            .map_err(error::ErrorInternalServerError)?;
    } else if let Some(profile_image) = update.profile_image {
        state
            .db
            .execute(
                "
                    UPDATE users
                    SET display_name = $1,
                        theme_preference = $2,
                        accent_color = $3,
                        folder_zip_prompt_enabled = $4,
                        profile_image_bytes = $5,
                        profile_image_mime_type = $6,
                        profile_image_size_bytes = $7,
                        profile_image_updated_at = now(),
                        updated_at = now()
                    WHERE id = $8
                ",
                &[
                    &display_name,
                    &theme_preference,
                    &accent_color,
                    &folder_zip_prompt_enabled,
                    &profile_image.bytes,
                    &profile_image.mime_type,
                    &profile_image.size_bytes,
                    &user.id,
                ],
            )
            .await
            .map_err(error::ErrorInternalServerError)?;
    } else {
        state
            .db
            .execute(
                "
                    UPDATE users
                    SET display_name = $1,
                        theme_preference = $2,
                        accent_color = $3,
                        folder_zip_prompt_enabled = $4,
                        updated_at = now()
                    WHERE id = $5
                ",
                &[
                    &display_name,
                    &theme_preference,
                    &accent_color,
                    &folder_zip_prompt_enabled,
                    &user.id,
                ],
            )
            .await
            .map_err(error::ErrorInternalServerError)?;
    }

    Ok(redirect("/settings?profile=updated"))
}

pub async fn avatar(state: web::Data<AppState>, request: HttpRequest) -> Result<HttpResponse> {
    let user = require_user(&state, &request).await?;
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
