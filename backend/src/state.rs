use crate::config::Config;
use crate::db::Database;
use crate::storage::Storage;

pub struct AppState {
    pub config: Config,
    pub db: Database,
    pub storage: Storage,
}
