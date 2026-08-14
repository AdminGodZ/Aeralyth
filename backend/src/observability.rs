use std::collections::BTreeMap;
use std::error::Error as StdError;
use std::fmt::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use deadpool_postgres::Status as PoolStatus;
use tracing_subscriber::EnvFilter;

use crate::config::Config;

const DURATION_BUCKETS_SECONDS: [f64; 11] = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];

#[derive(Clone)]
pub struct Metrics {
    inner: Arc<MetricsInner>,
}

struct MetricsInner {
    started_at: Instant,
    request_sequence: AtomicU64,
    success_log_sequence: AtomicU64,
    success_sample_rate: u64,
    slow_request: Duration,
    http: Mutex<BTreeMap<HttpKey, HttpStats>>,
    pool_checkout: Mutex<BTreeMap<String, DurationStats>>,
    pool_connections_created: Mutex<BTreeMap<String, u64>>,
    pool_lifetime_recycles: Mutex<BTreeMap<String, u64>>,
    maintenance: Mutex<BTreeMap<String, DurationStats>>,
    maintenance_restarts: Mutex<BTreeMap<String, u64>>,
}

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
struct HttpKey {
    method: String,
    route: String,
    status: u16,
}

#[derive(Default)]
struct HttpStats {
    duration: DurationStats,
    database_checkouts: u64,
    request_bytes: u64,
    response_bytes: u64,
}

#[derive(Default)]
struct DurationStats {
    count: u64,
    failures: u64,
    total_seconds: f64,
    buckets: [u64; DURATION_BUCKETS_SECONDS.len()],
}

pub struct RequestObservation<'a> {
    pub method: &'a str,
    pub route: &'a str,
    pub status: u16,
    pub duration: Duration,
    pub request_bytes: u64,
    pub response_bytes: u64,
    pub database_checkouts: usize,
}

impl Metrics {
    pub fn new(config: &Config) -> Self {
        Self {
            inner: Arc::new(MetricsInner {
                started_at: Instant::now(),
                request_sequence: AtomicU64::new(1),
                success_log_sequence: AtomicU64::new(0),
                success_sample_rate: config.request_success_sample_rate as u64,
                slow_request: Duration::from_millis(config.request_slow_ms),
                http: Mutex::new(BTreeMap::new()),
                pool_checkout: Mutex::new(BTreeMap::new()),
                pool_connections_created: Mutex::new(BTreeMap::new()),
                pool_lifetime_recycles: Mutex::new(BTreeMap::new()),
                maintenance: Mutex::new(BTreeMap::new()),
                maintenance_restarts: Mutex::new(BTreeMap::new()),
            }),
        }
    }

    pub fn next_request_id(&self) -> String {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let sequence = self.inner.request_sequence.fetch_add(1, Ordering::Relaxed);
        format!("{timestamp:x}-{sequence:x}")
    }

    pub fn record_request(&self, observation: &RequestObservation<'_>) {
        let key = HttpKey {
            method: observation.method.to_owned(),
            route: observation.route.to_owned(),
            status: observation.status,
        };
        let mut http = lock_unpoisoned(&self.inner.http);
        let stats = http.entry(key).or_default();
        stats
            .duration
            .record(observation.duration, observation.status >= 500);
        stats.database_checkouts = stats
            .database_checkouts
            .saturating_add(observation.database_checkouts as u64);
        stats.request_bytes = stats
            .request_bytes
            .saturating_add(observation.request_bytes);
        stats.response_bytes = stats
            .response_bytes
            .saturating_add(observation.response_bytes);
    }

    pub fn log_request(&self, request_id: &str, observation: &RequestObservation<'_>) {
        let duration_ms = observation.duration.as_secs_f64() * 1_000.0;
        if observation.status >= 500 {
            tracing::error!(
                request_id,
                method = observation.method,
                route = observation.route,
                status = observation.status,
                duration_ms,
                database_checkouts = observation.database_checkouts,
                "request failed"
            );
        } else if observation.duration >= self.inner.slow_request {
            tracing::warn!(
                request_id,
                method = observation.method,
                route = observation.route,
                status = observation.status,
                duration_ms,
                database_checkouts = observation.database_checkouts,
                "slow request"
            );
        } else if self
            .inner
            .success_log_sequence
            .fetch_add(1, Ordering::Relaxed)
            .is_multiple_of(self.inner.success_sample_rate)
        {
            tracing::info!(
                request_id,
                method = observation.method,
                route = observation.route,
                status = observation.status,
                duration_ms,
                database_checkouts = observation.database_checkouts,
                "request completed"
            );
        }
    }

