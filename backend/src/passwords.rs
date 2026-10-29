use std::collections::HashMap;
use std::error::Error as StdError;
use std::fmt;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Semaphore;

// One-password credentials are 32-byte Argon2id outputs derived in the browser, so
// bcrypt only adds a cheap server-side layer. Raw legacy passwords get no client
// stretching and need a real work factor.
const BCRYPT_COST: u32 = 6;
const LEGACY_PASSWORD_BCRYPT_COST: u32 = 12;
const DUMMY_PASSWORD: &str = "aeralyth-invalid-login";
const MAX_TRACKED_LOGIN_KEYS: usize = 4_096;

#[derive(Clone)]
pub struct PasswordService {
    workers: Arc<Semaphore>,
    admission: Arc<Semaphore>,
    dummy_hash: Arc<str>,
}

#[derive(Debug)]
pub enum PasswordError {
    Busy,
    Bcrypt(bcrypt::BcryptError),
    Worker(tokio::task::JoinError),
}

impl fmt::Display for PasswordError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Busy => formatter.write_str("password worker queue is full"),
            Self::Bcrypt(error) => write!(formatter, "password operation failed: {error}"),
            Self::Worker(error) => write!(formatter, "password worker failed: {error}"),
        }
    }
}

impl StdError for PasswordError {}

impl PasswordService {
    pub fn new(worker_count: usize, queue_capacity: usize) -> Result<Self, PasswordError> {
        assert!(worker_count > 0 && queue_capacity >= worker_count);
        let dummy_hash = bcrypt::hash(DUMMY_PASSWORD, BCRYPT_COST)
            .map_err(PasswordError::Bcrypt)?
            .into();

        Ok(Self {
            workers: Arc::new(Semaphore::new(worker_count)),
            admission: Arc::new(Semaphore::new(queue_capacity)),
            dummy_hash,
        })
    }

    /// Hash a client-derived one-password credential.
    pub async fn hash(&self, credential: &str) -> Result<String, PasswordError> {
        let credential = credential.to_owned();
        self.run(move || bcrypt::hash(credential, BCRYPT_COST))
            .await
    }

    /// Hash a raw human password for a legacy (`auth_version = 0`) account.
    pub async fn hash_legacy_password(&self, password: &str) -> Result<String, PasswordError> {
        let password = password.to_owned();
        self.run(move || bcrypt::hash(password, LEGACY_PASSWORD_BCRYPT_COST))
            .await
    }

    pub async fn verify_candidate(
        &self,
        password: &str,
        stored_hash: Option<&str>,
    ) -> Result<bool, PasswordError> {
        let has_candidate = stored_hash.is_some();
        let password = password.to_owned();
        let stored_hash = stored_hash.unwrap_or(&self.dummy_hash).to_owned();
        let verified = self
            .run(move || bcrypt::verify(password, &stored_hash))
            .await?;
        Ok(has_candidate && verified)
    }

    async fn run<T, Operation>(&self, operation: Operation) -> Result<T, PasswordError>
    where
        T: Send + 'static,
        Operation: FnOnce() -> Result<T, bcrypt::BcryptError> + Send + 'static,
    {
        let admission = Arc::clone(&self.admission)
            .try_acquire_owned()
            .map_err(|_| PasswordError::Busy)?;
        let worker = Arc::clone(&self.workers)
            .acquire_owned()
            .await
            .expect("password worker semaphore is never closed");

        tokio::task::spawn_blocking(move || {
            let _admission = admission;
            let _worker = worker;
            operation()
        })
        .await
        .map_err(PasswordError::Worker)?
        .map_err(PasswordError::Bcrypt)
    }
}

#[derive(Clone)]
pub struct LoginRateLimiter {
    inner: Arc<Mutex<LoginRateState>>,
    window: Duration,
    per_address: u32,
    per_account: u32,
}

#[derive(Default)]
struct LoginRateState {
    addresses: HashMap<IpAddr, AttemptWindow>,
    accounts: HashMap<String, AttemptWindow>,
}

#[derive(Clone, Copy)]
struct AttemptWindow {
    started_at: Instant,
    attempts: u32,
}

