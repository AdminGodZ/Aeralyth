use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    host: String,
    port: u16,
    pub database_url: String,
    pub database_url_configured: bool,
    pub cookie_secure: bool,
    pub storage_path: String,
}

impl Config {
    pub fn from_env() -> Self {
        let host = env::var("AERALYTH_API_HOST").unwrap_or_else(|_| "0.0.0.0".to_owned());
        let port = env::var("AERALYTH_API_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(8080);
        let configured_database_url = env::var("DATABASE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let database_url_configured = configured_database_url.is_some();
        let database_url = configured_database_url
            .unwrap_or_else(|| "postgres://aeralyth:aeralyth@127.0.0.1:5432/aeralyth".to_owned());
        let cookie_secure = env::var("AERALYTH_COOKIE_SECURE")
            .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
            .unwrap_or_else(|_| !cfg!(debug_assertions));
        let storage_path =
            env::var("AERALYTH_STORAGE_PATH").unwrap_or_else(|_| "./data/files".to_owned());

        Self {
            host,
            port,
            database_url,
            database_url_configured,
            cookie_secure,
            storage_path,
        }
    }

    pub fn bind_addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}
