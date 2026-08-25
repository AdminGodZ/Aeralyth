use actix_web::http::header::{CACHE_CONTROL, CONTENT_TYPE, ETAG, IF_NONE_MATCH};
use actix_web::{HttpRequest, HttpResponse, Result, error};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use sha2::{Digest, Sha256};

const PRIVATE_REVALIDATE: &str = "private, no-cache";

pub fn private_json<T: Serialize>(request: &HttpRequest, value: &T) -> Result<HttpResponse> {
    let body = serde_json::to_vec(value).map_err(error::ErrorInternalServerError)?;
    let digest = Sha256::digest(&body);
    let etag = format!("\"{}\"", URL_SAFE_NO_PAD.encode(digest));

    if request
        .headers()
        .get(IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| etag_matches(value, &etag))
    {
        return Ok(HttpResponse::NotModified()
            .insert_header((CACHE_CONTROL, PRIVATE_REVALIDATE))
            .insert_header((ETAG, etag))
            .finish());
    }

    Ok(HttpResponse::Ok()
        .insert_header((CONTENT_TYPE, "application/json"))
        .insert_header((CACHE_CONTROL, PRIVATE_REVALIDATE))
        .insert_header((ETAG, etag))
        .body(body))
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
    use serde::Serialize;

    use super::private_json;

    #[derive(Serialize)]
    struct Example {
        version: u8,
    }

    #[test]
    fn authenticated_metadata_revalidates_by_exact_representation() {
        let request = actix_test::TestRequest::get().to_http_request();
        let first = private_json(&request, &Example { version: 1 }).unwrap();
        let etag = first.headers().get(ETAG).unwrap().clone();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(
            first.headers().get(CACHE_CONTROL).unwrap(),
            "private, no-cache"
        );

        let conditional = actix_test::TestRequest::get()
            .insert_header((IF_NONE_MATCH, etag))
            .to_http_request();
        let unchanged = private_json(&conditional, &Example { version: 1 }).unwrap();
        let changed = private_json(&conditional, &Example { version: 2 }).unwrap();
        assert_eq!(unchanged.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(changed.status(), StatusCode::OK);
    }
}
