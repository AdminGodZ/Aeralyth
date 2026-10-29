use std::error::Error as StdError;
use std::fmt;
use std::future::Future;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use deadpool_postgres::{
    GenericClient, Hook, HookError, Manager, ManagerConfig, Pool, RecyclingMethod, Runtime,
};
use futures_util::future::try_join_all;
use tokio::sync::Semaphore;
use tokio_postgres::types::ToSql;
use tokio_postgres::{NoTls, Row};

use crate::observability::Metrics;

tokio::task_local! {
    static REQUEST_CONNECTION: Arc<RequestConnectionSlot<deadpool_postgres::Client>>;
}

struct RequestConnectionSlot<T> {
    connection: tokio::sync::Mutex<Option<Arc<T>>>,
    checkouts: AtomicUsize,
}

impl<T> RequestConnectionSlot<T> {
    fn new() -> Self {
        Self {
            connection: tokio::sync::Mutex::new(None),
            checkouts: AtomicUsize::new(0),
        }
    }

    async fn shared_or_try_init<E, Connect, Connected>(&self, connect: Connect) -> Result<Arc<T>, E>
    where
        Connect: FnOnce() -> Connected,
        Connected: Future<Output = Result<T, E>>,
    {
        let mut connection = self.connection.lock().await;
        if let Some(connection) = connection.as_ref() {
            return Ok(Arc::clone(connection));
        }

        let connected = Arc::new(connect().await?);
        self.checkouts.fetch_add(1, Ordering::Relaxed);
        *connection = Some(Arc::clone(&connected));
        Ok(connected)
    }

    async fn take_owned(&self) -> Option<T> {
        let mut connection = self.connection.lock().await;
        let shared = connection.take()?;
        match Arc::try_unwrap(shared) {
            Ok(connection) => Some(connection),
            Err(shared) => {
                *connection = Some(shared);
                None
            }
        }
    }

    async fn clear(&self) {
        self.connection.lock().await.take();
    }

    fn record_checkout(&self) {
        self.checkouts.fetch_add(1, Ordering::Relaxed);
    }

    fn checkout_count(&self) -> usize {
        self.checkouts.load(Ordering::Relaxed)
    }
}

#[derive(Clone)]
pub struct Database {
    pool: Pool,
    role: PoolRole,
    checkout_admission: Arc<Semaphore>,
    metrics: Metrics,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PoolRole {
    Request,
    Maintenance,
}

impl PoolRole {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Request => "request",
            Self::Maintenance => "maintenance",
        }
    }
}

#[derive(Clone, Copy)]
pub struct DatabasePoolSettings {
    pub role: PoolRole,
    pub max_size: usize,
    pub min_size: usize,
    pub checkout_queue_capacity: usize,
    pub wait_timeout: Duration,
    pub max_lifetime: Duration,
    pub lifetime_jitter: Duration,
}

#[derive(Clone)]
pub struct DatabasePoolMonitor {
    request: Pool,
    maintenance: Pool,
}

#[derive(Debug)]
pub enum DatabaseError {
    Overloaded(&'static str),
    Pool(deadpool_postgres::PoolError),
    Postgres(tokio_postgres::Error),
}

impl fmt::Display for DatabaseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Overloaded(role) => {
                write!(formatter, "{role} database checkout queue is full")
            }
            Self::Pool(error) => write!(formatter, "database pool error: {error}"),
            Self::Postgres(error) => write!(formatter, "postgres error: {error}"),
        }
    }
}

impl StdError for DatabaseError {}

/// Preserve explicit checkout admission shedding as retryable HTTP overload.
/// Pool, PostgreSQL and ambiguous-write errors retain their existing 500 status.
pub(crate) fn http_error(error: DatabaseError) -> actix_web::Error {
    if matches!(error, DatabaseError::Overloaded(_)) {
        actix_web::error::InternalError::from_response(
            error,
            actix_web::HttpResponse::ServiceUnavailable()
                .insert_header((actix_web::http::header::RETRY_AFTER, "1"))
                .body("database connection capacity is busy; retry shortly"),
        )
        .into()
    } else {
        actix_web::error::ErrorInternalServerError(error)
    }
}

/// Upload helpers also return provider/IO errors. Only an exact typed database
/// error uses the mapping above; unrelated failures are not reclassified.
pub(crate) fn boxed_http_error(error: Box<dyn StdError + Send + Sync>) -> actix_web::Error {
    match error.downcast::<DatabaseError>() {
        Ok(error) => http_error(*error),
        Err(error) => actix_web::error::ErrorInternalServerError(error),
    }
}

impl From<deadpool_postgres::PoolError> for DatabaseError {
    fn from(error: deadpool_postgres::PoolError) -> Self {
        Self::Pool(error)
    }
}

impl From<tokio_postgres::Error> for DatabaseError {
    fn from(error: tokio_postgres::Error) -> Self {
        Self::Postgres(error)
    }
}

impl Database {
    pub async fn create(
        database_url: &str,
        settings: DatabasePoolSettings,
        metrics: Metrics,
    ) -> Result<Self, Box<dyn StdError + Send + Sync>> {
        Self::create_with_recycling(database_url, settings, metrics, RecyclingMethod::Verified)
            .await
    }