    pub fn record_pool_checkout(&self, pool: &str, duration: Duration, succeeded: bool) {
        lock_unpoisoned(&self.inner.pool_checkout)
            .entry(pool.to_owned())
            .or_default()
            .record(duration, !succeeded);
    }

    pub fn record_pool_connection_created(&self, pool: &str) {
        increment_labeled_counter(&self.inner.pool_connections_created, pool);
    }

    pub fn record_pool_lifetime_recycle(&self, pool: &str) {
        increment_labeled_counter(&self.inner.pool_lifetime_recycles, pool);
    }

    pub fn record_maintenance(&self, worker: &str, duration: Duration, succeeded: bool) {
        lock_unpoisoned(&self.inner.maintenance)
            .entry(worker.to_owned())
            .or_default()
            .record(duration, !succeeded);
    }

    pub fn record_maintenance_restart(&self, worker: &str) {
        let mut restarts = lock_unpoisoned(&self.inner.maintenance_restarts);
        let count = restarts.entry(worker.to_owned()).or_default();
        *count = count.saturating_add(1);
    }

    pub fn render(&self, pools: &[(&str, PoolStatus)]) -> String {
        let mut output = String::with_capacity(16 * 1024);
        writeln!(
            output,
            "# HELP aeralyth_build_info Aeralyth API build information."
        )
        .ok();
        writeln!(output, "# TYPE aeralyth_build_info gauge").ok();
        writeln!(
            output,
            "aeralyth_build_info{{version=\"{}\"}} 1",
            escape_label(env!("CARGO_PKG_VERSION")),
        )
        .ok();
        writeln!(
            output,
            "# HELP aeralyth_process_uptime_seconds Process uptime."
        )
        .ok();
        writeln!(output, "# TYPE aeralyth_process_uptime_seconds gauge").ok();
        writeln!(
            output,
            "aeralyth_process_uptime_seconds {:.6}",
            self.inner.started_at.elapsed().as_secs_f64(),
        )
        .ok();
        render_pool_metrics(&mut output, pools);
        render_pool_checkout_metrics(
            &mut output,
            &lock_unpoisoned(&self.inner.pool_checkout),
            &lock_unpoisoned(&self.inner.pool_connections_created),
            &lock_unpoisoned(&self.inner.pool_lifetime_recycles),
        );
        render_http_metrics(&mut output, &lock_unpoisoned(&self.inner.http));
        render_maintenance_metrics(
            &mut output,
            &lock_unpoisoned(&self.inner.maintenance),
            &lock_unpoisoned(&self.inner.maintenance_restarts),
        );
        output
    }
}

impl DurationStats {
    fn record(&mut self, duration: Duration, failed: bool) {
        self.count = self.count.saturating_add(1);
        if failed {
            self.failures = self.failures.saturating_add(1);
        }
        let seconds = duration.as_secs_f64();
        self.total_seconds += seconds;
        for (index, boundary) in DURATION_BUCKETS_SECONDS.iter().enumerate() {
            if seconds <= *boundary {
                self.buckets[index] = self.buckets[index].saturating_add(1);
            }
        }
    }
}

pub fn init_logging(config: &Config) -> Result<(), Box<dyn StdError + Send + Sync>> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    if config.structured_logs {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_target(false)
            .json()
            .try_init()?;
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_target(false)
            .compact()
            .try_init()?;
    }
    Ok(())
}

fn render_pool_metrics(output: &mut String, pools: &[(&str, PoolStatus)]) {
    writeln!(
        output,
        "# HELP aeralyth_db_pool_connections Database pool connections by state."
    )
    .ok();
    writeln!(output, "# TYPE aeralyth_db_pool_connections gauge").ok();
    for (name, pool) in pools {
        let name = escape_label(name);
        for (state, value) in [
            ("max", pool.max_size),
            ("size", pool.size),
            ("available", pool.available),
            ("waiting", pool.waiting),
        ] {
            writeln!(
                output,
                "aeralyth_db_pool_connections{{pool=\"{name}\",state=\"{state}\"}} {value}"
            )
            .ok();
        }
    }
}

