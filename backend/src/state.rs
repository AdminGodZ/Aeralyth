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
    pub realtime: crate::realtime::RealtimeHub,
    pub upload_control_limiter: MutationLimiter,
    pub recursive_operation_limiter: QueuedMutationLimiter,
    pub storage_operations: AsyncOperationService,
    pub vault_validation: VaultValidationService,
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
        }
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
        // Take the user's bounded queue slot before the global slot. A single user can therefore
        // fill only their own admission budget instead of occupying the entire global queue while
        // waiting for their smaller worker allowance.
        let admission = self
            .admission
            .try_acquire(user_id)
            .map_err(|()| VaultValidationError::Busy)?;
        let worker = self.limiter.acquire(user_id).await;

        tokio::task::spawn_blocking(move || {
            let _admission = admission;
            let _worker = worker;
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

    pub async fn acquire(&self, user_id: &str) -> Result<QueuedMutationPermit, LoadShedError> {
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
        self.recursive_operation_limiter.acquire(user_id).await
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
}