    async fn create_with_recycling(
        database_url: &str,
        settings: DatabasePoolSettings,
        metrics: Metrics,
        recycling_method: RecyclingMethod,
    ) -> Result<Self, Box<dyn StdError + Send + Sync>> {
        assert!(
            settings.max_size > 0
                && settings.min_size <= settings.max_size
                && settings.checkout_queue_capacity >= settings.max_size
        );
        let mut postgres_config = database_url.parse::<tokio_postgres::Config>()?;
        postgres_config.connect_timeout(Duration::from_secs(5));
        postgres_config.keepalives(true);
        postgres_config.keepalives_idle(Duration::from_secs(60));
        postgres_config.keepalives_interval(Duration::from_secs(30));
        postgres_config.keepalives_retries(3);
        postgres_config.options(
            "-c statement_timeout=10000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=15000",
        );
        let manager =
            Manager::from_config(postgres_config, NoTls, ManagerConfig { recycling_method });
        let role = settings.role;
        let created_metrics = metrics.clone();
        let recycle_metrics = metrics.clone();
        let max_lifetime = settings.max_lifetime;
        let lifetime_jitter = settings.lifetime_jitter;
        let pool = Pool::builder(manager)
            .max_size(settings.max_size)
            .wait_timeout(Some(settings.wait_timeout))
            .create_timeout(Some(Duration::from_secs(5)))
            .recycle_timeout(Some(Duration::from_secs(3)))
            .post_create(Hook::sync_fn(move |_, _| {
                created_metrics.record_pool_connection_created(role.as_str());
                Ok(())
            }))
            .pre_recycle(Hook::sync_fn(move |_, object_metrics| {
                if connection_lifetime_expired(
                    object_metrics.age(),
                    connection_jitter_seed(object_metrics.created),
                    max_lifetime,
                    lifetime_jitter,
                ) {
                    recycle_metrics.record_pool_lifetime_recycle(role.as_str());
                    return Err(HookError::message("database connection lifetime expired"));
                }

                Ok(())
            }))
            .runtime(Runtime::Tokio1)
            .build()?;
        let database = Self {
            pool,
            role,
            checkout_admission: Arc::new(Semaphore::new(settings.checkout_queue_capacity)),
            metrics,
        };

        database.prewarm(settings.min_size).await?;
        database.ping().await?;

        Ok(database)
    }

    pub async fn get(&self) -> Result<deadpool_postgres::Client, DatabaseError> {
        if self.role == PoolRole::Request
            && let Ok(slot) = REQUEST_CONNECTION.try_with(Arc::clone)
            && let Some(connection) = slot.take_owned().await
        {
            return Ok(connection);
        }

        let connection = self.checkout().await?;
        if self.role == PoolRole::Request
            && let Ok(slot) = REQUEST_CONNECTION.try_with(Arc::clone)
        {
            slot.record_checkout();
        }
        Ok(connection)
    }

    pub async fn ping(&self) -> Result<(), DatabaseError> {
        let connection = self.checkout().await?;
        query_one_cached(&connection, "SELECT 1", &[])
            .await
            .map(|_| ())
            .map_err(DatabaseError::from)
    }

    pub fn status(&self) -> deadpool_postgres::Status {
        self.pool.status()
    }

