mod auth;
mod bucket_usage;
mod collection_timestamps;
mod config;
mod db;
mod e2ee;
mod observability;
mod passwords;
mod realtime;
mod routes;
mod state;
mod storage;
#[cfg(test)]
mod test_allocations;
mod timestamps;
mod upload_completion;
mod vault_wire;

use actix_web::{App, HttpServer, web};
use std::io;
use std::time::Duration;
use tokio::sync::watch;

use config::E2eeMode;
use state::{
    AppState, AsyncOperationService, MutationLimiter, QueuedMutationLimiter, ReadinessCache,
    VaultValidationService,
};

const HTTP_HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_DISCONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const HTTP_KEEP_ALIVE: Duration = Duration::from_secs(75);
const HTTP_SHUTDOWN_TIMEOUT_SECONDS: u64 = 30;
const REQUIRED_E2EE_READY_QUERY: &str = "
    SELECT EXISTS (
      SELECT 1
      FROM files
      WHERE e2ee_state IN ('legacy', 'staged')
      LIMIT 1
    ) OR EXISTS (
      SELECT 1
      FROM vault_migrations
      WHERE state <> 'complete'
      LIMIT 1
    ) AS has_pending
";

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    dotenvy::dotenv().ok();

    let config = config::Config::from_env()
        .map_err(|error| io::Error::other(format!("invalid configuration: {error}")))?;
    let _logging_guard = observability::init_logging(&config)
        .map_err(|error| io::Error::other(format!("failed to initialize logging: {error}")))?;
    let metrics = observability::Metrics::new(&config);
    let bind_addr = config.bind_addr();
    let request_pool_settings = db::DatabasePoolSettings {
        role: db::PoolRole::Request,
        max_size: config.database_pool_max,
        min_size: config.database_pool_min,
        checkout_queue_capacity: config.database_pool_queue_capacity,
        wait_timeout: Duration::from_millis(config.database_pool_wait_ms),
        max_lifetime: Duration::from_secs(config.database_connection_max_lifetime_seconds),
        lifetime_jitter: Duration::from_secs(config.database_connection_lifetime_jitter_seconds),
    };
    let db = db::Database::create(&config.database_url, request_pool_settings, metrics.clone())
        .await
        .map_err(|error| io::Error::other(format!("failed to connect to postgres: {error}")))?;
    if config.e2ee_mode == E2eeMode::Required {
        let row = db
            .query_one(REQUIRED_E2EE_READY_QUERY, &[])
            .await
            .map_err(|error| {
                io::Error::other(format!(
                    "failed to verify required E2EE migration state: {error}"
                ))
            })?;
        let has_pending: bool = row.get("has_pending");
        if has_pending {
            return Err(io::Error::other(
                "AERALYTH_E2EE_MODE=required refused to start with legacy or incomplete nodes",
            ));
        }
    }
    let storage = storage::Storage::create(&config, metrics.clone())
        .await
        .map_err(|error| io::Error::other(format!("failed to initialize storage: {error}")))?;
    let maintenance_db = db::Database::create(
        &config.database_url,
        db::DatabasePoolSettings {
            role: db::PoolRole::Maintenance,
            max_size: config.database_maintenance_pool_max,
            min_size: config.database_maintenance_pool_min,
            checkout_queue_capacity: config.database_maintenance_pool_queue_capacity,
            ..request_pool_settings
        },
        metrics.clone(),
    )
    .await
    .map_err(|error| {
        io::Error::other(format!(
            "failed to connect maintenance pool to postgres: {error}"
        ))
    })?;
    let database_pools = db::DatabasePoolMonitor::new(&db, &maintenance_db);
    let passwords =
        passwords::PasswordService::new(config.password_workers, config.password_queue_capacity)
            .map_err(|error| {
                io::Error::other(format!("failed to initialize password workers: {error}"))
            })?;
    let login_rate_limiter = passwords::LoginRateLimiter::new(
        Duration::from_secs(60),
        config.login_attempts_per_address_minute,
        config.login_attempts_per_account_minute,
    );
    let storage_maintenance_concurrency = config.storage_maintenance_concurrency;
    let maintenance_database_url = config.database_url.clone();
    let maintenance_storage = storage.clone();
    let realtime_hub = realtime::RealtimeHub::new();
    let realtime_database_url = config.database_url.clone();
    let (interactive_operation_limiter, recursive_operation_limiter) =
        QueuedMutationLimiter::partition(
            config.recursive_operation_concurrency,
            config.recursive_operation_per_user,
            config.recursive_operation_queue_capacity,
            config.recursive_operation_per_user_queue_capacity,
        );
    let cpu_workers = std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(4)
        .saturating_sub(1)
        .clamp(1, 8);
    let (interactive_validation, vault_validation) =
        VaultValidationService::partition(cpu_workers, 2, 32, 8);
    let interactive_validation =
        interactive_validation.observed(metrics.clone(), "interactive_cpu");
    let vault_validation = vault_validation.observed(metrics.clone(), "publication_cpu");
    let state = web::Data::new(AppState {
        config: config.clone(),
        db,
        database_pools,
        database_readiness: ReadinessCache::new(Duration::from_secs(2)),
        metrics: metrics.clone(),
        passwords,
        login_rate_limiter,
        storage,
        bucket_usage: bucket_usage::BucketUsageCache::new(maintenance_db.clone()),
        realtime: realtime_hub.clone(),
        upload_control_limiter: MutationLimiter::new(
            config.upload_control_concurrency,
            config.upload_control_per_user,
        ),
        recursive_operation_limiter,
        interactive_operation_limiter,
        storage_operations: AsyncOperationService::new(
            config.storage_operation_concurrency,
            config.storage_operation_per_user,
            config.storage_operation_queue_capacity,
            config.storage_operation_per_user_queue_capacity,
        ),
        vault_validation,
        interactive_validation,
    });

    tracing::info!(bind_addr, "starting Aeralyth API");

    let server_metrics = metrics.clone();
    let realtime_metrics = metrics.clone();
    let maintenance_metrics = metrics;
    let server = HttpServer::new(move || {
        let request_metrics = server_metrics.clone();
        App::new()
            .app_data(state.clone())
            .app_data(web::Data::new(request_metrics))
            .wrap(actix_web::middleware::from_fn(
                observability::observe_request,
            ))
            .configure(routes::configure)
    })
    .client_request_timeout(HTTP_HEADER_TIMEOUT)
    .client_disconnect_timeout(HTTP_DISCONNECT_TIMEOUT)
    .keep_alive(HTTP_KEEP_ALIVE)
    .shutdown_timeout(HTTP_SHUTDOWN_TIMEOUT_SECONDS)
    .bind(&bind_addr)?
    .run();
    let (maintenance_shutdown, maintenance_shutdown_receiver) = watch::channel(false);
    let realtime = tokio::spawn(realtime::run(
        realtime_hub,
        realtime_database_url,
        maintenance_shutdown_receiver.clone(),
        realtime_metrics,
    ));
    let tree_jobs = tokio::spawn(routes::tree_jobs::run(
        maintenance_db.clone(),
        maintenance_shutdown_receiver.clone(),
    ));
    let maintenance = tokio::spawn(storage::run_maintenance(
        maintenance_db,
        maintenance_storage,
        maintenance_metrics,
        maintenance_database_url,
        maintenance_shutdown_receiver,
        storage_maintenance_concurrency,
    ));
    let result = server.await;
    let _ = maintenance_shutdown.send(true);
    if let Err(error) = realtime.await {
        tracing::error!(%error, "realtime runtime stopped unexpectedly");
    }
    if let Err(error) = tree_jobs.await {
        tracing::error!(%error, "tree jobs runtime stopped unexpectedly");
    }
    if let Err(error) = maintenance.await {
        tracing::error!(%error, "maintenance runtime stopped unexpectedly");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::REQUIRED_E2EE_READY_QUERY;

    #[test]
    fn maintenance_uses_an_independent_database_pool() {
        let source = include_str!("main.rs");
        let forbidden_clone = ["maintenance_db = ", "db.clone()"].concat();

        assert!(source.contains("role: db::PoolRole::Request"));
        assert!(source.contains("role: db::PoolRole::Maintenance"));
        assert!(source.matches("db::Database::create(").count() >= 2);
        assert!(!source.contains(&forbidden_clone));
    }

    #[test]
    fn http_lifetimes_are_explicit_without_cancelling_handler_futures() {
        let source = include_str!("main.rs");
        let blanket_handler_timeout = ["tokio::time::timeout(", "service.call"].concat();

        assert!(source.contains(".client_request_timeout(HTTP_HEADER_TIMEOUT)"));
        assert!(source.contains(".client_disconnect_timeout(HTTP_DISCONNECT_TIMEOUT)"));
        assert!(source.contains(".keep_alive(HTTP_KEEP_ALIVE)"));
        assert!(source.contains(".shutdown_timeout(HTTP_SHUTDOWN_TIMEOUT_SECONDS)"));
        assert!(!source.contains(&blanket_handler_timeout));
    }

    #[test]
    fn required_e2ee_startup_uses_flat_indexed_existence_checks() {
        let normalized = REQUIRED_E2EE_READY_QUERY.to_ascii_lowercase();

        assert_eq!(normalized.matches("exists (").count(), 2);
        assert!(normalized.contains("e2ee_state in ('legacy', 'staged')"));
        assert!(normalized.contains("state <> 'complete'"));
        assert!(!normalized.contains("count("));
        assert!(!normalized.contains("distinct"));
        assert!(!normalized.contains("union"));
    }
}
