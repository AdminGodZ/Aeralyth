use tokio_postgres::Client;

use crate::config::Config;

pub struct AppState {
    pub config: Config,
    pub db: Client,
}
