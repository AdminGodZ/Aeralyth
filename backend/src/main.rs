mod auth;
mod config;
mod db;
mod e2ee;
mod routes;
mod state;
mod storage;

use actix_web::{App, HttpServer, dev::Service, middleware::Logger, web};
use std::io;
use std::time::Duration;
use tokio::sync::watch;

use config::E2eeMode;
use state::AppState;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    dotenvy::dotenv().ok();
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));

    let config = config::Config::from_env()
        .map_err(|error| io::Error::other(format!("invalid configuration: {error}")))?;
    let bind_addr = config.bind_addr();
    let db = db::Database::create(
        &config.database_url,
        config.database_pool_max,
        Duration::from_millis(config.database_pool_wait_ms),
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
        storage,
    });

    log::info!("starting Aeralyth API on {bind_addr}");

    let server = HttpServer::new(move || {
        App::new()
            .app_data(state.clone())
            .app_data(web::JsonConfig::default().limit(8 * 1024 * 1024))
            .wrap(Logger::default().exclude_regex(r"^/api/share-links/access/"))
            .wrap_fn(|request, service| db::scope_request(service.call(request)))
            .configure(routes::configure)
    })
    .bind(&bind_addr)?
    .run();
    let (maintenance_shutdown, maintenance_shutdown_receiver) = watch::channel(false);
    let maintenance = tokio::spawn(storage::run_maintenance(
        maintenance_db,
        maintenance_storage,
        maintenance_shutdown_receiver,
    ));
    let result = server.await;
    let _ = maintenance_shutdown.send(true);
    if let Err(error) = maintenance.await {
        log::error!("maintenance runtime stopped unexpectedly: {error}");
    }
    result
}