    pub async fn query(
        &self,
        sql: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<Row>, DatabaseError> {
        let client = self.shared_request_connection().await?;
        query_cached(client.as_ref(), sql, params)
            .await
            .map_err(DatabaseError::from)
    }

    pub async fn query_one(
        &self,
        sql: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Row, DatabaseError> {
        let client = self.shared_request_connection().await?;
        query_one_cached(client.as_ref(), sql, params)
            .await
            .map_err(DatabaseError::from)
    }

    pub async fn query_opt(
        &self,
        sql: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Option<Row>, DatabaseError> {
        let client = self.shared_request_connection().await?;
        query_opt_cached(client.as_ref(), sql, params)
            .await
            .map_err(DatabaseError::from)
    }

    pub async fn execute(
        &self,
        sql: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<u64, DatabaseError> {
        let client = self.shared_request_connection().await?;
        execute_cached(client.as_ref(), sql, params)
            .await
            .map_err(DatabaseError::from)
    }

    pub async fn release_request_connection(&self) {
        if self.role == PoolRole::Request {
            release_request_connection().await;
        }
    }

    async fn shared_request_connection(
        &self,
    ) -> Result<Arc<deadpool_postgres::Client>, DatabaseError> {
        if self.role == PoolRole::Request
            && let Ok(slot) = REQUEST_CONNECTION.try_with(Arc::clone)
        {
            return slot.shared_or_try_init(|| self.checkout()).await;
        }

        self.checkout().await.map(Arc::new)
    }

    async fn checkout(&self) -> Result<deadpool_postgres::Client, DatabaseError> {
        let started = Instant::now();
        let admission = match Arc::clone(&self.checkout_admission).try_acquire_owned() {
            Ok(admission) => admission,
            Err(_) => {
                self.metrics
                    .record_pool_checkout(self.role.as_str(), started.elapsed(), false);
                return Err(DatabaseError::Overloaded(self.role.as_str()));
            }
        };
        let result = self.pool.get().await.map_err(DatabaseError::from);
        drop(admission);
        self.metrics
            .record_pool_checkout(self.role.as_str(), started.elapsed(), result.is_ok());
        result
    }

    async fn prewarm(&self, min_size: usize) -> Result<(), DatabaseError> {
        let connections = try_join_all((0..min_size).map(|_| self.checkout())).await?;
        drop(connections);
        Ok(())
    }
}

impl DatabasePoolMonitor {
    pub fn new(request: &Database, maintenance: &Database) -> Self {
        assert_eq!(request.role, PoolRole::Request);
        assert_eq!(maintenance.role, PoolRole::Maintenance);
        Self {
            request: request.pool.clone(),
            maintenance: maintenance.pool.clone(),
        }
    }

    pub fn statuses(&self) -> [(&'static str, deadpool_postgres::Status); 2] {
        [
            (PoolRole::Request.as_str(), self.request.status()),
            (PoolRole::Maintenance.as_str(), self.maintenance.status()),
        ]
    }
}

fn connection_lifetime_expired(
    age: Duration,
    jitter_seed: u64,
    max_lifetime: Duration,
    lifetime_jitter: Duration,
) -> bool {
    age > jittered_lifetime(jitter_seed, max_lifetime, lifetime_jitter)
}

fn jittered_lifetime(
    jitter_seed: u64,
    max_lifetime: Duration,
    lifetime_jitter: Duration,
) -> Duration {
    let jitter_range = lifetime_jitter.as_secs();
    if jitter_range == 0 {
        return max_lifetime;
    }

    let mut mixed = jitter_seed;
    mixed ^= mixed >> 16;
    mixed = mixed.wrapping_mul(0x7feb_352d);
    mixed ^= mixed >> 15;
    mixed = mixed.wrapping_mul(0x846c_a68b);
    mixed ^= mixed >> 16;
    max_lifetime.saturating_add(Duration::from_secs(mixed % (jitter_range + 1)))
}

fn connection_jitter_seed(created_at: Instant) -> u64 {
    let mut hasher = DefaultHasher::new();
    created_at.hash(&mut hasher);
    hasher.finish()
}

/// End the implicit database phase before reading a body or waiting for non-database
/// admission. An explicitly owned client must still be scoped/dropped by its owner.
pub async fn release_request_connection() {
    if let Ok(slot) = REQUEST_CONNECTION.try_with(Arc::clone) {
        slot.clear().await;
    }
}

pub async fn scope_request<F, Output>(future: F) -> (Output, usize)
where
    F: Future<Output = Output>,
{
    let slot = Arc::new(RequestConnectionSlot::new());
    let output = REQUEST_CONNECTION.scope(Arc::clone(&slot), future).await;
    let checkouts = slot.checkout_count();
    (output, checkouts)
}

pub async fn query_cached<Client>(
    client: &Client,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Vec<Row>, tokio_postgres::Error>
where
    Client: GenericClient,
{
    let statement = client.prepare_cached(sql).await?;
    client.query(&statement, params).await
}

pub async fn query_one_cached<Client>(
    client: &Client,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Row, tokio_postgres::Error>
where
    Client: GenericClient,
{
    let statement = client.prepare_cached(sql).await?;
    client.query_one(&statement, params).await
}

pub async fn query_opt_cached<Client>(
    client: &Client,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Option<Row>, tokio_postgres::Error>
where
    Client: GenericClient,
{
    let statement = client.prepare_cached(sql).await?;
    client.query_opt(&statement, params).await
}

pub async fn execute_cached<Client>(
    client: &Client,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<u64, tokio_postgres::Error>
where
    Client: GenericClient,
{
    let statement = client.prepare_cached(sql).await?;
    client.execute(&statement, params).await
}

/// A one-connection pooled client for DB-backed tests that exercise helpers taking
/// a deadpool transaction, whose statement cache raw tokio-postgres clients lack.
#[cfg(test)]
pub(crate) async fn test_client(database_url: &str) -> deadpool_postgres::Client {
    let postgres_config = database_url
        .parse::<tokio_postgres::Config>()
        .expect("database URL should parse");
    let manager = Manager::from_config(
        postgres_config,
        NoTls,
        ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        },
    );
    Pool::builder(manager)
        .max_size(1)
        .runtime(Runtime::Tokio1)
        .build()
        .expect("test pool should build")
        .get()
        .await
        .expect("test database should connect")
}

#[cfg(test)]
mod tests {
    use super::{
        Database, DatabasePoolSettings, PoolRole, RequestConnectionSlot,
        connection_lifetime_expired, jittered_lifetime,
    };
    use crate::config::Config;
    use crate::observability::Metrics;
    use crate::state::VaultValidationService;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[actix_web::test]
    #[ignore = "requires isolated PostgreSQL for authenticated post-gap checkout shedding"]
    async fn authenticated_phase_revalidation_preserves_database_overload() {
        let state = crate::state::database_test_state(1).await;
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let user = format!("usr_revalidation_overload_{suffix}");
        let session = format!("ses_revalidation_overload_{suffix}");
        let token = format!("revalidation-overload-token-{suffix}");
        let token_hash = crate::auth::hash_session_token(&token);
        state
            .db
            .execute(
                "INSERT INTO users(id,username,password_hash,role,status) VALUES($1,$1,'test','user','active')",
                &[&user],
            )
            .await
            .unwrap();
        state
            .db
            .execute(
                "INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,'csrf',now()+interval '1 hour')",
                &[&session, &user, &token_hash.as_slice()],
            )
            .await
            .unwrap();
        let request = actix_web::test::TestRequest::get()
            .cookie(actix_web::cookie::Cookie::new(
                crate::auth::SESSION_COOKIE,
                token,
            ))
            .to_http_request();
        let (response, _) = super::scope_request(async {
            let principal = crate::auth::require_principal(&state, &request)
                .await
                .expect("first request phase must authenticate against PostgreSQL");
            assert_eq!(principal.id, user);
            super::release_request_connection().await;

            let held = state.db.get().await.unwrap();
            let capacity = state.db.checkout_admission.available_permits();
            let mut queued = Vec::new();
            for _ in 0..capacity {
                let database = state.db.clone();
                queued.push(tokio::spawn(async move {
                    drop(database.get().await?);
                    Ok::<(), super::DatabaseError>(())
                }));
            }
            tokio::time::timeout(Duration::from_millis(100), async {
                while state.db.checkout_admission.available_permits() != 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("real checkout waiters must fill admission during the request gap");

            let error = tokio::time::timeout(
                Duration::from_millis(100),
                crate::auth::revalidate_principal(&state, &request),
            )
            .await
            .expect("phase revalidation must shed without waiting for the pool")
            .expect_err("cached authentication must not bypass a fresh phase checkout");
            let response = error.error_response();
            drop(held);
            for waiter in queued {
                waiter
                    .await
                    .unwrap()
                    .expect("the released connection must drain all admitted waiters");
            }
            assert_eq!(state.db.checkout_admission.available_permits(), capacity);
            let recovered = crate::auth::require_principal(&state, &request)
                .await
                .expect("authentication must recover after temporary database overload");
            assert_eq!(recovered.id, user);
            response
        })
        .await;
        state
            .db
            .execute("DELETE FROM users WHERE id=$1", &[&user])
            .await
            .unwrap();
        assert_eq!(state.db.status().available, state.db.status().size);
        assert_eq!(
            response.status(),
            actix_web::http::StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(response.headers().get("retry-after").unwrap(), "1");
    }

    #[actix_web::test]
    #[ignore = "requires isolated PostgreSQL for real full checkout queue"]
    async fn full_database_queue_returns_retryable_authentication_overload() {
        let state = crate::state::database_test_state(1).await;
        let held = state.db.get().await.unwrap();
        let capacity = state.db.checkout_admission.available_permits();
        let mut queued = Vec::new();
        for _ in 0..capacity {
            let database = state.db.clone();
            queued.push(tokio::spawn(async move {
                drop(database.get().await?);
                Ok::<(), super::DatabaseError>(())
            }));
        }
        tokio::time::timeout(Duration::from_millis(100), async {
            while state.db.checkout_admission.available_permits() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("actual checkout waiters should fill the bounded queue");
        let request = actix_web::test::TestRequest::get()
            .cookie(actix_web::cookie::Cookie::new(
                crate::auth::SESSION_COOKIE,
                "synthetic-overload-probe",
            ))
            .to_http_request();
        let error = crate::auth::require_principal(&state, &request)
            .await
            .expect_err("full checkout admission must reject before the query");
        let response = error.error_response();
        let status = response.status();
        let retry_after = response.headers().get("retry-after").cloned();
        let read_error = state.db.query_one("SELECT 1", &[]).await.unwrap_err();
        let read_response = super::http_error(read_error).error_response();
        let upload_error = crate::upload_completion::defer_file_upload_completion(
            &state.db,
            "synthetic-upload",
            "synthetic-owner",
            "synthetic-lease",
            "test provider gap",
            1,
        )
        .await
        .unwrap_err();
        let upload_response = super::boxed_http_error(upload_error).error_response();
        drop(held);
        for waiter in queued {
            waiter
                .await
                .unwrap()
                .expect("released slot should drain the queue");
        }
        assert_eq!(state.db.checkout_admission.available_permits(), capacity);
        eprintln!(
            "full database queue authentication response: {status}, retry-after={retry_after:?}"
        );
        assert_eq!(status, actix_web::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(retry_after.unwrap(), "1");
        for response in [read_response, upload_response] {
            assert_eq!(
                response.status(),
                actix_web::http::StatusCode::SERVICE_UNAVAILABLE
            );
            assert_eq!(response.headers().get("retry-after").unwrap(), "1");
        }
        let query_error = state.db.query_one("SELECT 1 / 0", &[]).await.unwrap_err();
        let response = super::http_error(query_error).error_response();
        assert_eq!(
            response.status(),
            actix_web::http::StatusCode::INTERNAL_SERVER_ERROR
        );
        assert!(response.headers().get("retry-after").is_none());
    }

    #[test]
    fn database_overload_mapping_preserves_non_admission_failures() {
        for error in [
            deadpool_postgres::PoolError::Closed,
            deadpool_postgres::PoolError::Timeout(deadpool_postgres::TimeoutType::Wait),
        ] {
            let response = super::http_error(super::DatabaseError::Pool(error)).error_response();
            assert_eq!(
                response.status(),
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR
            );
            assert!(response.headers().get("retry-after").is_none());
        }
        let response = super::boxed_http_error(Box::new(std::io::Error::other(
            "provider failure after possible publication",
        )))
        .error_response();
        assert_eq!(
            response.status(),
            actix_web::http::StatusCode::INTERNAL_SERVER_ERROR
        );
        assert!(response.headers().get("retry-after").is_none());
    }

    #[actix_web::test]
    async fn request_connection_is_initialized_once_and_can_be_handed_off() {
        let slot = RequestConnectionSlot::new();
        let connects = AtomicUsize::new(0);

        let first = slot
            .shared_or_try_init(|| async {
                connects.fetch_add(1, Ordering::Relaxed);
                Ok::<_, ()>(42_u32)
            })
            .await
            .expect("first connection should initialize");
        let second = slot
            .shared_or_try_init(|| async {
                connects.fetch_add(1, Ordering::Relaxed);
                Ok::<_, ()>(99_u32)
            })
            .await
            .expect("second connection should reuse the request connection");

        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(connects.load(Ordering::Relaxed), 1);
        assert_eq!(slot.checkout_count(), 1);

        drop(first);
        drop(second);
        assert_eq!(slot.take_owned().await, Some(42));
    }

    #[test]
    fn healthy_idle_connections_are_not_recycled() {
        let source = include_str!("db.rs");
        let forbidden_idle_check = ["last_", "used()"].concat();
        assert!(
            !source.contains(&forbidden_idle_check),
            "idle time must not force a healthy reconnect"
        );
        assert!(!connection_lifetime_expired(
            Duration::from_secs(10 * 60),
            42,
            Duration::from_secs(30 * 60),
            Duration::from_secs(10 * 60),
        ));
    }

    #[test]
    fn hot_transaction_paths_prepare_statements_through_the_cache() {
        // `db` is the `Database` wrapper, whose query methods already use
        // `prepare_cached`. Any other receiver re-prepares a `&str` statement
        // on every call, so it must go through the `*_cached` helpers instead.
        const CACHED_RECEIVERS: &[&str] = &["db"];
        // Deliberately uncached statements as (source, receiver, method), e.g.
        // genuinely dynamic one-off SQL that would only bloat the cache.
        const UNCACHED_EXCEPTIONS: &[(&str, &str, &str)] = &[];
        let tests_module = ["\n#[cfg(test)]\n", "mod tests {"].concat();
        for (name, source) in [
            ("vault", include_str!("routes/vault.rs")),
            (
                "vault metadata paging",
                include_str!("routes/vault_metadata_paging.rs"),
            ),
            ("tree jobs", include_str!("routes/tree_jobs.rs")),
        ] {
            let production = source
                .split(&tests_module)
                .next()
                .expect("split always yields the leading source");
            for method in ["query", "query_one", "query_opt", "query_raw", "execute"] {
                let call = format!(".{method}(");
                for (offset, _) in production.match_indices(&call) {
                    let before = production[..offset].trim_end();
                    let receiver = &before[before
                        .rfind(|character: char| !(character.is_alphanumeric() || character == '_'))
                        .map_or(0, |index| index + 1)..];
                    assert!(
                        CACHED_RECEIVERS.contains(&receiver)
                            || UNCACHED_EXCEPTIONS.contains(&(name, receiver, method)),
                        "{name} calls `{receiver}.{method}` without the statement cache; use `{method}_cached`"
                    );
                }
            }
        }
    }

    #[test]
    fn maximum_lifetime_is_staggered_per_connection() {
        let base = Duration::from_secs(30 * 60);
        let jitter = Duration::from_secs(10 * 60);
        let first = jittered_lifetime(10_001, base, jitter);
        let second = jittered_lifetime(10_002, base, jitter);

        assert!((base..=base + jitter).contains(&first));
        assert!((base..=base + jitter).contains(&second));
        assert_ne!(first, second);
        assert!(!connection_lifetime_expired(first, 10_001, base, jitter));
        assert!(connection_lifetime_expired(
            first + Duration::from_nanos(1),
            10_001,
            base,
            jitter,
        ));
    }

    #[actix_web::test]
    async fn request_pool_remains_available_when_maintenance_is_saturated() {
        if std::env::var("AERALYTH_DATABASE_INTEGRATION_TESTS").as_deref() != Ok("1") {
            return;
        }

        let config = Config::from_env().expect("database integration configuration should load");
        let metrics = Metrics::new(&config);
        let settings = DatabasePoolSettings {
            role: PoolRole::Request,
            max_size: 1,
            min_size: 1,
            checkout_queue_capacity: 1,
            wait_timeout: Duration::from_millis(100),
            max_lifetime: Duration::from_secs(30 * 60),
            lifetime_jitter: Duration::from_secs(10 * 60),
        };
        let request = Database::create(&config.database_url, settings, metrics.clone())
            .await
            .expect("request pool should connect");
        let maintenance = Database::create(
            &config.database_url,
            DatabasePoolSettings {
                role: PoolRole::Maintenance,
                ..settings
            },
            metrics,
        )
        .await
        .expect("maintenance pool should connect");
        let held_maintenance = maintenance
            .get()
            .await
            .expect("test should saturate the maintenance pool");

        tokio::time::timeout(Duration::from_millis(250), request.ping())
            .await
            .expect("request pool was starved by maintenance")
            .expect("request pool should remain healthy");
        assert!(maintenance.ping().await.is_err());

        drop(held_maintenance);
    }

    #[actix_web::test]
    async fn released_request_lease_keeps_health_available_during_validation_saturation() {
        if std::env::var("AERALYTH_DATABASE_INTEGRATION_TESTS").as_deref() != Ok("1") {
            return;
        }

        let config = Config::from_env().expect("database integration configuration should load");
        let request = Database::create(
            &config.database_url,
            DatabasePoolSettings {
                role: PoolRole::Request,
                max_size: 1,
                min_size: 1,
                checkout_queue_capacity: 1,
                wait_timeout: Duration::from_millis(100),
                max_lifetime: Duration::from_secs(30 * 60),
                lifetime_jitter: Duration::from_secs(10 * 60),
            },
            Metrics::new(&config),
        )
        .await
        .expect("request pool should connect");
        let route_lease = request
            .get()
            .await
            .expect("the simulated route should acquire its read lease");
        drop(route_lease);

        let validation = VaultValidationService::new(2, 2, 2, 2);
        let active = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..2 {
            let validation = validation.clone();
            let active = Arc::clone(&active);
            tasks.push(actix_web::rt::spawn(async move {
                validation
                    .run("user-a", move || {
                        active.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(250));
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
        .expect("validation workers should be saturated");

        tokio::time::timeout(Duration::from_millis(100), request.ping())
            .await
            .expect("health ping waited for a lease retained by validation")
            .expect("health ping should remain available");
        for task in tasks {
            task.await.unwrap().unwrap();
        }
    }
    struct SafeReadRecovery {
        failed_reads: usize,
        terminated_backend_reads: usize,
        elapsed: Duration,
    }

    // Fault injection signals termination before the driver's closed flag must be set.
    // Retry only this harmless probe, retaining its successful client for any new write.
    // A successful read on the signalled backend does not establish recovery.
    async fn recover_safe_read(
        db: &Database,
        policy: &str,
        phase: &str,
        terminated_pid: Option<i32>,
    ) -> (deadpool_postgres::Client, SafeReadRecovery) {
        let started = tokio::time::Instant::now();
        let deadline = started + Duration::from_secs(1);
        let mut failed_reads = 0;
        let mut terminated_backend_reads = 0;
        let mut last_error = None;
        loop {
            let probe = async {
                let client = db.get().await?;
                let row =
                    super::query_one_cached(&client, "SELECT 1, pg_backend_pid()", &[]).await?;
                assert_eq!(row.get::<_, i32>(0), 1);
                Ok::<_, super::DatabaseError>((client, row.get::<_, i32>(1)))
            };
            match tokio::time::timeout_at(deadline, probe).await {
                Ok(Ok((client, pid))) if Some(pid) != terminated_pid => {
                    return (
                        client,
                        SafeReadRecovery {
                            failed_reads,
                            terminated_backend_reads,
                            elapsed: started.elapsed(),
                        },
                    );
                }
                Ok(Ok((client, _))) => {
                    terminated_backend_reads += 1;
                    drop(client);
                }
                Ok(Err(error)) => {
                    failed_reads += 1;
                    last_error = Some(error.to_string());
                }
                Err(_) => {
                    failed_reads += 1;
                    panic!(
                        "safe-read recovery exceeded 1s: policy={policy} phase={phase} failed_reads={failed_reads} terminated_backend_reads={terminated_backend_reads} last_error={last_error:?}"
                    );
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "safe-read recovery exceeded 1s: policy={policy} phase={phase} failed_reads={failed_reads} terminated_backend_reads={terminated_backend_reads} last_error={last_error:?}"
            );
            tokio::time::sleep_until(
                (tokio::time::Instant::now() + Duration::from_millis(5)).min(deadline),
            )
            .await;
        }
    }

    #[actix_web::test]
    #[ignore = "explicit PostgreSQL recycling benchmark and fault injection"]
    async fn compare_verified_and_fast_recycling_with_connection_faults() {
        use super::RecyclingMethod;
        use std::time::Instant;
        let config = Config::from_env().unwrap();
        let (admin, connection) =
            tokio_postgres::connect(&config.database_url, tokio_postgres::NoTls)
                .await
                .unwrap();
        actix_web::rt::spawn(async move {
            let _ = connection.await;
        });
        admin
            .batch_execute(
                "CREATE TABLE IF NOT EXISTS performance_recycling_writes(id bigint PRIMARY KEY)",
            )
            .await
            .unwrap();
        let settings = DatabasePoolSettings {
            role: PoolRole::Request,
            max_size: 1,
            min_size: 1,
            checkout_queue_capacity: 4,
            wait_timeout: Duration::from_millis(250),
            max_lifetime: Duration::from_secs(1800),
            lifetime_jitter: Duration::from_secs(600),
        };
        for (policy, recycling) in [
            ("verified", RecyclingMethod::Verified),
            ("fast", RecyclingMethod::Fast),
        ] {
            let db = Database::create_with_recycling(
                &config.database_url,
                settings,
                Metrics::new(&config),
                recycling,
            )
            .await
            .unwrap();
            let mut checkout_us = Vec::new();
            let mut request_us = Vec::new();
            for sample in 0..520 {
                let started = Instant::now();
                let client = db.get().await.unwrap();
                let checkout = started.elapsed().as_micros();
                super::query_one_cached(&client, "SELECT 1", &[])
                    .await
                    .unwrap();
                if sample >= 20 {
                    checkout_us.push(checkout);
                    request_us.push(started.elapsed().as_micros());
                }
                drop(client);
            }
            checkout_us.sort_unstable();
            request_us.sort_unstable();
            assert_eq!(checkout_us.len(), 500);
            assert_eq!(request_us.len(), 500);
            let mut failures = 0;
            let mut terminated_backend_reads = 0;
            let mut recovery_us = Vec::new();
            for _ in 0..25 {
                let client = db.get().await.unwrap();
                let pid: i32 = client
                    .query_one("SELECT pg_backend_pid()", &[])
                    .await
                    .unwrap()
                    .get(0);
                drop(client);
                let terminated: bool = admin
                    .query_one("SELECT pg_terminate_backend($1)", &[&pid])
                    .await
                    .unwrap()
                    .get(0);
                assert!(
                    terminated,
                    "the idle backend must receive the termination signal"
                );
                let (client, recovery) =
                    recover_safe_read(&db, policy, "idle termination", Some(pid)).await;
                failures += recovery.failed_reads;
                terminated_backend_reads += recovery.terminated_backend_reads;
                recovery_us.push(recovery.elapsed.as_micros());
                drop(client);
            }
            assert_eq!(recovery_us.len(), 25);
            recovery_us.sort_unstable();
            // Interrupt an in-flight transaction; it must fail and never be replayed.
            let id = if policy == "verified" { 1_i64 } else { 2_i64 };
            admin
                .execute(
                    "DELETE FROM performance_recycling_writes WHERE id=$1",
                    &[&id],
                )
                .await
                .unwrap();
            let mut client = db.get().await.unwrap();
            let transaction = client.transaction().await.unwrap();
            transaction
                .execute(
                    "INSERT INTO performance_recycling_writes(id) VALUES($1)",
                    &[&id],
                )
                .await
                .unwrap();
            let pid: i32 = transaction
                .query_one("SELECT pg_backend_pid()", &[])
                .await
                .unwrap()
                .get(0);
            let terminated: bool = admin
                .query_one("SELECT pg_terminate_backend($1)", &[&pid])
                .await
                .unwrap()
                .get(0);
            assert!(
                terminated,
                "the transaction backend must receive the termination signal"
            );
            assert!(transaction.commit().await.is_err());
            drop(client);
            let count: i64 = admin
                .query_one(
                    "SELECT count(*) FROM performance_recycling_writes WHERE id=$1",
                    &[&id],
                )
                .await
                .unwrap()
                .get(0);
            assert_eq!(count, 0, "an interrupted transaction must not be replayed");
            let (client, transaction_recovery) =
                recover_safe_read(&db, policy, "interrupted transaction", Some(pid)).await;
            // This is a new explicit write, attempted exactly once on the recovered client.
            client
                .execute(
                    "INSERT INTO performance_recycling_writes(id) VALUES($1)",
                    &[&id],
                )
                .await
                .unwrap();
            drop(client);
            let count: i64 = admin
                .query_one(
                    "SELECT count(*) FROM performance_recycling_writes WHERE id=$1",
                    &[&id],
                )
                .await
                .unwrap()
                .get(0);
            assert_eq!(count, 1, "an explicit successful write executes once");
            admin
                .execute(
                    "DELETE FROM performance_recycling_writes WHERE id=$1",
                    &[&id],
                )
                .await
                .unwrap();
            println!(
                "recycling policy={policy} samples=500 checkout_p95_us={} checkout_p99_us={} request_p95_us={} request_p99_us={} terminated_idle=25 failed_reads={failures} terminated_backend_reads={terminated_backend_reads} recovery_p99_us={} interrupted_write_count=0 explicit_write_count=1 transaction_recovery_failed_reads={} transaction_recovery_terminated_backend_reads={} transaction_recovery_us={}",
                checkout_us[474],
                checkout_us[494],
                request_us[474],
                request_us[494],
                recovery_us[24],
                transaction_recovery.failed_reads,
                transaction_recovery.terminated_backend_reads,
                transaction_recovery.elapsed.as_micros()
            );
            assert_eq!(db.status().available, db.status().size);
        }
        admin
            .batch_execute("DROP TABLE performance_recycling_writes")
            .await
            .unwrap();
    }
    async fn forward_faultable<R, W>(
        mut source: R,
        mut destination: W,
        mut mode: tokio::sync::watch::Receiver<u8>,
        server_responses: bool,
    ) where
        R: tokio::io::AsyncRead + Unpin,
        W: tokio::io::AsyncWrite + Unpin,
    {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut buffer = [0_u8; 8192];
        loop {
            if *mode.borrow() == 1 {
                break;
            }
            tokio::select! {
                result = source.read(&mut buffer) => {
                    let Ok(length) = result else { break; };
                    if length == 0 { break; }
                    // Mode 2 simulates losing server acknowledgements while requests arrive.
                    if !(server_responses && *mode.borrow() == 2)
                        && destination.write_all(&buffer[..length]).await.is_err() { break; }
                }
                changed = mode.changed() => { if changed.is_err() { break; } }
            }
        }
    }

    #[actix_web::test]
    #[ignore = "explicit PostgreSQL TCP partition and lost commit acknowledgement injection"]
    async fn recycling_network_faults_never_replay_ambiguous_commits() {
        use super::RecyclingMethod;
        let config = Config::from_env().unwrap();
        let pg = config
            .database_url
            .parse::<tokio_postgres::Config>()
            .unwrap();
        let target_host = match pg.get_hosts().first().unwrap() {
            tokio_postgres::config::Host::Tcp(host) => host.clone(),
            _ => panic!("fault test requires TCP PostgreSQL"),
        };
        let target_port = *pg.get_ports().first().unwrap_or(&5432);
        let quote = |value: &str| format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"));
        let (admin, admin_connection) =
            tokio_postgres::connect(&config.database_url, tokio_postgres::NoTls)
                .await
                .unwrap();
        actix_web::rt::spawn(async move {
            let _ = admin_connection.await;
        });
        admin
            .batch_execute(
                "CREATE TABLE IF NOT EXISTS performance_network_writes(id bigint PRIMARY KEY)",
            )
            .await
            .unwrap();
        for (name, policy, id) in [
            ("verified", RecyclingMethod::Verified, 10_i64),
            ("fast", RecyclingMethod::Fast, 20_i64),
        ] {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let proxy_port = listener.local_addr().unwrap().port();
            let (mode, changes) = tokio::sync::watch::channel(0_u8);
            let host = target_host.clone();
            let proxy = actix_web::rt::spawn(async move {
                while let Ok((downstream, _)) = listener.accept().await {
                    if *changes.borrow() == 1 {
                        continue;
                    }
                    let upstream = tokio::net::TcpStream::connect((host.as_str(), target_port))
                        .await
                        .unwrap();
                    let changes = changes.clone();
                    actix_web::rt::spawn(async move {
                        let (client_read, client_write) = downstream.into_split();
                        let (server_read, server_write) = upstream.into_split();
                        tokio::join!(
                            forward_faultable(client_read, server_write, changes.clone(), false),
                            forward_faultable(server_read, client_write, changes, true)
                        );
                    });
                }
            });
            let proxy_url = format!(
                "host=127.0.0.1 port={proxy_port} user={} password={} dbname={}",
                quote(pg.get_user().unwrap()),
                quote(std::str::from_utf8(pg.get_password().unwrap_or_default()).unwrap()),
                quote(pg.get_dbname().unwrap_or(pg.get_user().unwrap()))
            );
            let settings = DatabasePoolSettings {
                role: PoolRole::Request,
                max_size: 1,
                min_size: 1,
                checkout_queue_capacity: 4,
                wait_timeout: Duration::from_millis(250),
                max_lifetime: Duration::from_secs(1800),
                lifetime_jitter: Duration::from_secs(600),
            };
            let db = Database::create_with_recycling(
                &proxy_url,
                settings,
                Metrics::new(&config),
                policy,
            )
            .await
            .unwrap();
            admin
                .execute("DELETE FROM performance_network_writes WHERE id=$1", &[&id])
                .await
                .unwrap();
            let mut client = db.get().await.unwrap();
            let transaction = client.transaction().await.unwrap();
            transaction
                .execute(
                    "INSERT INTO performance_network_writes(id) VALUES($1)",
                    &[&id],
                )
                .await
                .unwrap();
            mode.send(2).unwrap(); // Forward COMMIT but discard its acknowledgement.
            let observer = async {
                tokio::time::timeout(Duration::from_secs(3), async {
                    loop {
                        let committed: i64 = admin
                            .query_one(
                                "SELECT count(*) FROM performance_network_writes WHERE id=$1",
                                &[&id],
                            )
                            .await
                            .unwrap()
                            .get(0);
                        if committed == 1 {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .expect("server must commit even though the reply was lost");
                mode.send(1).unwrap(); // A network cut exposes the ambiguous result to the caller.
            };
            let (commit, ()) = tokio::join!(transaction.commit(), observer);
            assert!(
                commit.is_err(),
                "lost acknowledgement must remain an error, never an automatic replay"
            );
            drop(client);
            assert!(
                db.query_one("SELECT 1", &[]).await.is_err(),
                "partition must be visible"
            );
            mode.send(0).unwrap();
            let (client, recovery) =
                recover_safe_read(&db, name, "network restoration", None).await;
            drop(client);
            let count: i64 = admin
                .query_one(
                    "SELECT count(*) FROM performance_network_writes WHERE id=$1",
                    &[&id],
                )
                .await
                .unwrap()
                .get(0);
            assert_eq!(
                count, 1,
                "ambiguous committed write must exist exactly once"
            );
            println!(
                "network_fault policy={name} ambiguous_commit_error=true committed_rows={count} restored_read_us={} recovery_failed_reads={}",
                recovery.elapsed.as_micros(),
                recovery.failed_reads
            );
            admin
                .execute("DELETE FROM performance_network_writes WHERE id=$1", &[&id])
                .await
                .unwrap();
            proxy.abort();
        }
        admin
            .batch_execute("DROP TABLE performance_network_writes")
            .await
            .unwrap();
    }
}
