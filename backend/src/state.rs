use std::collections::HashMap;
use std::error::Error as StdError;
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use actix_web::http::{StatusCode, header::RETRY_AFTER};
use actix_web::{HttpResponse, ResponseError};
use tokio::sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore};

use crate::config::Config;
use crate::db::{Database, DatabasePoolMonitor};
use crate::observability::Metrics;
use crate::passwords::{LoginRateLimiter, PasswordService};
use crate::storage::Storage;

pub struct AppState {
    pub config: Config,
    pub db: Database,
    pub database_pools: DatabasePoolMonitor,
    pub database_readiness: ReadinessCache,
    pub metrics: Metrics,
    pub passwords: PasswordService,
    pub login_rate_limiter: LoginRateLimiter,
    pub storage: Storage,
    pub bucket_usage: crate::bucket_usage::BucketUsageCache,
    pub realtime: crate::realtime::RealtimeHub,
    pub upload_control_limiter: MutationLimiter,
    pub recursive_operation_limiter: QueuedMutationLimiter,
    pub interactive_operation_limiter: QueuedMutationLimiter,
    pub storage_operations: AsyncOperationService,
    pub vault_validation: VaultValidationService,
    pub interactive_validation: VaultValidationService,
}

#[derive(Clone)]
pub struct ReadinessCache {
    ttl: Duration,
    state: Arc<AsyncMutex<CachedReadiness>>,
}

#[derive(Default)]
struct CachedReadiness {
    checked_at: Option<Instant>,
    ready: bool,
}

impl ReadinessCache {
    pub fn new(ttl: Duration) -> Self {
        assert!(!ttl.is_zero());
        Self {
            ttl,
            state: Arc::new(AsyncMutex::new(CachedReadiness::default())),
        }
    }

    pub async fn get_or_check<Check, CheckFuture>(&self, check: Check) -> bool
    where
        Check: FnOnce() -> CheckFuture,
        CheckFuture: Future<Output = bool>,
    {
        let mut state = self.state.lock().await;
        if state
            .checked_at
            .is_some_and(|checked_at| checked_at.elapsed() < self.ttl)
        {
            return state.ready;
        }

        let ready = check().await;
        state.checked_at = Some(Instant::now());
        state.ready = ready;
        ready
    }
}

#[derive(Clone)]
pub struct MutationLimiter {
    global: Arc<Semaphore>,
    users: Arc<Mutex<HashMap<String, Weak<Semaphore>>>>,
    per_user: usize,
}

pub struct MutationPermit {
    _user: OwnedSemaphorePermit,
    _global: OwnedSemaphorePermit,
}

#[derive(Clone)]
pub struct QueuedMutationLimiter {
    limiter: MutationLimiter,
    admission: MutationLimiter,
}

pub struct QueuedMutationPermit {
    _admission: MutationPermit,
    _worker: MutationPermit,
}

