use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::config::Config;
use crate::db::Database;
use crate::observability::Metrics;
use crate::storage::Storage;

pub struct AppState {
    pub config: Config,
    pub db: Database,
    pub metrics: Metrics,
    pub storage: Storage,
    pub vault_mutation_limiter: MutationLimiter,
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
        let user_limiter = {
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
        };
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
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::MutationLimiter;

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
}
