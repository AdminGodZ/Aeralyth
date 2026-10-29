use actix_web::http::header::{CACHE_CONTROL, CONTENT_TYPE, ETAG, IF_NONE_MATCH};
use actix_web::{HttpRequest, HttpResponse, Result};
use time::OffsetDateTime;

use super::conditional::etag_matches;
use crate::state::AppState;

const VERSIONED_AVATAR_CACHE_CONTROL: &str = "private, max-age=31536000, immutable";
const UNVERSIONED_AVATAR_CACHE_CONTROL: &str = "private, no-cache";
// IS NOT NULL reads the null bitmap; it does not detoast the image.
const AVATAR_VERSION_QUERY: &str = "
    SELECT COALESCE(profile_image_updated_at, updated_at) AS profile_image_version_at
    FROM users
    WHERE id = $1
      AND profile_image_bytes IS NOT NULL
    LIMIT 1
";
const AVATAR_QUERY: &str = "
    SELECT profile_image_bytes, profile_image_mime_type,
           COALESCE(profile_image_updated_at, updated_at)
             AS profile_image_version_at
    FROM users
    WHERE id = $1
      AND profile_image_bytes IS NOT NULL
    LIMIT 1
";

/// Unversioned avatar URLs revalidate on every page view. Compare the ETag
/// against the stored version first, so a match never loads up to 2 MB of image.
pub async fn load(
    state: &AppState,
    request: &HttpRequest,
    user_id: &str,
    version_of: fn(OffsetDateTime) -> String,
) -> Result<HttpResponse> {
    let Some(row) = state
        .db
        .query_opt(AVATAR_VERSION_QUERY, &[&user_id])
        .await
        .map_err(crate::db::http_error)?
    else {
        return Ok(HttpResponse::NotFound().finish());
    };
    if let Some(response) = not_modified(request, &version_of(row.get("profile_image_version_at")))
    {
        return Ok(response);
    }

    // Read the image and its version together so a concurrent change cannot
    // pair new bytes with the old ETag.
    let Some(row) = state
        .db
        .query_opt(AVATAR_QUERY, &[&user_id])
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
    Ok(response(
        request,
        bytes,
        mime_type.unwrap_or_else(|| "application/octet-stream".to_owned()),
        &version_of(row.get("profile_image_version_at")),
    ))
}

fn cache_control(request: &HttpRequest, version: &str) -> &'static str {
    if request
        .query_string()
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .any(|(name, value)| name == "v" && value == version)
    {
        VERSIONED_AVATAR_CACHE_CONTROL
    } else {
        UNVERSIONED_AVATAR_CACHE_CONTROL
    }
}

fn not_modified(request: &HttpRequest, version: &str) -> Option<HttpResponse> {
    let etag = format!("\"avatar-{version}\"");
    request
        .headers()
        .get(IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| etag_matches(value, &etag))
        .then(|| {
            HttpResponse::NotModified()
                .insert_header((CACHE_CONTROL, cache_control(request, version)))
                .insert_header((ETAG, etag))
                .finish()
        })
}

fn response(
    request: &HttpRequest,
    bytes: Vec<u8>,
    mime_type: String,
    version: &str,
) -> HttpResponse {
    if let Some(response) = not_modified(request, version) {
        return response;
    }

    HttpResponse::Ok()
        .insert_header((CONTENT_TYPE, mime_type))
        .insert_header((CACHE_CONTROL, cache_control(request, version)))
        .insert_header((ETAG, format!("\"avatar-{version}\"")))
        .body(bytes)
}

#[cfg(test)]
mod tests {
    use actix_web::http::header::{CACHE_CONTROL, ETAG, IF_NONE_MATCH};
    use actix_web::{http::StatusCode, test as actix_test};

    use super::{AVATAR_QUERY, AVATAR_VERSION_QUERY, response};

    #[test]
    fn revalidation_reads_the_version_without_the_image() {
        assert!(!AVATAR_VERSION_QUERY.contains("SELECT profile_image_bytes"));
        assert!(AVATAR_VERSION_QUERY.contains("profile_image_bytes IS NOT NULL"));
        assert!(AVATAR_QUERY.contains("SELECT profile_image_bytes"));
        let source = include_str!("avatar.rs");
        let load = source
            .split_once("pub async fn load(")
            .and_then(|(_, tail)| tail.split_once("fn cache_control("))
            .map(|(load, _)| load)
            .expect("avatar loader should remain inspectable");
        let version = load.find("AVATAR_VERSION_QUERY").unwrap();
        let revalidated = load.find("not_modified(").unwrap();
        let image = load.find("AVATAR_QUERY").unwrap();
        assert!(version < revalidated && revalidated < image);
    }

    #[test]
    fn versioned_avatar_is_private_and_immutable() {
        let request = actix_test::TestRequest::get()
            .uri("/api/profile/avatar?v=20260825070000001")
            .to_http_request();
        let response = response(
            &request,
            vec![1, 2, 3],
            "image/png".to_owned(),
            "20260825070000001",
        );

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(CACHE_CONTROL).unwrap(),
            "private, max-age=31536000, immutable"
        );
        assert_eq!(
            response.headers().get(ETAG).unwrap(),
            "\"avatar-20260825070000001\""
        );
    }

    #[test]
    fn matching_etag_returns_no_avatar_body() {
        let request = actix_test::TestRequest::get()
            .uri("/api/profile/avatar?v=20260825070000001")
            .insert_header((IF_NONE_MATCH, "W/\"avatar-20260825070000001\""))
            .to_http_request();
        let response = response(
            &request,
            vec![1, 2, 3],
            "image/png".to_owned(),
            "20260825070000001",
        );

        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    }

    #[test]
    fn unversioned_avatar_must_revalidate() {
        let request = actix_test::TestRequest::get()
            .uri("/api/profile/avatar")
            .to_http_request();
        let response = response(
            &request,
            vec![1, 2, 3],
            "image/png".to_owned(),
            "20260825070000001",
        );

        assert_eq!(
            response.headers().get(CACHE_CONTROL).unwrap(),
            "private, no-cache"
        );
    }
}
