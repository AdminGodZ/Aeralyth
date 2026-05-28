use actix_web::{web, HttpResponse};
use serde::Serialize;

use crate::config::Config;

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
    version: &'static str,
    database_configured: bool,
    storage_configured: bool,
}

pub async fn health(config: web::Data<Config>) -> HttpResponse {
    HttpResponse::Ok().json(HealthResponse {
        status: "ok",
        service: "aeralyth-api",
        version: env!("CARGO_PKG_VERSION"),
        database_configured: config.database_url.is_some(),
        storage_configured: !config.storage_path.trim().is_empty(),
    })
}
