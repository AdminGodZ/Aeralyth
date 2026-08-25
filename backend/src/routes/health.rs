use actix_web::{HttpResponse, web};
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
struct LiveResponse {
    status: &'static str,
    service: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
struct ReadyResponse {
    status: &'static str,
    service: &'static str,
    version: &'static str,
    database_configured: bool,
    database_source: &'static str,
    storage_configured: bool,
    database_pool_max: usize,
    database_pool_size: usize,
    database_pool_available: usize,
    database_pool_waiting: usize,
}

pub async fn live() -> HttpResponse {
    HttpResponse::Ok().json(LiveResponse {
        status: "ok",
        service: "aeralyth-api",
        version: env!("CARGO_PKG_VERSION"),
    })
}

pub async fn ready(state: web::Data<AppState>) -> HttpResponse {
    let database_ready = state
        .database_readiness
        .get_or_check(|| async { state.db.ping().await.is_ok() })
        .await;
    let pool = state.db.status();
    let response = ReadyResponse {
        status: if database_ready { "ok" } else { "unavailable" },
        service: "aeralyth-api",
        version: env!("CARGO_PKG_VERSION"),
        database_configured: state.config.database_url_configured,
        database_source: if state.config.database_url_configured {
            "environment"
        } else {
            "local-default"
        },
        storage_configured: matches!(state.config.storage_backend.as_str(), "local" | "s3"),
        database_pool_max: pool.max_size,
        database_pool_size: pool.size,
        database_pool_available: pool.available,
        database_pool_waiting: pool.waiting,
    };

    if database_ready {
        HttpResponse::Ok().json(response)
    } else {
        HttpResponse::ServiceUnavailable().json(response)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use std::time::Duration;

    use crate::state::ReadinessCache;

    #[test]
    fn liveness_handler_is_dependency_free() {
        let source = include_str!("health.rs");
        let live = source
            .split_once("pub async fn live()")
            .and_then(|(_, tail)| tail.split_once("pub async fn ready("))
            .map(|(handler, _)| handler)
            .expect("liveness handler should remain inspectable");

        assert!(!live.contains("AppState"));
        assert!(!live.contains(".db"));
        assert!(!live.contains("ping("));
    }

    #[actix_web::test]
    async fn readiness_reuses_one_check_within_its_ttl() {
        let checks = Arc::new(AtomicUsize::new(0));
        let cache = ReadinessCache::new(Duration::from_secs(60));
        let first_checks = Arc::clone(&checks);
        let first = cache
            .get_or_check(|| async move {
                first_checks.fetch_add(1, Ordering::Relaxed);
                true
            })
            .await;
        let second_checks = Arc::clone(&checks);
        let second = cache
            .get_or_check(|| async move {
                second_checks.fetch_add(1, Ordering::Relaxed);
                false
            })
            .await;

        assert!(first && second);
        assert_eq!(checks.load(Ordering::Relaxed), 1);
    }
}