#[derive(Clone)]
pub struct VaultValidationService {
    limiter: MutationLimiter,
    admission: MutationLimiter,
    observation: Option<(Metrics, &'static str)>,
    priority: Option<(Arc<PriorityCpuAdmission>, bool)>,
}

// When the deployment has one CPU worker, keep one aggregate worker but reserve
// interactive queue entries and prefer at most four interactive jobs before a waiting bulk job.
#[derive(Default)]
struct PriorityCpuState {
    active: bool,
    interactive_waiters: usize,
    bulk_waiters: usize,
    interactive_streak: usize,
}
struct PriorityCpuAdmission {
    state: Mutex<PriorityCpuState>,
    changed: tokio::sync::watch::Sender<u64>,
}
struct PriorityCpuWaiter {
    admission: Arc<PriorityCpuAdmission>,
    interactive: bool,
    waiting: bool,
}
struct PriorityCpuPermit(Arc<PriorityCpuAdmission>);

impl PriorityCpuAdmission {
    fn new() -> Arc<Self> {
        let (changed, _) = tokio::sync::watch::channel(0);
        Arc::new(Self {
            state: Mutex::new(PriorityCpuState::default()),
            changed,
        })
    }
    fn notify(&self) {
        self.changed
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }
    async fn acquire(self: &Arc<Self>, interactive: bool) -> PriorityCpuPermit {
        let mut changed = self.changed.subscribe();
        let mut waiter = PriorityCpuWaiter {
            admission: self.clone(),
            interactive,
            waiting: true,
        };
        {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if interactive {
                state.interactive_waiters += 1;
            } else {
                state.bulk_waiters += 1;
            }
        }
        loop {
            {
                let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
                let turn = if interactive {
                    state.bulk_waiters == 0 || state.interactive_streak < 4
                } else {
                    state.interactive_waiters == 0 || state.interactive_streak >= 4
                };
                if !state.active && turn {
                    state.active = true;
                    if interactive {
                        state.interactive_waiters -= 1;
                        state.interactive_streak =
                            state.interactive_streak.saturating_add(1).min(4);
                    } else {
                        state.bulk_waiters -= 1;
                        state.interactive_streak = 0;
                    }
                    waiter.waiting = false;
                    return PriorityCpuPermit(self.clone());
                }
            }
            changed
                .changed()
                .await
                .expect("CPU admission lives while waiters exist");
        }
    }
}
impl Drop for PriorityCpuWaiter {
    fn drop(&mut self) {
        if self.waiting {
            {
                let mut state = self
                    .admission
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if self.interactive {
                    state.interactive_waiters -= 1;
                } else {
                    state.bulk_waiters -= 1;
                }
            }
            self.admission.notify();
        }
    }
}
impl Drop for PriorityCpuPermit {
    fn drop(&mut self) {
        self.0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active = false;
        self.0.notify();
    }
}

#[derive(Clone)]
pub struct AsyncOperationService {
    limiter: MutationLimiter,
    admission: MutationLimiter,
}

#[derive(Debug)]
pub struct LoadShedError {
    status: StatusCode,
    message: &'static str,
}

impl LoadShedError {
    pub fn too_many_requests(message: &'static str) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            message,
        }
    }

    pub fn service_unavailable(message: &'static str) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message,
        }
    }
}

impl fmt::Display for LoadShedError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl StdError for LoadShedError {}

impl ResponseError for LoadShedError {
    fn status_code(&self) -> StatusCode {
        self.status
    }

    fn error_response(&self) -> HttpResponse {
        HttpResponse::build(self.status)
            .insert_header((RETRY_AFTER, "1"))
            .body(self.message)
    }
}

#[derive(Debug)]
pub enum VaultValidationError {
    Busy,
    Worker(tokio::task::JoinError),
}

impl fmt::Display for VaultValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Busy => formatter.write_str("vault validation queue is full"),
            Self::Worker(error) => write!(formatter, "vault validation worker failed: {error}"),
        }
    }
}

impl StdError for VaultValidationError {}

impl VaultValidationService {
    pub fn new(
        worker_count: usize,
        per_user: usize,
        queue_capacity: usize,
        per_user_queue_capacity: usize,
    ) -> Self {
        assert!(
            worker_count > 0
                && per_user > 0
                && queue_capacity >= worker_count
                && per_user_queue_capacity >= per_user
                && per_user_queue_capacity <= queue_capacity
        );
        Self {
            limiter: MutationLimiter::new(worker_count, per_user.min(worker_count)),
            admission: MutationLimiter::new(queue_capacity, per_user_queue_capacity),
            observation: None,
            priority: None,
        }
    }

    pub fn partition(
        workers: usize,
        per_user: usize,
        queue: usize,
        per_user_queue: usize,
    ) -> (Self, Self) {
        if workers == 1 && queue >= 2 {
            let interactive_queue = queue.div_ceil(2);
            let bulk_queue = queue - interactive_queue;
            let priority = PriorityCpuAdmission::new();
            let mut interactive = Self::new(
                1,
                1,
                interactive_queue,
                per_user_queue.min(interactive_queue),
            );
            let mut bulk = Self::new(1, 1, bulk_queue, per_user_queue.min(bulk_queue));
            interactive.priority = Some((priority.clone(), true));
            bulk.priority = Some((priority, false));
            return (interactive, bulk);
        }
        let (interactive, bulk) =
            QueuedMutationLimiter::partition(workers, per_user, queue, per_user_queue);
        let service = |class: QueuedMutationLimiter| Self {
            limiter: class.limiter,
            admission: class.admission,
            observation: None,
            priority: None,
        };
        (service(interactive), service(bulk))
    }

