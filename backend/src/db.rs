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
        let manager = Manager::from_config(
            postgres_config,
            NoTls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Verified,
            },
        );
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
        if self.role == PoolRole::Request
            && let Ok(slot) = REQUEST_CONNECTION.try_with(Arc::clone)
        {
            slot.clear().await;
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
}
