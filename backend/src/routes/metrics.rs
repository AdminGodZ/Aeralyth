use actix_web::http::header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE};
use actix_web::{HttpRequest, HttpResponse, web};

use crate::state::AppState;

pub async fn metrics(state: web::Data<AppState>, request: HttpRequest) -> HttpResponse {
    let Some(token) = state.config.metrics_token.as_deref() else {
        return HttpResponse::NotFound().finish();
    };
    let provided = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if !provided.is_some_and(|provided| constant_time_eq(provided.as_bytes(), token.as_bytes())) {
        return HttpResponse::Unauthorized().finish();
    }

    HttpResponse::Ok()
        .insert_header((CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8"))
        .insert_header((CACHE_CONTROL, "no-store"))
        .body(state.metrics.render(&state.database_pools.statuses()))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
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

#[cfg(test)]
mod tests {
    use super::constant_time_eq;

    #[test]
    fn metrics_tokens_require_an_exact_match() {
        assert!(constant_time_eq(b"correct", b"correct"));
        assert!(!constant_time_eq(b"correct", b"incorrect"));
        assert!(!constant_time_eq(b"short", b"longer"));
    }
}
