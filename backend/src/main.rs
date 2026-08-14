mod auth;
mod config;
mod db;
mod e2ee;
mod observability;
mod routes;
mod state;
mod storage;
mod upload_completion;

use actix_web::http::header::{CONTENT_LENGTH, HeaderName, HeaderValue};
use actix_web::{App, HttpServer, dev::Service, web};
use std::io;
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tracing::Instrument;

use config::E2eeMode;
use state::{AppState, MutationLimiter};

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    dotenvy::dotenv().ok();

    let config = config::Config::from_env()
        .map_err(|error| io::Error::other(format!("invalid configuration: {error}")))?;
    observability::init_logging(&config)
        .map_err(|error| io::Error::other(format!("failed to initialize logging: {error}")))?;
    let metrics = observability::Metrics::new(&config);
    let bind_addr = config.bind_addr();
    let db = db::Database::create(
        &config.database_url,
        config.database_pool_max,
        Duration::from_millis(config.database_pool_wait_ms),
        metrics.clone(),
    )
    .await
    .map_err(|error| io::Error::other(format!("failed to connect to postgres: {error}")))?;
    if config.e2ee_mode == E2eeMode::Required {
        let row = db
            .query_one(
                "
                    SELECT count(DISTINCT pending.node_id)::bigint AS remaining
                    FROM (
                      SELECT id AS node_id FROM files WHERE e2ee_state <> 'encrypted'
                      UNION ALL
                      SELECT node_id FROM vault_migrations WHERE state <> 'complete'
                    ) AS pending
                ",
                &[],
            )
            .await
            .map_err(|error| {
                io::Error::other(format!(
                    "failed to verify required E2EE migration state: {error}"
                ))
            })?;
        let remaining: i64 = row.get("remaining");
        if remaining != 0 {
            return Err(io::Error::other(format!(
                "AERALYTH_E2EE_MODE=required refused to start with {remaining} legacy or incomplete nodes"
            )));
        }
    }
    let storage = storage::Storage::create(&config)
        .await
        .map_err(|error| io::Error::other(format!("failed to initialize storage: {error}")))?;
    let maintenance_db = db.clone();
    let maintenance_storage = storage.clone();
    let state = web::Data::new(AppState {
        config: config.clone(),
        db,
        metrics: metrics.clone(),
        storage,
        vault_mutation_limiter: MutationLimiter::new(8, 3),
    });

    tracing::info!(bind_addr, "starting Aeralyth API");

    let server_metrics = metrics.clone();
    let maintenance_metrics = metrics;
    let server = HttpServer::new(move || {
        let request_metrics = server_metrics.clone();
        App::new()
            .app_data(state.clone())
            .wrap_fn(move |request, service| {
                let metrics = request_metrics.clone();
                let method = request.method().as_str().to_owned();
                let request_bytes = request
                    .headers()
                    .get(CONTENT_LENGTH)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(0);
                let request_id = metrics.next_request_id();
                let request_span = tracing::info_span!(
                    "http_request",
                    request_id = %request_id,
                    method = %method,
                    route = tracing::field::Empty,
                    status = tracing::field::Empty,
                );
                let execution_span = request_span.clone();
                let started = Instant::now();
                let future = service.call(request);
                async move {
                    let (result, database_checkouts) = db::scope_request(future).await;
                    let duration = started.elapsed();
                    match result {
                        Ok(mut response) => {
                            let route = response
                                .request()
                                .match_pattern()
                                .unwrap_or_else(|| "unmatched".to_owned());
                            let status = response.status().as_u16();
                            let response_bytes = response
                                .headers()
                                .get(CONTENT_LENGTH)
                                .and_then(|value| value.to_str().ok())
                                .and_then(|value| value.parse::<u64>().ok())
                                .unwrap_or(0);
                            request_span.record("route", route.as_str());
                            request_span.record("status", status);
                            let observation = observability::RequestObservation {
                                method: &method,
                                route: &route,
                                status,
                                duration,
                                request_bytes,
                                response_bytes,
                                database_checkouts,
                            };
                            metrics.record_request(&observation);
                            metrics.log_request(&request_id, &observation);
                            response.response_mut().headers_mut().insert(
                                HeaderName::from_static("x-request-id"),
                                HeaderValue::from_str(&request_id)
                                    .expect("generated request IDs are valid headers"),
                            );
                            response.response_mut().headers_mut().insert(
                                HeaderName::from_static("server-timing"),
                                HeaderValue::from_str(&format!(
                                    "app;dur={:.3}",
                                    duration.as_secs_f64() * 1_000.0,
                                ))
                                .expect("server timing is a valid header"),
                            );
                            Ok(response)
                        }
                        Err(error) => {
                            request_span.record("route", "middleware_error");
                            request_span.record("status", 500_u16);
                            let observation = observability::RequestObservation {
                                method: &method,
                                route: "middleware_error",
                                status: 500,
                                duration,
                                request_bytes,
                                response_bytes: 0,
                                database_checkouts,
                            };
                            metrics.record_request(&observation);
                            metrics.log_request(&request_id, &observation);
                            Err(error)
                        }
                    }
                }
                .instrument(execution_span)
            })
            .configure(routes::configure)
    })
    .bind(&bind_addr)?
    .run();
    let (maintenance_shutdown, maintenance_shutdown_receiver) = watch::channel(false);
    let maintenance = tokio::spawn(storage::run_maintenance(
        maintenance_db,
        maintenance_storage,
        maintenance_metrics,
        maintenance_shutdown_receiver,
    ));
    let result = server.await;
    let _ = maintenance_shutdown.send(true);
    if let Err(error) = maintenance.await {
        tracing::error!(%error, "maintenance runtime stopped unexpectedly");
    }
    result
}