fn render_pool_checkout_metrics(
    output: &mut String,
    checkouts: &BTreeMap<String, DurationStats>,
    connections_created: &BTreeMap<String, u64>,
    lifetime_recycles: &BTreeMap<String, u64>,
) {
    writeln!(
        output,
        "# HELP aeralyth_db_pool_checkout_duration_seconds Database pool checkout latency."
    )
    .ok();
    writeln!(
        output,
        "# TYPE aeralyth_db_pool_checkout_duration_seconds histogram"
    )
    .ok();
    for (pool, stats) in checkouts {
        render_duration_histogram(
            output,
            "aeralyth_db_pool_checkout_duration_seconds",
            &format!("pool=\"{}\"", escape_label(pool)),
            stats,
        );
    }
    writeln!(
        output,
        "# HELP aeralyth_db_pool_checkout_failures_total Failed database pool checkouts."
    )
    .ok();
    writeln!(
        output,
        "# TYPE aeralyth_db_pool_checkout_failures_total counter"
    )
    .ok();
    for (pool, stats) in checkouts {
        writeln!(
            output,
            "aeralyth_db_pool_checkout_failures_total{{pool=\"{}\"}} {}",
            escape_label(pool),
            stats.failures
        )
        .ok();
    }
    writeln!(
        output,
        "# HELP aeralyth_db_pool_connections_created_total PostgreSQL connections created by pool."
    )
    .ok();
    writeln!(
        output,
        "# TYPE aeralyth_db_pool_connections_created_total counter"
    )
    .ok();
    for (pool, count) in connections_created {
        writeln!(
            output,
            "aeralyth_db_pool_connections_created_total{{pool=\"{}\"}} {count}",
            escape_label(pool),
        )
        .ok();
    }
    writeln!(
        output,
        "# HELP aeralyth_db_pool_lifetime_recycles_total Connections recycled after their jittered maximum lifetime."
    )
    .ok();
    writeln!(
        output,
        "# TYPE aeralyth_db_pool_lifetime_recycles_total counter"
    )
    .ok();
    for (pool, count) in lifetime_recycles {
        writeln!(
            output,
            "aeralyth_db_pool_lifetime_recycles_total{{pool=\"{}\"}} {count}",
            escape_label(pool),
        )
        .ok();
    }
}

fn render_http_metrics(output: &mut String, http: &BTreeMap<HttpKey, HttpStats>) {
    writeln!(
        output,
        "# HELP aeralyth_http_request_duration_seconds Request latency by route template."
    )
    .ok();
    writeln!(
        output,
        "# TYPE aeralyth_http_request_duration_seconds histogram"
    )
    .ok();
    writeln!(
        output,
        "# HELP aeralyth_http_requests_total Requests by route template and status."
    )
    .ok();
    writeln!(output, "# TYPE aeralyth_http_requests_total counter").ok();
    writeln!(
        output,
        "# HELP aeralyth_http_database_checkouts_total Request-scoped database pool checkouts."
    )
    .ok();
    writeln!(
        output,
        "# TYPE aeralyth_http_database_checkouts_total counter"
    )
    .ok();
    writeln!(
        output,
        "# HELP aeralyth_http_request_bytes_total Declared request body bytes."
    )
    .ok();
    writeln!(output, "# TYPE aeralyth_http_request_bytes_total counter").ok();
    writeln!(
        output,
        "# HELP aeralyth_http_response_bytes_total Declared response body bytes."
    )
    .ok();
    writeln!(output, "# TYPE aeralyth_http_response_bytes_total counter").ok();
    for (key, stats) in http {
        let labels = format!(
            "method=\"{}\",route=\"{}\",status=\"{}\"",
            escape_label(&key.method),
            escape_label(&key.route),
            key.status,
        );
        render_duration_histogram(
            output,
            "aeralyth_http_request_duration_seconds",
            &labels,
            &stats.duration,
        );
        writeln!(
            output,
            "aeralyth_http_requests_total{{{labels}}} {}",
            stats.duration.count
        )
        .ok();
        writeln!(
            output,
            "aeralyth_http_database_checkouts_total{{{labels}}} {}",
            stats.database_checkouts,
        )
        .ok();
        writeln!(
            output,
            "aeralyth_http_request_bytes_total{{{labels}}} {}",
            stats.request_bytes
        )
        .ok();
        writeln!(
            output,
            "aeralyth_http_response_bytes_total{{{labels}}} {}",
            stats.response_bytes
        )
        .ok();
    }
}

