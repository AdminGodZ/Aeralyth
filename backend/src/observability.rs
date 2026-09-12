use std::collections::BTreeMap;
use std::error::Error as StdError;
use std::fmt::Write;
use std::io::{self, Write as IoWrite};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::db;
use actix_web::HttpMessage;
use actix_web::body::{BodySize, MessageBody};
use actix_web::http::header::{CONTENT_TYPE, HeaderName, HeaderValue};
use bytes::Bytes;
use deadpool_postgres::Status as PoolStatus;
use futures_util::{StreamExt, TryStreamExt};
use tracing::Instrument;
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
    high_volume_success_log_sequence: AtomicU64,
    success_sample_rate: u64,
    slow_request: Duration,
    warning_budgets: Mutex<[LogBudget; 3]>,
    admission_wait: Mutex<BTreeMap<String, DurationStats>>,
    sse_terminations: Mutex<BTreeMap<String, u64>>,
    sse_delivery_lag: Mutex<DurationStats>,
    http: Mutex<BTreeMap<HttpKey, HttpStats>>,
    pool_checkout: Mutex<BTreeMap<String, DurationStats>>,
    pool_connections_created: Mutex<BTreeMap<String, u64>>,
    pool_lifetime_recycles: Mutex<BTreeMap<String, u64>>,
    maintenance: Mutex<BTreeMap<String, DurationStats>>,
    maintenance_restarts: Mutex<BTreeMap<String, u64>>,
    maintenance_item_failures: Mutex<BTreeMap<String, u64>>,
    s3_retry_attempts: Mutex<BTreeMap<String, u64>>,
    maintenance_provider_in_flight: AtomicU64,
    maintenance_provider_peak: AtomicU64,
    realtime_pruned: AtomicU64,
    realtime_expired_remaining: AtomicBool,
    realtime_oldest_age_ms: AtomicU64,
    realtime_prune_lag_ms: AtomicU64,
    counter_reconciliation_rows_scanned: AtomicU64,
    counter_reconciliation_rows_updated: AtomicU64,
}

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
struct HttpKey {
    method: String,
    route: String,
    status: u16,
}

#[derive(Clone, Default)]
struct HttpStats {
    header_duration: DurationStats,
    duration: DurationStats,
    sse_duration: DurationStats,
    active_sse: u64,
    sse_reconnects: u64,
    completed: u64,
    cancelled: u64,
    body_errors: u64,
    unobserved_errors: u64,
    database_checkouts: u64,
    request_bytes: u64,
    response_bytes: u64,
}

#[derive(Clone, Default)]
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
    pub database_checkouts: usize,
}

/// Observe routed requests without cloning HttpRequest before Actix dispatch,
/// which must retain unique access to its routing match state.
pub async fn observe_request<B: MessageBody + 'static>(
    mut request: actix_web::dev::ServiceRequest,
    next: actix_web::middleware::Next<B>,
) -> Result<actix_web::dev::ServiceResponse<ObservedBody<B>>, actix_web::Error> {
    let metrics = request
        .app_data::<actix_web::web::Data<Metrics>>()
        .expect("request metrics are configured")
        .get_ref()
        .clone();
    let method = request.method().as_str().to_owned();
    let request_bytes = Arc::new(AtomicU64::new(0));
    let payload_bytes = request_bytes.clone();
    let payload = request
        .take_payload()
        .inspect_ok(move |bytes| {
            payload_bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        })
        .boxed_local();
    request.set_payload(actix_web::dev::Payload::from(payload));
    let reconnect = request.headers().contains_key("last-event-id")
        || request
            .query_string()
            .split('&')
            .any(|part| part == "reconnect=1");
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
    let future = next.call(request);
    async move {
        let (result, database_checkouts) = db::scope_request(future).await;
        let duration = started.elapsed();
        let mut response = match result {
            Ok(response) => response,
            Err(error) => {
                // Handler errors normally arrive as responses. A service
                // error has no body here; report that coverage gap explicitly.
                let observation = RequestObservation {
                    method: &method,
                    route: "middleware_error",
                    status: error.as_response_error().status_code().as_u16(),
                    duration,
                    database_checkouts,
                };
                metrics.record_request(&observation);
                metrics
                    .record_unobserved_error(&observation, request_bytes.load(Ordering::Relaxed));
                metrics.log_request(&request_id, &observation);
                return Err(error);
            }
        };
        let route = response
            .request()
            .match_pattern()
            .unwrap_or_else(|| "unmatched".to_owned());
        let status = response.status().as_u16();
        let is_sse = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.split(';').next() == Some("text/event-stream"));
        request_span.record("route", route.as_str());
        request_span.record("status", status);
        let observation = RequestObservation {
            method: &method,
            route: &route,
            status,
            duration,
            database_checkouts,
        };
        metrics.record_request(&observation);
        metrics.log_request(&request_id, &observation);
        response.response_mut().headers_mut().insert(
            HeaderName::from_static("x-request-id"),
            HeaderValue::from_str(&request_id).expect("generated request IDs are valid headers"),
        );
        response.response_mut().headers_mut().insert(
            HeaderName::from_static("server-timing"),
            HeaderValue::from_str(&format!("app;dur={:.3}", duration.as_secs_f64() * 1_000.0))
                .expect("server timing is a valid header"),
        );
        Ok(response.map_body(|_, body| {
            metrics.observe_body(
                body,
                &observation,
                started,
                request_bytes,
                is_sse,
                reconnect,
            )
        }))
    }
    .instrument(execution_span)
    .await
}

/// Counts bytes yielded by a body. A completed observation means the application
/// handed its body to Actix, not that a remote client acknowledged every byte.
pub struct ObservedBody<B> {
    body: Pin<Box<B>>,
    observation: BodyObservation,
    size: BodySize,
}

struct BodyObservation {
    metrics: Metrics,
    key: HttpKey,
    started: Instant,
    request_bytes: Arc<AtomicU64>,
    response_bytes: u64,
    is_sse: bool,
    finished: bool,
}

#[derive(Clone, Copy)]
enum BodyOutcome {
    Completed,
    Error,
    Cancelled,
}

impl BodyObservation {
    fn finish(&mut self, outcome: BodyOutcome) {
        if self.finished {
            return;
        }
        self.finished = true;
        let mut http = lock_unpoisoned(&self.metrics.inner.http);
        let stats = http.entry(self.key.clone()).or_default();
        let failed = !matches!(outcome, BodyOutcome::Completed) || self.key.status >= 500;
        if self.is_sse {
            stats.active_sse = stats.active_sse.saturating_sub(1);
            stats.sse_duration.record(self.started.elapsed(), failed);
        } else {
            stats.duration.record(self.started.elapsed(), failed);
        }
        match outcome {
            BodyOutcome::Completed => stats.completed += 1,
            BodyOutcome::Error => stats.body_errors += 1,
            BodyOutcome::Cancelled => stats.cancelled += 1,
        }
        stats.request_bytes = stats
            .request_bytes
            .saturating_add(self.request_bytes.load(Ordering::Relaxed));
        stats.response_bytes = stats.response_bytes.saturating_add(self.response_bytes);
    }
}