    pub fn observed(mut self, metrics: Metrics, class: &'static str) -> Self {
        self.observation = Some((metrics, class));
        self
    }

    pub async fn run<T, Operation>(
        &self,
        user_id: &str,
        operation: Operation,
    ) -> Result<T, VaultValidationError>
    where
        T: Send + 'static,
        Operation: FnOnce() -> T + Send + 'static,
    {
        crate::db::release_request_connection().await;
        // Take the user's bounded queue slot before the global slot. A single user can therefore
        // fill only their own admission budget instead of occupying the entire global queue while
        // waiting for their smaller worker allowance.
        let started = Instant::now();
        let admission = self.admission.try_acquire(user_id).map_err(|()| {
            if let Some((metrics, class)) = &self.observation {
                metrics.record_admission_wait(class, started.elapsed(), false);
            }
            VaultValidationError::Busy
        })?;
        let worker = self.limiter.acquire(user_id).await;
        let priority = if let Some((admission, interactive)) = &self.priority {
            Some(admission.acquire(*interactive).await)
        } else {
            None
        };
        if let Some((metrics, class)) = &self.observation {
            metrics.record_admission_wait(class, started.elapsed(), true);
        }

        tokio::task::spawn_blocking(move || {
            let _admission = admission;
            let _worker = worker;
            let _priority = priority;
            operation()
        })
        .await
        .map_err(VaultValidationError::Worker)
    }
}

impl QueuedMutationLimiter {
    pub fn new(
        worker_count: usize,
        per_user: usize,
        queue_capacity: usize,
        per_user_queue_capacity: usize,
    ) -> Self {
        assert!(
            worker_count > 0
                && per_user > 0
                && queue_capacity >= worker_count
                && per_user_queue_capacity >= per_user
                && per_user_queue_capacity <= queue_capacity
        );
        Self {
            limiter: MutationLimiter::new(worker_count, per_user.min(worker_count)),
            admission: MutationLimiter::new(queue_capacity, per_user_queue_capacity),
        }
    }

    /// Partition the existing total budget, reserving both worker and admission capacity.
    /// A deliberately one-worker deployment cannot isolate classes and shares its sole worker.
    pub fn partition(
        workers: usize,
        per_user: usize,
        queue: usize,
        per_user_queue: usize,
    ) -> (Self, Self) {
        if workers == 1 {
            let shared = Self::new(workers, per_user, queue, per_user_queue);
            return (shared.clone(), shared);
        }
        let interactive_workers = workers.div_ceil(2);
        let bulk_workers = workers - interactive_workers;
        let interactive_queue = queue.div_ceil(2).max(interactive_workers);
        let bulk_queue = (queue - interactive_queue).max(bulk_workers);
        let class = |workers: usize, queue: usize| {
            Self::new(
                workers,
                per_user.min(workers),
                queue,
                per_user_queue.min(queue).max(per_user.min(workers)),
            )
        };
        (
            class(interactive_workers, interactive_queue),
            class(bulk_workers, bulk_queue),
        )
    }

    pub async fn acquire(&self, user_id: &str) -> Result<QueuedMutationPermit, LoadShedError> {
        crate::db::release_request_connection().await;
        let admission = self.admission.try_acquire(user_id).map_err(|()| {
            LoadShedError::service_unavailable("recursive operation capacity is full")
        })?;
        let worker = self.limiter.acquire(user_id).await;
        Ok(QueuedMutationPermit {
            _admission: admission,
            _worker: worker,
        })
    }
}

impl AppState {
    pub async fn acquire_recursive_operation(
        &self,
        user_id: &str,
    ) -> Result<QueuedMutationPermit, LoadShedError> {
        self.db.release_request_connection().await;
        let started = Instant::now();
        let result = self.recursive_operation_limiter.acquire(user_id).await;
        self.metrics
            .record_admission_wait("bulk", started.elapsed(), result.is_ok());
        result
    }

    pub async fn acquire_interactive_operation(
        &self,
        user_id: &str,
    ) -> Result<QueuedMutationPermit, LoadShedError> {
        self.db.release_request_connection().await;
        let started = Instant::now();
        let result = self.interactive_operation_limiter.acquire(user_id).await;
        self.metrics
            .record_admission_wait("interactive", started.elapsed(), result.is_ok());
        result
    }
}

