use actix_web::http::header::{CACHE_CONTROL, CONTENT_TYPE, ETAG, IF_NONE_MATCH};
use actix_web::{HttpRequest, HttpResponse, Result, error};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use sha2::{Digest, Sha256};

const PRIVATE_REVALIDATE: &str = "private, no-cache";

/// A validator for a representation whose complete revision is already known.
///
/// Construct this only after authenticating and authorizing the current request.
/// `revision` must include every value that can change the response, including
/// asynchronously refreshed counters. A route must change `namespace` when its
/// serialization contract changes. The request path and exact query string are
/// included here so folder, ordering, filters, and pagination cannot share a tag.
/// This stores neither session credentials nor response data between requests.
pub struct PrivateRevision {
    etag: String,
}

impl PrivateRevision {
    pub fn new<A: Serialize, R: Serialize>(
        request: &HttpRequest,
        namespace: &str,
        authorization_scope: &A,
        revision: &R,
    ) -> Result<Self> {
        let revision = serde_json::to_vec(&(
            namespace,
            request.method().as_str(),
            request.uri().path_and_query().map(|value| value.as_str()),
            authorization_scope,
            revision,
        ))
        .map_err(error::ErrorInternalServerError)?;
        let digest = Sha256::digest(&revision);
        Ok(Self {
            // A revision proves semantic equivalence, rather than byte-for-byte
            // identity across serializers or content-encoding middleware.
            etag: format!("W/\"{}\"", URL_SAFE_NO_PAD.encode(digest)),
        })
    }

    /// Call before loading children, aggregates, or other expensive response data.
    pub fn not_modified(&self, request: &HttpRequest) -> Option<HttpResponse> {
        request
            .headers()
            .get(IF_NONE_MATCH)
            .and_then(|value| value.to_str().ok())
            .filter(|value| etag_matches(value, &self.etag))
            .map(|_| {
                HttpResponse::NotModified()
                    .insert_header((CACHE_CONTROL, PRIVATE_REVALIDATE))
                    .insert_header((ETAG, self.etag.as_str()))
                    .finish()
            })
    }

    pub fn json<T: Serialize>(&self, value: &T) -> Result<HttpResponse> {
        let body = serde_json::to_vec(value).map_err(error::ErrorInternalServerError)?;
        Ok(HttpResponse::Ok()
            .insert_header((CONTENT_TYPE, "application/json"))
            .insert_header((CACHE_CONTROL, PRIVATE_REVALIDATE))
            .insert_header((ETAG, self.etag.as_str()))
            .body(body))
    }
}

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

pub(super) fn etag_matches(header: &str, etag: &str) -> bool {
    let etag = etag.strip_prefix("W/").unwrap_or(etag);
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

    use super::{PrivateRevision, private_json};

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

    #[test]
    fn revision_hit_returns_before_response_assembly() {
        let request = actix_test::TestRequest::get()
            .uri("/api/repositories/repo-1?folder=folder-1&cursor=page-2")
            .to_http_request();
        let revision =
            PrivateRevision::new(&request, "repository-detail-v1", &"alice", &7).unwrap();
        let response = revision.json(&Example { version: 1 }).unwrap();
        let conditional = actix_test::TestRequest::get()
            .uri(request.uri().to_string().as_str())
            .insert_header((IF_NONE_MATCH, response.headers().get(ETAG).unwrap().clone()))
            .to_http_request();
        let revision =
            PrivateRevision::new(&conditional, "repository-detail-v1", &"alice", &7).unwrap();

        // This is the route's control flow. Neither the expensive loader nor
        // the response's serializer may run when the authorized revision matches.
        let response = if let Some(response) = revision.not_modified(&conditional) {
            response
        } else {
            panic!("unchanged revision reached the response loader")
        };
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(
            response.headers().get(CACHE_CONTROL).unwrap(),
            "private, no-cache"
        );
    }

    #[test]
    fn revision_validator_binds_permissions_content_counters_and_query_scope() {
        let request = actix_test::TestRequest::get()
            .uri("/api/repositories/repo-1?folder=a&cursor=one")
            .to_http_request();
        let first = PrivateRevision::new(
            &request,
            "repository-detail-v1",
            &("alice", "user"),
            &(7, 4, 12),
        )
        .unwrap();
        let conditional = actix_test::TestRequest::get()
            .uri(request.uri().to_string().as_str())
            .insert_header((IF_NONE_MATCH, first.etag.clone()))
            .to_http_request();

        for (owner, role, content, counts, total) in [
            ("bob", "user", 7, 4, 12),
            ("alice", "admin", 7, 4, 12),
            ("alice", "user", 8, 4, 12),
            ("alice", "user", 7, 5, 12),
            ("alice", "user", 7, 4, 13),
        ] {
            let changed = PrivateRevision::new(
                &conditional,
                "repository-detail-v1",
                &(owner, role),
                &(content, counts, total),
            )
            .unwrap();
            assert!(changed.not_modified(&conditional).is_none());
        }

        for uri in [
            "/api/repositories/repo-2?folder=a&cursor=one",
            "/api/repositories/repo-1?folder=b&cursor=one",
            "/api/repositories/repo-1?folder=a&cursor=two",
            "/api/repositories/repo-1?folder=a&cursor=one&sort=name",
            "/api/repositories/repo-1?folder=a&cursor=one&filter=files",
        ] {
            let changed_request = actix_test::TestRequest::get()
                .uri(uri)
                .insert_header((IF_NONE_MATCH, first.etag.clone()))
                .to_http_request();
            let changed = PrivateRevision::new(
                &changed_request,
                "repository-detail-v1",
                &("alice", "user"),
                &(7, 4, 12),
            )
            .unwrap();
            assert!(changed.not_modified(&changed_request).is_none());
        }
    }

    #[test]
    fn weak_and_strong_etags_use_weak_comparison_for_get_revalidation() {
        for header in [
            "\"revision\"",
            "W/\"revision\"",
            "\"other\", W/\"revision\"",
            "*",
        ] {
            assert!(super::etag_matches(header, "W/\"revision\""));
            assert!(super::etag_matches(header, "\"revision\""));
        }
        assert!(!super::etag_matches("W/\"other\"", "W/\"revision\""));
    }
}