impl<B: MessageBody> MessageBody for ObservedBody<B> {
    type Error = B::Error;

    fn size(&self) -> BodySize {
        self.size
    }

    fn poll_next(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Bytes, Self::Error>>> {
        let this = self.get_mut();
        match this.body.as_mut().poll_next(context) {
            Poll::Ready(Some(Ok(bytes))) => {
                this.observation.response_bytes = this
                    .observation
                    .response_bytes
                    .saturating_add(bytes.len() as u64);
                // Actix may stop polling once a sized body has yielded its size.
                // This is MessageBody's intrinsic size, never Content-Length.
                if matches!(this.size, BodySize::Sized(size) if this.observation.response_bytes >= size)
                {
                    this.observation.finish(BodyOutcome::Completed);
                }
                Poll::Ready(Some(Ok(bytes)))
            }
            Poll::Ready(Some(Err(error))) => {
                this.observation.finish(BodyOutcome::Error);
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                let outcome = if matches!(this.size, BodySize::Sized(size) if this.observation.response_bytes < size)
                {
                    BodyOutcome::Error
                } else {
                    BodyOutcome::Completed
                };
                this.observation.finish(outcome);
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl<B> Drop for ObservedBody<B> {
    fn drop(&mut self) {
        self.observation.finish(BodyOutcome::Cancelled);
    }
}

fn metric_method(method: &str) -> &str {
    match method {
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "CONNECT" | "TRACE" => {
            method
        }
        _ => "OTHER",
    }
}

const LOG_QUEUE_CAPACITY: usize = 1_024;
const MAX_LOG_EVENT_BYTES: usize = 64 * 1_024;
const LOG_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
static LOG_STATS: LogStats = LogStats::new();

struct LogStats {
    queued: AtomicU64,
    dropped: AtomicU64,
    write_errors: AtomicU64,
    suppressed: AtomicU64,
    shutdown_timeouts: AtomicU64,
}
impl LogStats {
    const fn new() -> Self {
        Self {
            queued: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            write_errors: AtomicU64::new(0),
            suppressed: AtomicU64::new(0),
            shutdown_timeouts: AtomicU64::new(0),
        }
    }
}

#[derive(Clone)]
struct QueuedWriter {
    sender: SyncSender<Vec<u8>>,
    stats: &'static LogStats,
    stopping: Arc<AtomicBool>,
}
struct EventWriter {
    writer: QueuedWriter,
    bytes: Vec<u8>,
    oversized: bool,
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for QueuedWriter {
    type Writer = EventWriter;
    fn make_writer(&'a self) -> Self::Writer {
        EventWriter {
            writer: self.clone(),
            bytes: Vec::with_capacity(256),
            oversized: false,
        }
    }
}
impl IoWrite for EventWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if !self.oversized && self.bytes.len().saturating_add(bytes.len()) <= MAX_LOG_EVENT_BYTES {
            self.bytes.extend_from_slice(bytes);
        } else {
            self.oversized = true;
            self.bytes.clear();
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Drop for EventWriter {
    fn drop(&mut self) {
        if self.oversized || self.writer.stopping.load(Ordering::Relaxed) {
            self.writer.stats.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if self.bytes.is_empty() {
            return;
        }
        self.writer.stats.queued.fetch_add(1, Ordering::Relaxed);
        if self
            .writer
            .sender
            .try_send(std::mem::take(&mut self.bytes))
            .is_err()
        {
            self.writer.stats.queued.fetch_sub(1, Ordering::Relaxed);
            self.writer.stats.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// Operational diagnostics are bounded and best effort. Database-backed audit
/// and event records do not use this queue. Retain this guard until shutdown.
pub struct LoggingGuard {
    stopping: Arc<AtomicBool>,
    drained: mpsc::Receiver<()>,
    stats: &'static LogStats,
}
impl Drop for LoggingGuard {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        if self.drained.recv_timeout(LOG_SHUTDOWN_TIMEOUT).is_err() {
            self.stats.shutdown_timeouts.fetch_add(1, Ordering::Relaxed);
        }
    }
}
fn queued_writer<W: IoWrite + Send + 'static>(
    mut sink: W,
    capacity: usize,
    stats: &'static LogStats,
) -> io::Result<(QueuedWriter, LoggingGuard)> {
    let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(capacity);
    let (drained_tx, drained) = mpsc::channel();
    let stopping = Arc::new(AtomicBool::new(false));
    let worker_stopping = stopping.clone();
    std::thread::Builder::new()
        .name("operational-log-writer".to_owned())
        .spawn(move || {
            loop {
                let message = if worker_stopping.load(Ordering::Acquire) {
                    match receiver.try_recv() {
                        Ok(message) => message,
                        Err(_) => break,
                    }
                } else {
                    match receiver.recv_timeout(Duration::from_millis(25)) {
                        Ok(message) => message,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                };
                stats.queued.fetch_sub(1, Ordering::Relaxed);
                if sink.write_all(&message).is_err() {
                    stats.write_errors.fetch_add(1, Ordering::Relaxed);
                }
            }
            if sink.flush().is_err() {
                stats.write_errors.fetch_add(1, Ordering::Relaxed);
            }
            let _ = drained_tx.send(());
        })?;
    Ok((
        QueuedWriter {
            sender,
            stats,
            stopping: stopping.clone(),
        },
        LoggingGuard {
            stopping,
            drained,
            stats,
        },
    ))
}

struct LogBudget {
    window: Instant,
    emitted: u32,
    suppressed: u64,
}
impl Default for LogBudget {
    fn default() -> Self {
        Self {
            window: Instant::now(),
            emitted: 0,
            suppressed: 0,
        }
    }
}
impl LogBudget {
    fn admit(&mut self) -> Option<u64> {
        if self.window.elapsed() >= Duration::from_secs(1) {
            self.window = Instant::now();
            self.emitted = 0;
        }
        if self.emitted >= 20 {
            self.suppressed = self.suppressed.saturating_add(1);
            None
        } else {
            self.emitted += 1;
            Some(std::mem::take(&mut self.suppressed))
        }
    }
}
fn render_log_metrics(output: &mut String) {
    for (name, kind, value) in [
        (
            "aeralyth_log_queue_events",
            "gauge",
            LOG_STATS.queued.load(Ordering::Relaxed),
        ),
        (
            "aeralyth_log_queue_capacity",
            "gauge",
            LOG_QUEUE_CAPACITY as u64,
        ),
        (
            "aeralyth_log_dropped_events_total",
            "counter",
            LOG_STATS.dropped.load(Ordering::Relaxed),
        ),
        (
            "aeralyth_log_write_errors_total",
            "counter",
            LOG_STATS.write_errors.load(Ordering::Relaxed),
        ),
        (
            "aeralyth_log_suppressed_requests_total",
            "counter",
            LOG_STATS.suppressed.load(Ordering::Relaxed),
        ),
        (
            "aeralyth_log_shutdown_timeouts_total",
            "counter",
            LOG_STATS.shutdown_timeouts.load(Ordering::Relaxed),
        ),
    ] {
        writeln!(output, "# TYPE {name} {kind}\n{name} {value}").ok();
    }
}

impl Metrics {
    pub fn new(config: &Config) -> Self {
        Self {
            inner: Arc::new(MetricsInner {
                started_at: Instant::now(),
                request_sequence: AtomicU64::new(1),
                success_log_sequence: AtomicU64::new(0),
                high_volume_success_log_sequence: AtomicU64::new(0),
                success_sample_rate: config.request_success_sample_rate as u64,
                slow_request: Duration::from_millis(config.request_slow_ms),
                warning_budgets: Mutex::new(std::array::from_fn(|_| LogBudget::default())),
                admission_wait: Mutex::new(BTreeMap::new()),
                sse_terminations: Mutex::new(BTreeMap::new()),
                sse_delivery_lag: Mutex::new(DurationStats::default()),
                http: Mutex::new(BTreeMap::new()),
                pool_checkout: Mutex::new(BTreeMap::new()),
                pool_connections_created: Mutex::new(BTreeMap::new()),
                pool_lifetime_recycles: Mutex::new(BTreeMap::new()),
                maintenance: Mutex::new(BTreeMap::new()),
                maintenance_restarts: Mutex::new(BTreeMap::new()),
                maintenance_item_failures: Mutex::new(BTreeMap::new()),
                s3_retry_attempts: Mutex::new(BTreeMap::new()),
                maintenance_provider_in_flight: AtomicU64::new(0),
                maintenance_provider_peak: AtomicU64::new(0),
                realtime_pruned: AtomicU64::new(0),
                realtime_expired_remaining: AtomicBool::new(false),
                realtime_oldest_age_ms: AtomicU64::new(0),
                realtime_prune_lag_ms: AtomicU64::new(0),
                counter_reconciliation_rows_scanned: AtomicU64::new(0),
                counter_reconciliation_rows_updated: AtomicU64::new(0),
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
            method: metric_method(observation.method).to_owned(),
            route: observation.route.to_owned(),
            status: observation.status,
        };
        let mut http = lock_unpoisoned(&self.inner.http);
        let stats = http.entry(key).or_default();
        stats
            .header_duration
            .record(observation.duration, observation.status >= 500);
        stats.database_checkouts = stats
            .database_checkouts
            .saturating_add(observation.database_checkouts as u64);
    }

    pub fn log_request(&self, request_id: &str, observation: &RequestObservation<'_>) {
        let duration_ms = observation.duration.as_secs_f64() * 1_000.0;
        let warning_class = if observation.status >= 500 {
            Some(0)
        } else if observation.status >= 400 {
            Some(1)
        } else if observation.duration >= self.inner.slow_request {
            Some(2)
        } else {
            None
        };
        let suppressed_since_last = if let Some(class) = warning_class {
            let mut budgets = lock_unpoisoned(&self.inner.warning_budgets);
            let Some(suppressed) = budgets[class].admit() else {
                LOG_STATS.suppressed.fetch_add(1, Ordering::Relaxed);
                return;
            };
            suppressed
        } else {
            0
        };
        if observation.status >= 500 {
            tracing::error!(
                request_id,
                method = observation.method,
                route = observation.route,
                status = observation.status,
                duration_ms,
                suppressed_since_last,
                database_checkouts = observation.database_checkouts,
                "request failed"
            );
        } else if observation.status >= 400 {
            tracing::warn!(
                request_id,
                method = observation.method,
                route = observation.route,
                status = observation.status,
                duration_ms,
                suppressed_since_last,
                database_checkouts = observation.database_checkouts,
                "request rejected"
            );
        } else if observation.duration >= self.inner.slow_request {
            tracing::warn!(
                request_id,
                method = observation.method,
                route = observation.route,
                status = observation.status,
                duration_ms,
                suppressed_since_last,
                database_checkouts = observation.database_checkouts,
                "slow request"
            );
        } else {
            let (sequence, sample_rate) = match success_log_class(observation.route) {
                SuccessLogClass::Excluded => return,
                SuccessLogClass::Standard => (
                    &self.inner.success_log_sequence,
                    self.inner.success_sample_rate,
                ),
                SuccessLogClass::HighVolume => (
                    &self.inner.high_volume_success_log_sequence,
                    self.inner.success_sample_rate.saturating_mul(10),
                ),
            };
            if sequence
                .fetch_add(1, Ordering::Relaxed)
                .is_multiple_of(sample_rate.max(1))
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
    }

    pub fn maintenance_provider_started(&self) {
        let current = self
            .inner
            .maintenance_provider_in_flight
            .fetch_add(1, Ordering::Relaxed)
            + 1;
        self.inner
            .maintenance_provider_peak
            .fetch_max(current, Ordering::Relaxed);
    }

    pub fn maintenance_provider_finished(&self) {
        self.inner
            .maintenance_provider_in_flight
            .fetch_sub(1, Ordering::Relaxed);
    }

    pub fn record_realtime_retention(
        &self,
        deleted: u64,
        expired_remaining: bool,
        oldest_age: Duration,
        prune_lag: Duration,
    ) {
        self.inner
            .realtime_pruned
            .fetch_add(deleted, Ordering::Relaxed);
        self.inner
            .realtime_expired_remaining
            .store(expired_remaining, Ordering::Relaxed);
        self.inner.realtime_oldest_age_ms.store(
            oldest_age.as_millis().min(u64::MAX as u128) as u64,
            Ordering::Relaxed,
        );
        self.inner.realtime_prune_lag_ms.store(
            prune_lag.as_millis().min(u64::MAX as u128) as u64,
            Ordering::Relaxed,
        );
    }

    pub fn record_admission_wait(&self, class: &'static str, duration: Duration, succeeded: bool) {
        // Classes originate in fixed application gates, never in request data.
        let class = match class {
            "interactive" | "bulk" => class,
            _ => "other",
        };
        lock_unpoisoned(&self.inner.admission_wait)
            .entry(class.to_owned())
            .or_default()
            .record(duration, !succeeded);
    }

    pub fn record_sse_termination(&self, reason: &'static str) {
        let reason = match reason {
            "expired" | "session_expired" | "database_error" | "shutdown" | "lifetime" | "auth"
            | "database" | "auth_check_timeout" => reason,
            _ => "other",
        };
        increment_labeled_counter(&self.inner.sse_terminations, reason);
    }

    pub fn record_sse_delivery_lag(&self, duration: Duration) {
        lock_unpoisoned(&self.inner.sse_delivery_lag).record(duration, false);
    }

    pub fn record_unobserved_error(
        &self,
        observation: &RequestObservation<'_>,
        request_bytes: u64,
    ) {
        let key = HttpKey {
            method: metric_method(observation.method).to_owned(),
            route: observation.route.to_owned(),
            status: observation.status,
        };
        let mut http = lock_unpoisoned(&self.inner.http);
        let stats = http.entry(key).or_default();
        stats.unobserved_errors += 1;
        stats.request_bytes = stats.request_bytes.saturating_add(request_bytes);
    }

    pub fn observe_body<B: MessageBody>(
        &self,
        body: B,
        observation: &RequestObservation<'_>,
        started: Instant,
        request_bytes: Arc<AtomicU64>,
        is_sse: bool,
        reconnect: bool,
    ) -> ObservedBody<B> {
        let key = HttpKey {
            method: metric_method(observation.method).to_owned(),
            route: observation.route.to_owned(),
            status: observation.status,
        };
        if is_sse {
            let mut http = lock_unpoisoned(&self.inner.http);
            let stats = http.entry(key.clone()).or_default();
            stats.active_sse += 1;
            stats.sse_reconnects += u64::from(reconnect);
        }
        let size = body.size();
        let mut wrapped = ObservedBody {
            body: Box::pin(body),
            observation: BodyObservation {
                metrics: self.clone(),
                key,
                started,
                request_bytes,
                response_bytes: 0,
                is_sse,
                finished: false,
            },
            size,
        };
        // HTTP suppresses these response bodies even when the handler built one.
        if observation.method == "HEAD"
            || observation.status < 200
            || matches!(observation.status, 204 | 304)
            || matches!(size, BodySize::None | BodySize::Sized(0))
        {
            wrapped.observation.finish(BodyOutcome::Completed);
        }
        wrapped
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

    pub fn record_maintenance_item_failure(&self, worker: &str) {
        increment_labeled_counter(&self.inner.maintenance_item_failures, worker);
    }

    pub fn record_s3_retry_attempt(&self, policy: &str) {
        increment_labeled_counter(&self.inner.s3_retry_attempts, policy);
    }

    pub fn record_counter_reconciliation(&self, rows_scanned: u64, rows_updated: u64) {
        self.inner
            .counter_reconciliation_rows_scanned
            .fetch_add(rows_scanned, Ordering::Relaxed);
        self.inner
            .counter_reconciliation_rows_updated
            .fetch_add(rows_updated, Ordering::Relaxed);
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
        // Each bounded map is copied independently under its own short lock.
        // Prometheus string allocation/escaping never holds a request-path lock.
        let http = lock_unpoisoned(&self.inner.http).clone();
        let pool_checkout = lock_unpoisoned(&self.inner.pool_checkout).clone();
        let pool_connections_created =
            lock_unpoisoned(&self.inner.pool_connections_created).clone();
        let pool_lifetime_recycles = lock_unpoisoned(&self.inner.pool_lifetime_recycles).clone();
        let maintenance = lock_unpoisoned(&self.inner.maintenance).clone();
        let maintenance_restarts = lock_unpoisoned(&self.inner.maintenance_restarts).clone();
        let maintenance_item_failures =
            lock_unpoisoned(&self.inner.maintenance_item_failures).clone();
        let s3_retry_attempts = lock_unpoisoned(&self.inner.s3_retry_attempts).clone();
        let admission_wait = lock_unpoisoned(&self.inner.admission_wait).clone();
        let sse_terminations = lock_unpoisoned(&self.inner.sse_terminations).clone();
        let sse_delivery_lag = lock_unpoisoned(&self.inner.sse_delivery_lag).clone();
        render_pool_metrics(&mut output, pools);
        render_pool_checkout_metrics(
            &mut output,
            &pool_checkout,
            &pool_connections_created,
            &pool_lifetime_recycles,
        );
        render_http_metrics(&mut output, &http);
        render_maintenance_metrics(
            &mut output,
            &maintenance,
            &maintenance_restarts,
            &maintenance_item_failures,
        );
        render_storage_metrics(
            &mut output,
            &s3_retry_attempts,
            self.inner
                .counter_reconciliation_rows_scanned
                .load(Ordering::Relaxed),
            self.inner
                .counter_reconciliation_rows_updated
                .load(Ordering::Relaxed),
        );
        writeln!(output, "# TYPE aeralyth_admission_wait_seconds histogram").ok();
        writeln!(output, "# TYPE aeralyth_admission_rejected_total counter").ok();
        for (class, stats) in &admission_wait {
            let labels = format!("class=\"{}\"", escape_label(class));
            render_duration_histogram(
                &mut output,
                "aeralyth_admission_wait_seconds",
                &labels,
                stats,
            );
            writeln!(
                output,
                "aeralyth_admission_rejected_total{{{labels}}} {}",
                stats.failures
            )
            .ok();
        }
        writeln!(output, "# TYPE aeralyth_sse_terminations_total counter").ok();
        for (reason, count) in &sse_terminations {
            writeln!(
                output,
                "aeralyth_sse_terminations_total{{reason=\"{}\"}} {count}",
                escape_label(reason)
            )
            .ok();
        }
        writeln!(output, "# TYPE aeralyth_sse_delivery_lag_seconds histogram").ok();
        render_duration_histogram(
            &mut output,
            "aeralyth_sse_delivery_lag_seconds",
            "",
            &sse_delivery_lag,
        );
        for (name, kind, value) in [
            (
                "aeralyth_maintenance_provider_in_flight",
                "gauge",
                self.inner
                    .maintenance_provider_in_flight
                    .load(Ordering::Relaxed) as f64,
            ),
            (
                "aeralyth_maintenance_provider_peak",
                "gauge",
                self.inner.maintenance_provider_peak.load(Ordering::Relaxed) as f64,
            ),
            (
                "aeralyth_realtime_pruned_total",
                "counter",
                self.inner.realtime_pruned.load(Ordering::Relaxed) as f64,
            ),
            (
                "aeralyth_realtime_expired_remaining",
                "gauge",
                u8::from(
                    self.inner
                        .realtime_expired_remaining
                        .load(Ordering::Relaxed),
                ) as f64,
            ),
            (
                "aeralyth_realtime_oldest_age_seconds",
                "gauge",
                self.inner.realtime_oldest_age_ms.load(Ordering::Relaxed) as f64 / 1_000.0,
            ),
            (
                "aeralyth_realtime_prune_lag_seconds",
                "gauge",
                self.inner.realtime_prune_lag_ms.load(Ordering::Relaxed) as f64 / 1_000.0,
            ),
        ] {
            writeln!(output, "# TYPE {name} {kind}\n{name} {value}").ok();
        }
        render_log_metrics(&mut output);
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

pub fn init_logging(config: &Config) -> Result<LoggingGuard, Box<dyn StdError + Send + Sync>> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let (writer, guard) = queued_writer(io::stdout(), LOG_QUEUE_CAPACITY, &LOG_STATS)?;
    if config.structured_logs {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(writer)
            .with_target(false)
            .json()
            .try_init()?;
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(writer)
            .with_target(false)
            .compact()
            .try_init()?;
    }
    Ok(guard)
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
        "# HELP aeralyth_http_request_duration_seconds Response-body completion latency excluding SSE; bytes are yielded to the HTTP transport, not acknowledged by the client."
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
        "# HELP aeralyth_http_request_bytes_total Actual request payload bytes consumed by the application."
    )
    .ok();
    writeln!(output, "# TYPE aeralyth_http_request_bytes_total counter").ok();
    writeln!(
        output,
        "# HELP aeralyth_http_response_bytes_total Actual response payload bytes yielded to the HTTP transport; direct-provider traffic is measured by the browser."
    )
    .ok();
    writeln!(output, "# TYPE aeralyth_http_response_bytes_total counter").ok();
    for (name, kind) in [
        ("aeralyth_http_header_duration_seconds", "histogram"),
        ("aeralyth_http_body_outcomes_total", "counter"),
        ("aeralyth_sse_stream_duration_seconds", "histogram"),
        ("aeralyth_sse_active_streams", "gauge"),
        ("aeralyth_sse_reconnects_total", "counter"),
    ] {
        writeln!(output, "# TYPE {name} {kind}").ok();
    }
    for (key, stats) in http {
        let labels = format!(
            "method=\"{}\",route=\"{}\",status=\"{}\"",
            escape_label(&key.method),
            escape_label(&key.route),
            key.status,
        );
        render_duration_histogram(
            output,
            "aeralyth_http_header_duration_seconds",
            &labels,
            &stats.header_duration,
        );
        render_duration_histogram(
            output,
            "aeralyth_sse_stream_duration_seconds",
            &labels,
            &stats.sse_duration,
        );
        writeln!(
            output,
            "aeralyth_sse_active_streams{{{labels}}} {}",
            stats.active_sse
        )
        .ok();
        writeln!(
            output,
            "aeralyth_sse_reconnects_total{{{labels}}} {}",
            stats.sse_reconnects
        )
        .ok();
        for (outcome, count) in [
            ("completed", stats.completed),
            ("cancelled", stats.cancelled),
            ("error", stats.body_errors),
            ("unobserved_service_error", stats.unobserved_errors),
        ] {
            writeln!(
                output,
                "aeralyth_http_body_outcomes_total{{{labels},outcome=\"{outcome}\"}} {count}"
            )
            .ok();
        }
        render_duration_histogram(
            output,
            "aeralyth_http_request_duration_seconds",
            &labels,
            &stats.duration,
        );
        writeln!(
            output,
            "aeralyth_http_requests_total{{{labels}}} {}",
            stats.header_duration.count
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
    item_failures: &BTreeMap<String, u64>,
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
    writeln!(
        output,
        "# HELP aeralyth_maintenance_item_failures_total Individual maintenance items that failed while sibling work continued."
    )
    .ok();
    writeln!(
        output,
        "# TYPE aeralyth_maintenance_item_failures_total counter"
    )
    .ok();
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
    for (worker, count) in item_failures {
        writeln!(
            output,
            "aeralyth_maintenance_item_failures_total{{worker=\"{}\"}} {count}",
            escape_label(worker),
        )
        .ok();
    }
}

fn render_storage_metrics(
    output: &mut String,
    s3_retry_attempts: &BTreeMap<String, u64>,
    counter_rows_scanned: u64,
    counter_rows_updated: u64,
) {
    writeln!(
        output,
        "# HELP aeralyth_s3_retry_attempts_total S3 attempts after the first attempt."
    )
    .ok();
    writeln!(output, "# TYPE aeralyth_s3_retry_attempts_total counter").ok();
    for (policy, count) in s3_retry_attempts {
        writeln!(
            output,
            "aeralyth_s3_retry_attempts_total{{policy=\"{}\"}} {count}",
            escape_label(policy),
        )
        .ok();
    }
    writeln!(
        output,
        "# HELP aeralyth_counter_reconciliation_rows_scanned_total Counter rows inspected by drift reconciliation."
    )
    .ok();
    writeln!(
        output,
        "# TYPE aeralyth_counter_reconciliation_rows_scanned_total counter"
    )
    .ok();
    writeln!(
        output,
        "aeralyth_counter_reconciliation_rows_scanned_total {counter_rows_scanned}"
    )
    .ok();
    writeln!(
        output,
        "# HELP aeralyth_counter_reconciliation_rows_updated_total Counter rows repaired by drift reconciliation."
    )
    .ok();
    writeln!(
        output,
        "# TYPE aeralyth_counter_reconciliation_rows_updated_total counter"
    )
    .ok();
    writeln!(
        output,
        "aeralyth_counter_reconciliation_rows_updated_total {counter_rows_updated}"
    )
    .ok();
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SuccessLogClass {
    Excluded,
    Standard,
    HighVolume,
}

fn success_log_class(route: &str) -> SuccessLogClass {
    if matches!(
        route,
        "/health"
            | "/health/live"
            | "/health/ready"
            | "/api/health"
            | "/api/health/live"
            | "/api/health/ready"
    ) {
        return SuccessLogClass::Excluded;
    }

    if matches!(
        route,
        "/api/files/uploads/{id}/content-url"
            | "/api/files/uploads/{id}/parts/{part_number}"
            | "/api/files/uploads/{id}/parts"
            | "/api/files/uploads/{id}/status"
            | "/api/vault/uploads/{id}/content-url"
            | "/api/vault/uploads/{id}/parts/{part_number}"
            | "/api/vault/uploads/{id}/parts"
    ) {
        return SuccessLogClass::HighVolume;
    }

    SuccessLogClass::Standard
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
    use super::{Metrics, RequestObservation, SuccessLogClass, success_log_class};
    use crate::config::Config;
    use deadpool_postgres::Status as PoolStatus;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    #[test]
    fn successful_request_logs_exclude_health_and_downsample_upload_control() {
        assert_eq!(success_log_class("/health"), SuccessLogClass::Excluded);
        assert_eq!(
            success_log_class("/api/vault/uploads/{id}/parts/{part_number}"),
            SuccessLogClass::HighVolume
        );
        assert_eq!(
            success_log_class("/api/repositories/{id}"),
            SuccessLogClass::Standard
        );

        let mut config = Config::from_env().expect("test configuration should load");
        config.request_success_sample_rate = 100;
        let metrics = Metrics::new(&config);
        let observation = |route, status| RequestObservation {
            method: "GET",
            route,
            status,
            duration: Duration::from_millis(1),
            database_checkouts: 0,
        };

        metrics.log_request("health", &observation("/health", 200));
        assert_eq!(
            metrics.inner.success_log_sequence.load(Ordering::Relaxed),
            0
        );
        assert_eq!(
            metrics
                .inner
                .high_volume_success_log_sequence
                .load(Ordering::Relaxed),
            0
        );

        let upload_route = "/api/files/uploads/{id}/parts/{part_number}";
        metrics.log_request("upload", &observation(upload_route, 200));
        metrics.log_request("upload-error", &observation(upload_route, 429));
        assert_eq!(
            metrics
                .inner
                .high_volume_success_log_sequence
                .load(Ordering::Relaxed),
            1
        );
    }

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
            database_checkouts: 1,
        });
        metrics.record_pool_checkout("request", Duration::from_millis(2), true);
        metrics.record_pool_checkout("maintenance", Duration::from_millis(4), true);
        metrics.record_pool_connection_created("request");
        metrics.record_pool_connection_created("maintenance");
        metrics.record_pool_lifetime_recycle("maintenance");
        metrics.record_maintenance("storage deletion", Duration::from_millis(4), true);
        metrics.record_maintenance_item_failure("multipart reconciliation abort");
        metrics.record_s3_retry_attempt("maintenance");
        metrics.record_counter_reconciliation(501, 2);
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
        assert!(rendered.contains(
            "aeralyth_maintenance_item_failures_total{worker=\"multipart reconciliation abort\"} 1"
        ));
        assert!(rendered.contains("aeralyth_s3_retry_attempts_total{policy=\"maintenance\"} 1"));
        assert!(rendered.contains("aeralyth_counter_reconciliation_rows_scanned_total 501"));
        assert!(rendered.contains("aeralyth_counter_reconciliation_rows_updated_total 2"));
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
    fn test_metrics() -> Metrics {
        Metrics::new(&Config::from_env().expect("test configuration"))
    }

    fn header<'a>(route: &'a str) -> RequestObservation<'a> {
        RequestObservation {
            method: "GET",
            route,
            status: 200,
            duration: Duration::from_millis(1),
            database_checkouts: 0,
        }
    }

    #[actix_web::test]
    async fn chunked_completion_measures_delays_and_actual_bytes() {
        use actix_web::body::{BodyStream, to_bytes};
        use bytes::Bytes;
        use futures_util::stream;
        use std::sync::{Arc, atomic::AtomicU64};
        let metrics = test_metrics();
        let observation = header("/delayed/{id}");
        metrics.record_request(&observation);
        let started = std::time::Instant::now();
        let chunks = stream::unfold(0, |index| async move {
            if index == 2 {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
            Some((
                Ok::<_, std::io::Error>(Bytes::from_static(b"abc")),
                index + 1,
            ))
        });
        let body = metrics.observe_body(
            BodyStream::new(chunks),
            &observation,
            started,
            Arc::new(AtomicU64::new(17)),
            false,
            false,
        );
        assert_eq!(to_bytes(body).await.unwrap(), Bytes::from_static(b"abcabc"));
        let http = super::lock_unpoisoned(&metrics.inner.http);
        let stats = http.values().next().unwrap();
        assert_eq!(stats.header_duration.total_seconds, 0.001);
        assert!(stats.duration.total_seconds >= 0.045);
        assert_eq!((stats.request_bytes, stats.response_bytes), (17, 6));
        assert_eq!(
            (stats.completed, stats.cancelled, stats.body_errors),
            (1, 0, 0)
        );
    }

    #[actix_web::test]
    async fn dropped_stream_records_partial_bytes_once_and_releases_sse_gauge() {
        use actix_web::body::{BodyStream, MessageBody};
        use bytes::Bytes;
        use futures_util::{future::poll_fn, stream};
        use std::pin::Pin;
        use std::sync::{Arc, atomic::AtomicU64};
        let metrics = test_metrics();
        let observation = header("/events");
        metrics.record_request(&observation);
        let chunks = stream::iter([
            Ok::<_, std::io::Error>(Bytes::from_static(b"first")),
            Ok(Bytes::from_static(b"never read")),
        ]);
        let mut body = metrics.observe_body(
            BodyStream::new(chunks),
            &observation,
            std::time::Instant::now(),
            Arc::new(AtomicU64::new(0)),
            true,
            true,
        );
        assert_eq!(
            super::lock_unpoisoned(&metrics.inner.http)
                .values()
                .next()
                .unwrap()
                .active_sse,
            1
        );
        assert_eq!(
            poll_fn(|cx| Pin::new(&mut body).poll_next(cx))
                .await
                .unwrap()
                .unwrap(),
            Bytes::from_static(b"first")
        );
        drop(body); // Actix drops a response body when its client disconnects.
        let http = super::lock_unpoisoned(&metrics.inner.http);
        let stats = http.values().next().unwrap();
        assert_eq!(
            (stats.completed, stats.cancelled, stats.body_errors),
            (0, 1, 0)
        );
        assert_eq!(stats.response_bytes, 5);
        assert_eq!((stats.active_sse, stats.sse_reconnects), (0, 1));
        assert_eq!((stats.duration.count, stats.sse_duration.count), (0, 1));
    }

    #[actix_web::test]
    async fn body_error_and_sized_body_completion_are_not_cancellations() {
        use actix_web::body::{BodyStream, to_bytes};
        use bytes::Bytes;
        use futures_util::stream;
        use std::sync::{Arc, atomic::AtomicU64};
        let metrics = test_metrics();
        let observation = header("/body");
        metrics.record_request(&observation);
        let chunks = stream::iter([
            Ok(Bytes::from_static(b"123")),
            Err(std::io::Error::other("injected stream failure")),
        ]);
        let body = metrics.observe_body(
            BodyStream::new(chunks),
            &observation,
            std::time::Instant::now(),
            Arc::new(AtomicU64::new(0)),
            false,
            false,
        );
        assert!(to_bytes(body).await.is_err());
        metrics.record_request(&observation);
        let body = metrics.observe_body(
            Bytes::from_static(b"4567"),
            &observation,
            std::time::Instant::now(),
            Arc::new(AtomicU64::new(0)),
            false,
            false,
        );
        assert_eq!(to_bytes(body).await.unwrap(), Bytes::from_static(b"4567"));
        let http = super::lock_unpoisoned(&metrics.inner.http);
        let stats = http.values().next().unwrap();
        assert_eq!(
            (stats.completed, stats.cancelled, stats.body_errors),
            (1, 0, 1)
        );
        assert_eq!(stats.response_bytes, 7);
        assert_eq!(stats.duration.failures, 1);
    }

    #[test]
    fn slow_log_sink_has_bounded_nonblocking_backlog_and_flushes_on_shutdown() {
        use std::io::Write;
        use std::sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize},
            mpsc,
        };
        use tracing_subscriber::fmt::MakeWriter;
        struct SlowSink {
            first: bool,
            entered: mpsc::Sender<()>,
            release: mpsc::Receiver<()>,
            bytes: Arc<AtomicUsize>,
            flushed: Arc<AtomicBool>,
        }
        impl Write for SlowSink {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if self.first {
                    self.first = false;
                    self.entered.send(()).unwrap();
                    self.release.recv().unwrap();
                }
                self.bytes.fetch_add(bytes.len(), Ordering::Relaxed);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                self.flushed.store(true, Ordering::Relaxed);
                Ok(())
            }
        }
        let stats = Box::leak(Box::new(super::LogStats::new()));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let bytes = Arc::new(AtomicUsize::new(0));
        let flushed = Arc::new(AtomicBool::new(false));
        let (writer, guard) = super::queued_writer(
            SlowSink {
                first: true,
                entered: entered_tx,
                release: release_rx,
                bytes: bytes.clone(),
                flushed: flushed.clone(),
            },
            2,
            stats,
        )
        .unwrap();
        writer.make_writer().write_all(b"event\n").unwrap();
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let started = std::time::Instant::now();
        for _ in 0..100 {
            writer.make_writer().write_all(b"event\n").unwrap();
        }
        assert!(started.elapsed() < Duration::from_millis(100));
        assert_eq!(stats.queued.load(Ordering::Relaxed), 2);
        assert_eq!(stats.dropped.load(Ordering::Relaxed), 98);
        release_tx.send(()).unwrap();
        drop(guard);
        assert_eq!(stats.queued.load(Ordering::Relaxed), 0);
        assert_eq!(bytes.load(Ordering::Relaxed), 18);
        assert!(flushed.load(Ordering::Relaxed));
        assert_eq!(stats.shutdown_timeouts.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn oversized_logs_are_dropped_and_warning_bursts_are_aggregated() {
        use std::io::Write;
        use tracing_subscriber::fmt::MakeWriter;
        let stats = Box::leak(Box::new(super::LogStats::new()));
        let (writer, guard) = super::queued_writer(std::io::sink(), 2, stats).unwrap();
        writer
            .make_writer()
            .write_all(&vec![b'a'; super::MAX_LOG_EVENT_BYTES + 1])
            .unwrap();
        assert_eq!(stats.dropped.load(Ordering::Relaxed), 1);
        drop(guard);
        let mut budget = super::LogBudget::default();
        for _ in 0..20 {
            assert_eq!(budget.admit(), Some(0));
        }
        for _ in 0..100 {
            assert_eq!(budget.admit(), None);
        }
        budget.window -= Duration::from_secs(2);
        assert_eq!(budget.admit(), Some(100));
    }

    #[test]
    fn concurrent_scrapes_preserve_observation_counts_and_bounded_method_labels() {
        let metrics = test_metrics();
        let producer_metrics = metrics.clone();
        let producer = std::thread::spawn(move || {
            for _ in 0..1_000 {
                let mut observation = header("/files/{id}");
                observation.method = "arbitrary-client-value";
                producer_metrics.record_request(&observation);
            }
        });
        for _ in 0..100 {
            assert!(metrics.render(&[]).contains("aeralyth_build_info"));
        }
        producer.join().unwrap();
        let rendered = metrics.render(&[]);
        assert!(rendered.contains("aeralyth_http_requests_total{method=\"OTHER\",route=\"/files/{id}\",status=\"200\"} 1000"));
        assert!(!rendered.contains("arbitrary-client-value"));
    }
    #[test]
    fn head_and_body_forbidden_statuses_complete_without_claiming_payload_bytes() {
        use bytes::Bytes;
        use std::sync::{Arc, atomic::AtomicU64};
        let metrics = test_metrics();
        for (method, status) in [("HEAD", 200), ("GET", 204), ("GET", 304)] {
            let mut observation = header("/bodyless");
            observation.method = method;
            observation.status = status;
            metrics.record_request(&observation);
            drop(metrics.observe_body(
                Bytes::from_static(b"suppressed by HTTP"),
                &observation,
                std::time::Instant::now(),
                Arc::new(AtomicU64::new(0)),
                false,
                false,
            ));
        }
        for stats in super::lock_unpoisoned(&metrics.inner.http).values() {
            assert_eq!(
                (stats.completed, stats.cancelled, stats.response_bytes),
                (1, 0, 0)
            );
        }
    }

    #[actix_web::test]
    #[ignore = "binds a loopback HTTP server; run explicitly with local-network permission"]
    async fn live_http_disconnect_and_head_match_observed_transport_behavior() {
        use actix_web::{App, HttpResponse, HttpServer, web};
        use bytes::Bytes;
        use futures_util::stream;
        use std::io::{Read, Write};
        use std::net::{Shutdown, TcpListener, TcpStream};
        let metrics = test_metrics();
        let server_metrics = metrics.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = HttpServer::new(move || {
            App::new()
                .app_data(web::Data::new(server_metrics.clone()))
                .wrap(actix_web::middleware::from_fn(super::observe_request))
                .route(
                    "/slow",
                    web::get().to(|| async {
                        HttpResponse::Ok().streaming(stream::unfold(0, |index| async move {
                            if index >= 100 {
                                return None;
                            }
                            if index != 0 {
                                tokio::time::sleep(Duration::from_millis(100)).await;
                            }
                            Some((
                                Ok::<_, std::io::Error>(Bytes::from_static(b"payload")),
                                index + 1,
                            ))
                        }))
                    }),
                )
                .route(
                    "/head",
                    web::head()
                        .to(|| async { HttpResponse::Ok().body("HEAD must suppress these bytes") }),
                )
        })
        .workers(1)
        .listen(listener)
        .unwrap()
        .run();
        let handle = server.handle();
        actix_web::rt::spawn(server);
        tokio::task::spawn_blocking(move || {
            let mut head = TcpStream::connect(address).unwrap();
            head.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            head.write_all(b"HEAD /head HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .unwrap();
            let mut received = String::new();
            head.read_to_string(&mut received).unwrap();
            assert!(received.starts_with("HTTP/1.1 200"));
            assert!(received.ends_with("\r\n\r\n"), "HEAD leaked body bytes");
            let mut client = TcpStream::connect(address).unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            client
                .write_all(b"GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .unwrap();
            let mut received = Vec::new();
            let mut buffer = [0; 2048];
            while !received.windows(7).any(|bytes| bytes == b"payload") {
                let count = client.read(&mut buffer).unwrap();
                assert!(count > 0);
                received.extend_from_slice(&buffer[..count]);
            }
            client.shutdown(Shutdown::Both).unwrap();
        })
        .await
        .unwrap();
        for _ in 0..50 {
            if super::lock_unpoisoned(&metrics.inner.http)
                .values()
                .any(|stats| stats.cancelled == 1)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        handle.stop(false).await;
        let http = super::lock_unpoisoned(&metrics.inner.http);
        let head = http.iter().find(|(key, _)| key.method == "HEAD").unwrap().1;
        assert_eq!(
            (head.completed, head.cancelled, head.response_bytes),
            (1, 0, 0)
        );
        let get = http.iter().find(|(key, _)| key.method == "GET").unwrap().1;
        assert_eq!((get.completed, get.cancelled), (0, 1));
        assert!(get.response_bytes >= 7 && get.response_bytes < 700);
    }

    #[test]
    #[ignore = "comparative mutex-wait measurement, not a timing-sensitive correctness gate"]
    fn measure_scrape_contention_snapshot_against_format_under_lock() {
        use std::sync::{Arc, Barrier};
        use std::time::Instant;
        fn run(snapshot: bool) -> (u128, u128) {
            let metrics = test_metrics();
            for index in 0..128 {
                metrics.record_request(&header(&format!("/registered-route-{index}/{{id}}")));
            }
            let barrier = Arc::new(Barrier::new(2));
            let scrape_metrics = metrics.clone();
            let scrape_barrier = barrier.clone();
            let scraper = std::thread::spawn(move || {
                scrape_barrier.wait();
                for _ in 0..100 {
                    let mut output = String::new();
                    if snapshot {
                        let state = super::lock_unpoisoned(&scrape_metrics.inner.http).clone();
                        super::render_http_metrics(&mut output, &state);
                    } else {
                        super::render_http_metrics(
                            &mut output,
                            &super::lock_unpoisoned(&scrape_metrics.inner.http),
                        );
                    }
                    std::hint::black_box(output);
                }
            });
            barrier.wait();
            let mut waits = Vec::with_capacity(10_000);
            for _ in 0..10_000 {
                let started = Instant::now();
                let mut state = super::lock_unpoisoned(&metrics.inner.http);
                waits.push(started.elapsed().as_nanos());
                state
                    .values_mut()
                    .next()
                    .unwrap()
                    .header_duration
                    .record(Duration::from_millis(1), false);
                drop(state);
                std::thread::yield_now();
            }
            scraper.join().unwrap();
            waits.sort_unstable();
            (waits[waits.len() * 99 / 100], waits.iter().sum::<u128>())
        }
        for trial in 1..=3 {
            let old = run(false);
            let snapshot = run(true);
            println!(
                "trial={trial} format-under-lock: p99_ns={} total_wait_ns={}; snapshot: p99_ns={} total_wait_ns={}",
                old.0, old.1, snapshot.0, snapshot.1
            );
        }
    }
    #[actix_web::test]
    async fn routed_middleware_counts_payload_and_handler_errors_and_true_reconnects() {
        use actix_web::{App, HttpResponse, error, middleware::from_fn, test, web};
        use bytes::Bytes;
        let metrics = test_metrics();
        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(metrics.clone()))
                .wrap(from_fn(super::observe_request))
                .route(
                    "/echo/{id}",
                    web::post().to(|bytes: Bytes| async move { HttpResponse::Ok().body(bytes) }),
                )
                .route(
                    "/failure",
                    web::get().to(|| async {
                        Err::<HttpResponse, _>(error::ErrorBadRequest("invalid payload"))
                    }),
                )
                .route(
                    "/events",
                    web::get().to(|| async {
                        HttpResponse::Ok()
                            .insert_header(("content-type", "text/event-stream"))
                            .body("data: hello\n\n")
                    }),
                ),
        )
        .await;
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/echo/private-id")
                .set_payload("abc")
                .to_request(),
        )
        .await;
        assert_eq!(test::read_body(response).await, Bytes::from_static(b"abc"));
        let response =
            test::call_service(&app, test::TestRequest::get().uri("/failure").to_request()).await;
        assert_eq!(response.status(), 400);
        assert_eq!(
            test::read_body(response).await,
            Bytes::from_static(b"invalid payload")
        );
        for request in [
            test::TestRequest::get()
                .uri("/events?cursor=10")
                .to_request(),
            test::TestRequest::get()
                .uri("/events?cursor=10&reconnect=1")
                .to_request(),
            test::TestRequest::get()
                .uri("/events?cursor=10")
                .insert_header(("last-event-id", "11"))
                .to_request(),
        ] {
            let response = test::call_service(&app, request).await;
            test::read_body(response).await;
        }
        let http = super::lock_unpoisoned(&metrics.inner.http);
        let echo = http
            .iter()
            .find(|(key, _)| key.route == "/echo/{id}")
            .unwrap()
            .1;
        assert_eq!(
            (echo.request_bytes, echo.response_bytes, echo.completed),
            (3, 3, 1)
        );
        let error = http
            .iter()
            .find(|(key, _)| key.route == "/failure")
            .unwrap()
            .1;
        assert_eq!(
            (
                error.response_bytes,
                error.completed,
                error.unobserved_errors
            ),
            (15, 1, 0)
        );
        let sse = http
            .iter()
            .find(|(key, _)| key.route == "/events")
            .unwrap()
            .1;
        assert_eq!(
            (sse.sse_reconnects, sse.sse_duration.count, sse.active_sse),
            (2, 3, 0)
        );
        assert!(http.keys().all(|key| !key.route.contains("private-id")));
    }

    #[actix_web::test]
    async fn service_error_reports_unobserved_body_without_claiming_completion() {
        use actix_web::{
            App, body::BoxBody, dev::ServiceResponse, error, middleware::from_fn, test, web,
        };
        let metrics = test_metrics();
        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(metrics.clone()))
                .wrap_fn(|_, _| async {
                    Err::<ServiceResponse<BoxBody>, _>(error::ErrorServiceUnavailable(
                        "injected service error",
                    ))
                })
                .wrap(from_fn(super::observe_request)),
        )
        .await;
        let result = test::try_call_service(
            &app,
            test::TestRequest::get().uri("/service-error").to_request(),
        )
        .await;
        assert!(result.is_err());
        let http = super::lock_unpoisoned(&metrics.inner.http);
        let stats = http.values().next().unwrap();
        assert_eq!(
            (
                stats.unobserved_errors,
                stats.completed,
                stats.duration.count,
                stats.response_bytes
            ),
            (1, 0, 0, 0)
        );
        assert_eq!(stats.header_duration.count, 1);
    }
}