impl AsyncOperationService {
    pub fn new(
        worker_count: usize,
        per_user: usize,
        queue_capacity: usize,
        per_user_queue_capacity: usize,
    ) -> Self {
        assert!(
            worker_count > 0
                && per_user > 0
                && queue_capacity >= worker_count
                && per_user_queue_capacity >= per_user
                && per_user_queue_capacity <= queue_capacity
        );
        Self {
            limiter: MutationLimiter::new(worker_count, per_user.min(worker_count)),
            admission: MutationLimiter::new(queue_capacity, per_user_queue_capacity),
        }
    }

    pub async fn run<T, Operation>(
        &self,
        user_id: &str,
        operation: Operation,
    ) -> Result<T, LoadShedError>
    where
        Operation: Future<Output = T>,
    {
        crate::db::release_request_connection().await;
        let _admission = self
            .admission
            .try_acquire(user_id)
            .map_err(|()| LoadShedError::service_unavailable("storage operation queue is full"))?;
        let _worker = self.limiter.acquire(user_id).await;
        Ok(operation.await)
    }
}

impl MutationLimiter {
    pub fn new(global: usize, per_user: usize) -> Self {
        assert!(global > 0 && per_user > 0);
        Self {
            global: Arc::new(Semaphore::new(global)),
            users: Arc::new(Mutex::new(HashMap::new())),
            per_user,
        }
    }

    pub async fn acquire(&self, user_id: &str) -> MutationPermit {
        let user_limiter = self.user_limiter(user_id);
        let user = user_limiter
            .acquire_owned()
            .await
            .expect("mutation limiter is never closed");
        let global = Arc::clone(&self.global)
            .acquire_owned()
            .await
            .expect("mutation limiter is never closed");

        MutationPermit {
            _user: user,
            _global: global,
        }
    }

    pub fn try_acquire(&self, user_id: &str) -> Result<MutationPermit, ()> {
        let user = self
            .user_limiter(user_id)
            .try_acquire_owned()
            .map_err(|_| ())?;
        let global = Arc::clone(&self.global)
            .try_acquire_owned()
            .map_err(|_| ())?;
        Ok(MutationPermit {
            _user: user,
            _global: global,
        })
    }

    fn user_limiter(&self, user_id: &str) -> Arc<Semaphore> {
        let mut users = self.users.lock().unwrap_or_else(|error| error.into_inner());
        if users.len() > 1_024 {
            users.retain(|_, limiter| limiter.strong_count() > 0);
        }
        if let Some(limiter) = users.get(user_id).and_then(Weak::upgrade) {
            limiter
        } else {
            let limiter = Arc::new(Semaphore::new(self.per_user));
            users.insert(user_id.to_owned(), Arc::downgrade(&limiter));
            limiter
        }
    }
}

