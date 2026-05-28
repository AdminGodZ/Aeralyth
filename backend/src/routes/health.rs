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
}

pub async fn health(state: web::Data<AppState>) -> HttpResponse {
    HttpResponse::Ok().json(HealthResponse {
        status: "ok",
        service: "aeralyth-api",
        version: env!("CARGO_PKG_VERSION"),
        database_configured: state.config.database_url_configured,
        database_source: if state.config.database_url_configured {
            "environment"
        } else {
            "local-default"
        },
        storage_configured: !state.config.storage_path.trim().is_empty(),
    })
}