impl LoginRateLimiter {
    pub fn new(window: Duration, per_address: u32, per_account: u32) -> Self {
        assert!(!window.is_zero() && per_address > 0 && per_account > 0);
        Self {
            inner: Arc::new(Mutex::new(LoginRateState::default())),
            window,
            per_address,
            per_account,
        }
    }

    pub fn allow(&self, address: IpAddr, username: &str) -> bool {
        let now = Instant::now();
        let username = username.trim().to_ascii_lowercase();
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if state.addresses.len().saturating_add(state.accounts.len()) > MAX_TRACKED_LOGIN_KEYS {
            let window = self.window;
            state
                .addresses
                .retain(|_, attempts| now.duration_since(attempts.started_at) < window);
            state
                .accounts
                .retain(|_, attempts| now.duration_since(attempts.started_at) < window);
        }

        let address_allowed = record_attempt(
            state.addresses.entry(address).or_insert(AttemptWindow {
                started_at: now,
                attempts: 0,
            }),
            now,
            self.window,
            self.per_address,
        );
        let account_allowed = record_attempt(
            state.accounts.entry(username).or_insert(AttemptWindow {
                started_at: now,
                attempts: 0,
            }),
            now,
            self.window,
            self.per_account,
        );

        address_allowed && account_allowed
    }
}

fn record_attempt(
    attempts: &mut AttemptWindow,
    now: Instant,
    window: Duration,
    limit: u32,
) -> bool {
    if now.duration_since(attempts.started_at) >= window {
        attempts.started_at = now;
        attempts.attempts = 0;
    }
    attempts.attempts = attempts.attempts.saturating_add(1);
    attempts.attempts <= limit
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};
    use std::sync::Arc;
    use std::time::Duration;

    use super::{LoginRateLimiter, PasswordError, PasswordService};

    #[actix_web::test]
    async fn password_service_verifies_postgres_bcrypt_and_rejects_missing_users() {
        let service = PasswordService::new(2, 4).expect("password service should initialize");
        let postgres_compatible = bcrypt::hash_with_result("correct horse", 6)
            .expect("test hash should be generated")
            .format_for_version(bcrypt::Version::TwoA);

        assert!(
            service
                .verify_candidate("correct horse", Some(&postgres_compatible))
                .await
                .expect("stored hash should verify")
        );
        assert!(
            !service
                .verify_candidate("wrong", Some(&postgres_compatible))
                .await
                .expect("wrong password should be a normal mismatch")
        );
        assert!(
            !service
                .verify_candidate("anything", None)
                .await
                .expect("missing users should use the dummy hash")
        );
    }

    #[actix_web::test]
    async fn password_queue_rejects_work_beyond_its_bound() {
        let service = PasswordService::new(1, 1).expect("password service should initialize");
        let _held = Arc::clone(&service.admission)
            .acquire_owned()
            .await
            .expect("test should hold the only queue slot");

        assert!(matches!(
            service.hash("password").await,
            Err(PasswordError::Busy)
        ));
    }

    #[actix_web::test]
    async fn legacy_passwords_use_a_stronger_work_factor_than_credentials() {
        let service = PasswordService::new(2, 4).expect("password service should initialize");
        let legacy = service
            .hash_legacy_password("correct horse battery")
            .await
            .expect("legacy password should hash");
        let credential = service
            .hash("client-derived-credential")
            .await
            .expect("credential should hash");

        assert!(legacy.starts_with("$2b$12$"));
        assert!(credential.starts_with("$2b$06$"));
        assert!(
            service
                .verify_candidate("correct horse battery", Some(&legacy))
                .await
                .expect("legacy hash should verify")
        );
    }

    #[test]
    fn login_limits_apply_per_address_and_per_account() {
        let address = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let other_address = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2));
        let limiter = LoginRateLimiter::new(Duration::from_secs(60), 3, 2);

        assert!(limiter.allow(address, "Alice"));
        assert!(limiter.allow(address, "alice"));
        assert!(!limiter.allow(other_address, "ALICE"));
        assert!(limiter.allow(address, "bob"));
        assert!(!limiter.allow(address, "charlie"));
    }
}
