use crate::config::Config;
use crate::db::Database;
use crate::observability::Metrics;
use crate::storage::Storage;

pub struct AppState {
    pub config: Config,
    pub db: Database,
    pub metrics: Metrics,
    pub storage: Storage,
}
