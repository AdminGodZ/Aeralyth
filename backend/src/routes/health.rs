use actix_web::{HttpResponse, web};
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
struct HealthResponse {
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

pub async fn health(state: web::Data<AppState>) -> HttpResponse {
    let database_ready = state.db.ping().await.is_ok();
    let pool = state.db.status();
    let response = HealthResponse {
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
