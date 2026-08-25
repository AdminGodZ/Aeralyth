use actix_web::http::header::{CACHE_CONTROL, CONTENT_TYPE, ETAG, IF_NONE_MATCH};
use actix_web::{HttpRequest, HttpResponse};

const VERSIONED_AVATAR_CACHE_CONTROL: &str = "private, max-age=31536000, immutable";
const UNVERSIONED_AVATAR_CACHE_CONTROL: &str = "private, no-cache";

pub fn response(
    request: &HttpRequest,
    bytes: Vec<u8>,
    mime_type: String,
    version: &str,
) -> HttpResponse {
    let etag = format!("\"avatar-{version}\"");
    let cache_control = if request
        .query_string()
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .any(|(name, value)| name == "v" && value == version)
    {
        VERSIONED_AVATAR_CACHE_CONTROL
    } else {
        UNVERSIONED_AVATAR_CACHE_CONTROL
    };

    if request
        .headers()
        .get(IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| etag_matches(value, &etag))
    {
        return HttpResponse::NotModified()
            .insert_header((CACHE_CONTROL, cache_control))
            .insert_header((ETAG, etag))
            .finish();
    }

    HttpResponse::Ok()
        .insert_header((CONTENT_TYPE, mime_type))
        .insert_header((CACHE_CONTROL, cache_control))
        .insert_header((ETAG, etag))
        .body(bytes)
}

fn etag_matches(header: &str, etag: &str) -> bool {
    header.split(',').any(|candidate| {
        let candidate = candidate.trim();
        candidate == "*" || candidate.strip_prefix("W/").unwrap_or(candidate) == etag
    })
}

#[cfg(test)]
mod tests {
    use actix_web::http::header::{CACHE_CONTROL, ETAG, IF_NONE_MATCH};
    use actix_web::{http::StatusCode, test as actix_test};

    use super::response;

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
