use std::error::Error as StdError;
use std::fmt;
use std::time::Duration;

use deadpool_postgres::{
    Hook, HookError, Manager, ManagerConfig, Pool, RecyclingMethod, Runtime,
};
use tokio_postgres::types::ToSql;
use tokio_postgres::{NoTls, Row};

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
        self.pool.get().await.map_err(DatabaseError::from)
    }

    pub async fn ping(&self) -> Result<(), DatabaseError> {
        self.query_one("SELECT 1", &[]).await.map(|_| ())
    }

    pub fn status(&self) -> deadpool_postgres::Status {
        self.pool.status()
    }

    pub async fn query(
        &self,
        sql: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<Row>, DatabaseError> {
        let client = self.get().await?;
        let statement = client.prepare_cached(sql).await?;

        client
            .query(&statement, params)
            .await
            .map_err(DatabaseError::from)
    }

    pub async fn query_one(
        &self,
        sql: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Row, DatabaseError> {
        let client = self.get().await?;
        let statement = client.prepare_cached(sql).await?;

        client
            .query_one(&statement, params)
            .await
            .map_err(DatabaseError::from)
    }

    pub async fn query_opt(
        &self,
        sql: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Option<Row>, DatabaseError> {
        let client = self.get().await?;
        let statement = client.prepare_cached(sql).await?;

        client
            .query_opt(&statement, params)
            .await
            .map_err(DatabaseError::from)
    }

    pub async fn execute(
        &self,
        sql: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<u64, DatabaseError> {
        let client = self.get().await?;
        let statement = client.prepare_cached(sql).await?;

        client
            .execute(&statement, params)
            .await
            .map_err(DatabaseError::from)
    }
}