#[cfg(test)]
pub(crate) async fn database_test_state(pool_size: usize) -> actix_web::web::Data<AppState> {
    let mut config = Config::from_env().expect("test configuration");
    config.e2ee_mode = crate::config::E2eeMode::Migrate;
    config.storage_backend = "local".to_owned();
    config.storage_path = std::env::temp_dir()
        .join("aeralyth-resource-tests")
        .display()
        .to_string();
    let metrics = Metrics::new(&config);
    let settings = crate::db::DatabasePoolSettings {
        role: crate::db::PoolRole::Request,
        max_size: pool_size,
        min_size: pool_size,
        checkout_queue_capacity: pool_size * 4,
        wait_timeout: Duration::from_millis(250),
        max_lifetime: Duration::from_secs(1800),
        lifetime_jitter: Duration::from_secs(600),
    };
    let db = Database::create(&config.database_url, settings, metrics.clone())
        .await
        .unwrap();
    let maintenance = Database::create(
        &config.database_url,
        crate::db::DatabasePoolSettings {
            role: crate::db::PoolRole::Maintenance,
            ..settings
        },
        metrics.clone(),
    )
    .await
    .unwrap();
    let storage = Storage::create(&config, metrics.clone()).await.unwrap();
    let (interactive_operation_limiter, recursive_operation_limiter) =
        QueuedMutationLimiter::partition(2, 1, 8, 4);
    actix_web::web::Data::new(AppState {
        config,
        database_pools: DatabasePoolMonitor::new(&db, &maintenance),
        db,
        database_readiness: ReadinessCache::new(Duration::from_secs(1)),
        metrics,
        passwords: PasswordService::new(1, 4).unwrap(),
        login_rate_limiter: LoginRateLimiter::new(Duration::from_secs(60), 10, 10),
        storage,
        bucket_usage: crate::bucket_usage::BucketUsageCache::new(maintenance),
        realtime: crate::realtime::RealtimeHub::new(),
        upload_control_limiter: MutationLimiter::new(8, 4),
        recursive_operation_limiter,
        interactive_operation_limiter,
        storage_operations: AsyncOperationService::new(1, 1, 4, 2),
        vault_validation: VaultValidationService::new(1, 1, 4, 2),
        interactive_validation: VaultValidationService::new(1, 1, 4, 2),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use actix_web::ResponseError;

    use super::{
        AsyncOperationService, LoadShedError, MutationLimiter, QueuedMutationLimiter,
        VaultValidationError, VaultValidationService,
    };

    #[actix_web::test]
    async fn mutation_limiter_caps_each_user_without_blocking_other_users() {
        let limiter = MutationLimiter::new(4, 2);
        let first = limiter.acquire("user-a").await;
        let second = limiter.acquire("user-a").await;
        let other_user =
            tokio::time::timeout(Duration::from_millis(250), limiter.acquire("user-b"))
                .await
                .expect("another user should retain capacity");
        assert!(
            tokio::time::timeout(Duration::from_millis(10), limiter.acquire("user-a"))
                .await
                .is_err()
        );

        drop(first);
        tokio::time::timeout(Duration::from_millis(250), limiter.acquire("user-a"))
            .await
            .expect("released per-user capacity should be reusable");
        drop(second);
        drop(other_user);
    }

    #[actix_web::test]
    async fn direct_admission_sheds_instead_of_creating_unbounded_waiters() {
        let limiter = MutationLimiter::new(1, 1);
        let _active = limiter.try_acquire("user-a").unwrap();

        assert!(limiter.try_acquire("user-b").is_err());

        let response = LoadShedError::too_many_requests("upload capacity is full").error_response();
        assert_eq!(
            response.status(),
            actix_web::http::StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(response.headers().get("retry-after").unwrap(), "1");
    }

    #[actix_web::test]
    async fn queued_mutation_limiter_waits_for_normal_overlap_and_sheds_excess() {
        let limiter = QueuedMutationLimiter::new(1, 1, 2, 2);
        let active = limiter.acquire("user-a").await.unwrap();
        let waiting_limiter = limiter.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let waiting = actix_web::rt::spawn(async move {
            started_tx.send(()).unwrap();
            waiting_limiter.acquire("user-a").await.unwrap()
        });
        started_rx.await.unwrap();

        let rejected = match limiter.acquire("user-a").await {
            Err(error) => error,
            Ok(_) => panic!("a third same-user operation must exceed the bounded queue"),
        };
        assert_eq!(
            rejected.error_response().status(),
            actix_web::http::StatusCode::SERVICE_UNAVAILABLE
        );

        drop(active);
        tokio::time::timeout(Duration::from_millis(250), waiting)
            .await
            .expect("one bounded waiter should receive the released worker slot")
            .unwrap();
    }

    #[test]
    fn recursive_queue_does_not_hold_a_request_database_connection_while_waiting() {
        let source = include_str!("state.rs");
        let helper = source
            .split_once("pub async fn acquire_recursive_operation(")
            .and_then(|(_, tail)| tail.split_once("impl AsyncOperationService"))
            .map(|(helper, _)| helper)
            .expect("recursive acquisition helper source should remain inspectable");
        let release = helper
            .find("release_request_connection")
            .expect("the request-scoped database connection must be released");
        let wait = helper
            .find("recursive_operation_limiter.acquire")
            .expect("the bounded recursive queue must be acquired");
        assert!(release < wait);
    }

    #[actix_web::test]
    async fn async_operation_queue_is_bounded_and_returns_retry_hint() {
        let service = AsyncOperationService::new(1, 1, 1, 1);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let active_service = service.clone();
        let active = actix_web::rt::spawn(async move {
            active_service
                .run("user-a", async move {
                    started_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                })
                .await
        });
        started_rx.await.unwrap();

        let rejected = service.run("user-b", async {}).await.unwrap_err();
        let response = rejected.error_response();
        assert_eq!(
            response.status(),
            actix_web::http::StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(response.headers().get("retry-after").unwrap(), "1");

        release_tx.send(()).unwrap();
        active.await.unwrap().unwrap();
    }

    #[actix_web::test]
    async fn vault_validation_is_bounded_and_does_not_stall_async_progress() {
        let service = VaultValidationService::new(2, 2, 4, 4);
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..4 {
            let service = service.clone();
            let active = Arc::clone(&active);
            let peak = Arc::clone(&peak);
            tasks.push(actix_web::rt::spawn(async move {
                service
                    .run("user-a", move || {
                        let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(100));
                        active.fetch_sub(1, Ordering::SeqCst);
                    })
                    .await
            }));
        }

        tokio::time::timeout(Duration::from_millis(250), async {
            while active.load(Ordering::SeqCst) < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("two validation workers should be actively running");
        tokio::time::timeout(Duration::from_millis(20), async {
            tokio::time::sleep(Duration::from_millis(5)).await;
        })
        .await
        .expect("health-sized async work must progress while validation is active");
        for task in tasks {
            task.await.unwrap().unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 2);
    }

    #[actix_web::test]
    async fn vault_validation_rejects_work_beyond_its_bounded_queue() {
        let service = VaultValidationService::new(1, 1, 1, 1);
        let (started_tx, started_rx) = std::sync::mpsc::sync_channel(0);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(0);
        let first_service = service.clone();
        let first = actix_web::rt::spawn(async move {
            first_service
                .run("user-a", move || {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                })
                .await
        });
        tokio::task::spawn_blocking(move || started_rx.recv().unwrap())
            .await
            .unwrap();

        assert!(matches!(
            service.run("user-b", || ()).await,
            Err(VaultValidationError::Busy)
        ));
        release_tx.send(()).unwrap();
        first.await.unwrap().unwrap();
    }

    #[actix_web::test]
    async fn vault_validation_admission_preserves_capacity_for_other_users() {
        let service = VaultValidationService::new(2, 1, 2, 1);
        let (started_tx, started_rx) = std::sync::mpsc::sync_channel(0);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(0);
        let first_service = service.clone();
        let first = actix_web::rt::spawn(async move {
            first_service
                .run("user-a", move || {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                })
                .await
        });
        tokio::task::spawn_blocking(move || started_rx.recv().unwrap())
            .await
            .unwrap();

        assert!(matches!(
            service.run("user-a", || ()).await,
            Err(VaultValidationError::Busy)
        ));
        let other =
            tokio::time::timeout(Duration::from_millis(100), service.run("user-b", || 42_u8))
                .await
                .expect("another user must retain global admission and worker capacity")
                .unwrap();
        assert_eq!(other, 42);

        release_tx.send(()).unwrap();
        first.await.unwrap().unwrap();
    }
    #[actix_web::test]
    async fn interactive_and_bulk_reservations_make_independent_progress() {
        let (interactive, bulk) = QueuedMutationLimiter::partition(2, 1, 8, 4);
        let held_bulk = bulk.acquire("same-user").await.unwrap();
        let browse =
            tokio::time::timeout(Duration::from_millis(100), interactive.acquire("same-user"))
                .await
                .expect("browsing cannot queue behind the same user's bulk work")
                .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(10), bulk.acquire("other-user"))
                .await
                .is_err()
        );
        drop(held_bulk);
        let bulk_progress =
            tokio::time::timeout(Duration::from_millis(100), bulk.acquire("same-user"))
                .await
                .expect("bulk retains its reserved worker under browsing")
                .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(10), interactive.acquire("other-user"))
                .await
                .is_err()
        );
        drop((browse, bulk_progress));
    }
    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn storage_admission_wait_releases_the_request_pool() {
        let state = super::database_test_state(1).await;
        let service = state.storage_operations.clone();
        let (release, wait) = tokio::sync::oneshot::channel::<()>();
        let (occupied, occupied_rx) = tokio::sync::oneshot::channel::<()>();
        let provider = actix_web::rt::spawn(async move {
            service
                .run("provider-user", async {
                    occupied.send(()).unwrap();
                    wait.await.unwrap();
                })
                .await
                .unwrap();
        });
        occupied_rx.await.unwrap();
        let (queued, queued_rx) = tokio::sync::oneshot::channel::<()>();
        let waiting = crate::db::scope_request(async {
            state.db.query_one("SELECT 1", &[]).await.unwrap();
            queued.send(()).unwrap();
            state
                .storage_operations
                .run("waiting-user", async { 42 })
                .await
                .unwrap()
        });
        let browse = async {
            queued_rx.await.unwrap();
            tokio::task::yield_now().await;
            tokio::time::timeout(
                Duration::from_millis(150),
                state.db.query_one("SELECT 1", &[]),
            )
            .await
            .expect("storage waiter must release authentication's only connection")
            .unwrap();
            release.send(()).unwrap();
        };
        let ((result, _), ()) = tokio::join!(waiting, browse);
        assert_eq!(result, 42);
        provider.await.unwrap();
        assert_eq!(state.db.status().available, state.db.status().size);
    }
    #[actix_web::test]
    async fn metadata_cpu_capacity_is_reserved_during_publication_validation() {
        let (interactive, bulk) = VaultValidationService::partition(2, 1, 8, 4);
        let (release, receive) = std::sync::mpsc::channel();
        let (started, ready) = tokio::sync::oneshot::channel();
        let publication = actix_web::rt::spawn(async move {
            bulk.run("same-user", move || {
                started.send(()).unwrap();
                receive.recv().unwrap();
            })
            .await
            .unwrap();
        });
        ready.await.unwrap();
        let metadata = tokio::time::timeout(
            Duration::from_millis(100),
            interactive.run("same-user", || 42),
        )
        .await
        .expect("metadata CPU must not queue behind publication validation")
        .unwrap();
        assert_eq!(metadata, 42);
        release.send(()).unwrap();
        publication.await.unwrap();
    }
    #[actix_web::test]
    async fn single_cpu_prioritizes_metadata_without_adding_a_worker() {
        let (interactive, bulk) = VaultValidationService::partition(1, 1, 8, 4);
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (release, receive) = std::sync::mpsc::channel();
        let (started, ready) = tokio::sync::oneshot::channel();
        let active_service = bulk.clone();
        let active = actix_web::rt::spawn(async move {
            active_service
                .run("same-user", move || {
                    started.send(()).unwrap();
                    receive.recv().unwrap();
                })
                .await
                .unwrap();
        });
        ready.await.unwrap();
        let bulk_order = order.clone();
        let queued_bulk = actix_web::rt::spawn(async move {
            bulk.run("same-user", move || bulk_order.lock().unwrap().push("bulk"))
                .await
                .unwrap();
        });
        let interactive_service = interactive.clone();
        let interactive_order = order.clone();
        let metadata = actix_web::rt::spawn(async move {
            interactive_service
                .run("same-user", move || {
                    interactive_order.lock().unwrap().push("metadata")
                })
                .await
                .unwrap();
        });
        let priority = &interactive.priority.as_ref().unwrap().0;
        tokio::time::timeout(Duration::from_millis(100), async {
            loop {
                if priority.state.lock().unwrap().interactive_waiters == 1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(
            order.lock().unwrap().is_empty(),
            "a second CPU operation must not start while the only worker is active"
        );
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            active.await.unwrap();
            metadata.await.unwrap();
            queued_bulk.await.unwrap();
        })
        .await
        .unwrap();
        assert_eq!(*order.lock().unwrap(), vec!["metadata", "bulk"]);
    }

    #[actix_web::test]
    async fn single_cpu_cancelled_waiter_does_not_block_other_class() {
        let priority = super::PriorityCpuAdmission::new();
        let held = priority.acquire(false).await;
        let waiting = priority.clone();
        let task = actix_web::rt::spawn(async move { waiting.acquire(true).await });
        while priority.state.lock().unwrap().interactive_waiters == 0 {
            tokio::task::yield_now().await;
        }
        task.abort();
        assert!(task.await.is_err());
        assert_eq!(priority.state.lock().unwrap().interactive_waiters, 0);
        drop(held);
        let _permit = tokio::time::timeout(Duration::from_millis(100), priority.acquire(false))
            .await
            .unwrap();
    }
}