fn render_maintenance_metrics(
    output: &mut String,
    maintenance: &BTreeMap<String, DurationStats>,
    restarts: &BTreeMap<String, u64>,
) {
    writeln!(
        output,
        "# HELP aeralyth_maintenance_duration_seconds Maintenance worker run latency."
    )
    .ok();
    writeln!(
        output,
        "# TYPE aeralyth_maintenance_duration_seconds histogram"
    )
    .ok();
    writeln!(
        output,
        "# HELP aeralyth_maintenance_failures_total Maintenance worker failures."
    )
    .ok();
    writeln!(output, "# TYPE aeralyth_maintenance_failures_total counter").ok();
    writeln!(
        output,
        "# HELP aeralyth_maintenance_restarts_total Maintenance supervisor restarts."
    )
    .ok();
    writeln!(output, "# TYPE aeralyth_maintenance_restarts_total counter").ok();
    for (worker, stats) in maintenance {
        let labels = format!("worker=\"{}\"", escape_label(worker));
        render_duration_histogram(
            output,
            "aeralyth_maintenance_duration_seconds",
            &labels,
            stats,
        );
        writeln!(
            output,
            "aeralyth_maintenance_failures_total{{{labels}}} {}",
            stats.failures
        )
        .ok();
    }
    for (worker, count) in restarts {
        writeln!(
            output,
            "aeralyth_maintenance_restarts_total{{worker=\"{}\"}} {count}",
            escape_label(worker),
        )
        .ok();
    }
}

fn render_duration_histogram(output: &mut String, name: &str, labels: &str, stats: &DurationStats) {
    let separator = if labels.is_empty() { "" } else { "," };
    for (index, boundary) in DURATION_BUCKETS_SECONDS.iter().enumerate() {
        writeln!(
            output,
            "{name}_bucket{{{labels}{separator}le=\"{boundary}\"}} {}",
            stats.buckets[index],
        )
        .ok();
    }
    writeln!(
        output,
        "{name}_bucket{{{labels}{separator}le=\"+Inf\"}} {}",
        stats.count,
    )
    .ok();
    if labels.is_empty() {
        writeln!(output, "{name}_sum {:.6}", stats.total_seconds).ok();
        writeln!(output, "{name}_count {}", stats.count).ok();
    } else {
        writeln!(output, "{name}_sum{{{labels}}} {:.6}", stats.total_seconds).ok();
        writeln!(output, "{name}_count{{{labels}}} {}", stats.count).ok();
    }
}

fn escape_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('"', "\\\"")
}

fn increment_labeled_counter(counters: &Mutex<BTreeMap<String, u64>>, label: &str) {
    let mut counters = lock_unpoisoned(counters);
    let count = counters.entry(label.to_owned()).or_default();
    *count = count.saturating_add(1);
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::{Metrics, RequestObservation};
    use crate::config::Config;
    use deadpool_postgres::Status as PoolStatus;
    use std::time::Duration;

    #[test]
    fn renders_route_pool_and_maintenance_metrics_without_raw_paths() {
        let mut config = Config::from_env().expect("test configuration should load");
        config.request_success_sample_rate = 100;
        let metrics = Metrics::new(&config);
        metrics.record_request(&RequestObservation {
            method: "GET",
            route: "/api/files/{id}/download",
            status: 200,
            duration: Duration::from_millis(12),
            request_bytes: 0,
            response_bytes: 1_024,
            database_checkouts: 1,
        });
        metrics.record_pool_checkout("request", Duration::from_millis(2), true);
        metrics.record_pool_checkout("maintenance", Duration::from_millis(4), true);
        metrics.record_pool_connection_created("request");
        metrics.record_pool_connection_created("maintenance");
        metrics.record_pool_lifetime_recycle("maintenance");
        metrics.record_maintenance("storage deletion", Duration::from_millis(4), true);
        let rendered = metrics.render(&[
            (
                "request",
                PoolStatus {
                    max_size: 8,
                    size: 2,
                    available: 1,
                    waiting: 0,
                },
            ),
            (
                "maintenance",
                PoolStatus {
                    max_size: 2,
                    size: 1,
                    available: 1,
                    waiting: 0,
                },
            ),
        ]);

        assert!(rendered.contains("route=\"/api/files/{id}/download\""));
        assert!(rendered.contains("aeralyth_http_database_checkouts_total"));
        assert!(
            rendered.contains("aeralyth_db_pool_connections{pool=\"request\",state=\"max\"} 8")
        );
        assert!(
            rendered.contains("aeralyth_db_pool_connections{pool=\"maintenance\",state=\"max\"} 2")
        );
        assert!(
            rendered
                .contains("aeralyth_db_pool_checkout_duration_seconds_count{pool=\"request\"} 1")
        );
        assert!(
            rendered.contains("aeralyth_db_pool_connections_created_total{pool=\"maintenance\"} 1")
        );
        assert!(
            rendered.contains("aeralyth_db_pool_lifetime_recycles_total{pool=\"maintenance\"} 1")
        );
        assert!(rendered.contains("worker=\"storage deletion\""));
        assert!(!rendered.contains("secret-token"));
    }
}
