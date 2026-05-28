use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    host: String,
    port: u16,
    pub database_url: Option<String>,
    pub storage_path: String,
}

impl Config {
    pub fn from_env() -> Self {
        let host = env::var("AERALYTH_API_HOST").unwrap_or_else(|_| "0.0.0.0".to_owned());
        let port = env::var("AERALYTH_API_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(8080);
        let database_url = env::var("DATABASE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let storage_path =
            env::var("AERALYTH_STORAGE_PATH").unwrap_or_else(|_| "./data/files".to_owned());

        Self {
            host,
            port,
            database_url,
            storage_path,
        }
    }

    pub fn bind_addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}
