use std::error::Error as StdError;
use std::fmt;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use deadpool_postgres::{
    GenericClient, Hook, HookError, Manager, ManagerConfig, Pool, RecyclingMethod, Runtime,
};
use tokio_postgres::types::ToSql;
use tokio_postgres::{NoTls, Row};

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
}

#[derive(Debug)]
pub enum DatabaseError {
    Pool(deadpool_postgres::PoolError),
    Postgres(tokio_postgres::Error),
}

impl fmt::Display for DatabaseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
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
        max_size: usize,
        wait_timeout: Duration,
    ) -> Result<Self, Box<dyn StdError + Send + Sync>> {
        let mut postgres_config = database_url.parse::<tokio_postgres::Config>()?;
        postgres_config.connect_timeout(Duration::from_secs(5));
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
        let pool = Pool::builder(manager)
            .max_size(max_size)
            .wait_timeout(Some(wait_timeout))
            .create_timeout(Some(Duration::from_secs(5)))
            .recycle_timeout(Some(Duration::from_secs(3)))
            .pre_recycle(Hook::sync_fn(|_, metrics| {
                if metrics.age() > Duration::from_secs(30 * 60)
                    || metrics.last_used() > Duration::from_secs(5 * 60)
                {
                    return Err(HookError::message("database connection lifetime expired"));
                }

                Ok(())
            }))
            .runtime(Runtime::Tokio1)
            .build()?;
        let database = Self { pool };

        database.ping().await?;

        Ok(database)
    }

    pub async fn get(&self) -> Result<deadpool_postgres::Client, DatabaseError> {
        if let Ok(slot) = REQUEST_CONNECTION.try_with(Arc::clone)
            && let Some(connection) = slot.take_owned().await
        {
            return Ok(connection);
        }

        let connection = self.pool.get().await.map_err(DatabaseError::from)?;
        if let Ok(slot) = REQUEST_CONNECTION.try_with(Arc::clone) {
            slot.record_checkout();
        }
        Ok(connection)
    }

    pub async fn ping(&self) -> Result<(), DatabaseError> {
        let connection = self.pool.get().await.map_err(DatabaseError::from)?;
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
        if let Ok(slot) = REQUEST_CONNECTION.try_with(Arc::clone) {
            slot.clear().await;
        }
    }

    async fn shared_request_connection(
        &self,
    ) -> Result<Arc<deadpool_postgres::Client>, DatabaseError> {
        if let Ok(slot) = REQUEST_CONNECTION.try_with(Arc::clone) {
            return slot
                .shared_or_try_init(|| async { self.pool.get().await.map_err(DatabaseError::from) })
                .await;
        }

        self.pool
            .get()
            .await
            .map(Arc::new)
            .map_err(DatabaseError::from)
    }
}

pub async fn scope_request<F, Output>(future: F) -> Output
where
    F: Future<Output = Output>,
{
    let slot = Arc::new(RequestConnectionSlot::new());
    let output = REQUEST_CONNECTION.scope(Arc::clone(&slot), future).await;
    let checkouts = slot.checkout_count();
    log::debug!("request used {checkouts} database pool checkouts");
    output
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
    use super::RequestConnectionSlot;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

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
}
