use std::collections::HashMap;
use std::error::Error as StdError;
use std::fmt;
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::config::Config;
use crate::db::{Database, DatabasePoolMonitor};
use crate::observability::Metrics;
use crate::passwords::{LoginRateLimiter, PasswordService};
use crate::storage::Storage;

pub struct AppState {
    pub config: Config,
    pub db: Database,
    pub database_pools: DatabasePoolMonitor,
    pub metrics: Metrics,
    pub passwords: PasswordService,
    pub login_rate_limiter: LoginRateLimiter,
    pub storage: Storage,
    pub vault_mutation_limiter: MutationLimiter,
    pub vault_validation: VaultValidationService,
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
pub struct VaultValidationService {
    limiter: MutationLimiter,
    admission: MutationLimiter,
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

    fn try_acquire(&self, user_id: &str) -> Result<MutationPermit, ()> {
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

    use super::{MutationLimiter, VaultValidationError, VaultValidationService};

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
