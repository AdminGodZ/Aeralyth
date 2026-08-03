use std::env;

use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum E2eeMode {
    Off,
    Migrate,
    Required,
}

impl E2eeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Migrate => "migrate",
            Self::Required => "required",
        }
    }

    pub fn is_enabled(self) -> bool {
        self != Self::Off
    }
}

#[derive(Clone)]
pub struct Config {
    host: String,
    port: u16,
    pub database_url: String,
    pub database_url_configured: bool,
    pub database_pool_max: usize,
    pub database_pool_wait_ms: u64,
    pub cookie_secure: bool,
    pub storage_path: String,
    pub storage_backend: String,
    pub storage_quota_bytes: u64,
    pub storage_presign_seconds: u64,
    pub storage_multipart_threshold_bytes: u64,
    pub storage_multipart_part_bytes: u64,
    pub storage_multipart_orphan_grace_seconds: u64,
    pub e2ee_mode: E2eeMode,
    pub share_link_secret: String,
    pub s3_bucket: Option<String>,
    pub s3_endpoint: Option<String>,
    pub s3_region: String,
    pub s3_access_key_id: Option<String>,
    pub s3_secret_access_key: Option<String>,
    pub s3_force_path_style: bool,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
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
        let database_pool_max = env_usize("AERALYTH_DB_POOL_MAX", 8, 1, 32);
        let database_pool_wait_ms = env_u64("AERALYTH_DB_POOL_WAIT_MS", 1_000, 100, 30_000);
        let cookie_secure = env::var("AERALYTH_COOKIE_SECURE")
            .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
            .unwrap_or_else(|_| !cfg!(debug_assertions));
        let storage_path =
            env::var("AERALYTH_STORAGE_PATH").unwrap_or_else(|_| "./data/files".to_owned());
        let s3_bucket = first_env(&["AERALYTH_S3_BUCKET", "AWS_S3_BUCKET_NAME", "BUCKET"]);
        let s3_endpoint = first_env(&["AERALYTH_S3_ENDPOINT", "AWS_ENDPOINT_URL", "ENDPOINT"]);
        let s3_access_key_id = first_env(&["AWS_ACCESS_KEY_ID", "ACCESS_KEY_ID"]);
        let s3_secret_access_key = first_env(&["AWS_SECRET_ACCESS_KEY", "SECRET_ACCESS_KEY"]);
        let explicit_storage_backend = env::var("AERALYTH_STORAGE_BACKEND")
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty());
        let s3_configured = s3_bucket.is_some()
            && s3_endpoint.is_some()
            && s3_access_key_id.is_some()
            && s3_secret_access_key.is_some();
        let is_production = env::var("AERALYTH_ENV")
            .map(|value| value.eq_ignore_ascii_case("production"))
            .unwrap_or(false)
            || first_env(&["RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID"]).is_some();
        let share_link_secret = first_env(&["AERALYTH_SHARE_LINK_SECRET"])
            .or_else(|| (!is_production).then(|| database_url.clone()))
            .ok_or_else(|| {
                "AERALYTH_SHARE_LINK_SECRET is required in production and must contain at least 32 bytes"
                    .to_owned()
            })?;
        if share_link_secret.as_bytes().len() < 32 {
            return Err("AERALYTH_SHARE_LINK_SECRET must contain at least 32 bytes".to_owned());
        }
        let storage_backend = match explicit_storage_backend.as_deref() {
            Some("s3") if s3_configured => "s3".to_owned(),
            Some("s3") => {
                return Err(
                    "AERALYTH_STORAGE_BACKEND=s3 requires bucket, endpoint, and credentials"
                        .to_owned(),
                );
            }
            Some("local") if !is_production => "local".to_owned(),
            Some("local") => {
                return Err("local object storage is not allowed in production".to_owned());
            }
            Some(value) => {
                return Err(format!(
                    "unsupported AERALYTH_STORAGE_BACKEND value: {value}"
                ));
            }
            None if is_production => {
                return Err(
                    "AERALYTH_STORAGE_BACKEND=s3 must be set explicitly in production".to_owned(),
                );
            }
            None if s3_configured => "s3".to_owned(),
            None => "local".to_owned(),
        };
        let e2ee_mode = match env::var("AERALYTH_E2EE_MODE")
            .unwrap_or_else(|_| "off".to_owned())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "off" => E2eeMode::Off,
            "migrate" => E2eeMode::Migrate,
            "required" => E2eeMode::Required,
            value => {
                return Err(format!("unsupported AERALYTH_E2EE_MODE value: {value}"));
            }
        };

        if e2ee_mode.is_enabled() && storage_backend != "s3" {
            return Err(
                "AERALYTH_E2EE_MODE=migrate|required requires S3 object storage".to_owned(),
            );
        }
        let s3_region = first_env(&["AERALYTH_S3_REGION", "AWS_DEFAULT_REGION", "REGION"])
            .unwrap_or_else(|| "auto".to_owned());
        let s3_force_path_style = first_env(&["AERALYTH_S3_URL_STYLE", "AWS_S3_URL_STYLE"])
            .map(|value| value.eq_ignore_ascii_case("path"))
            .unwrap_or(false);

        Ok(Self {
            host,
            port,
            database_url,
            database_url_configured,
            database_pool_max,
            database_pool_wait_ms,
            cookie_secure,
            storage_path,
            storage_backend,
            storage_quota_bytes: env_u64(
                "AERALYTH_STORAGE_QUOTA_BYTES",
                10 * 1024 * 1024 * 1024,
                1024 * 1024,
                u64::MAX,
            ),
            storage_presign_seconds: env_u64("AERALYTH_STORAGE_PRESIGN_SECONDS", 900, 60, 3_600),
            storage_multipart_threshold_bytes: env_u64(
                "AERALYTH_MULTIPART_THRESHOLD_BYTES",
                100 * 1024 * 1024,
                5 * 1024 * 1024,
                2 * 1024 * 1024 * 1024,
            ),
            storage_multipart_part_bytes: env_u64(
                "AERALYTH_MULTIPART_PART_BYTES",
                64 * 1024 * 1024,
                5 * 1024 * 1024,
                512 * 1024 * 1024,
            ),
            storage_multipart_orphan_grace_seconds: env_u64(
                "AERALYTH_MULTIPART_ORPHAN_GRACE_SECONDS",
                60 * 60,
                5 * 60,
                7 * 24 * 60 * 60,
            ),
            e2ee_mode,
            share_link_secret,
            s3_bucket,
            s3_endpoint,
            s3_region,
            s3_access_key_id,
            s3_secret_access_key,
            s3_force_path_style,
        })
    }

    pub fn bind_addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

fn first_env(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        env::var(name)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    })
}

fn env_usize(name: &str, default: usize, min: usize, max: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .map(|value| value.clamp(min, max))
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64, min: u64, max: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(|value| value.clamp(min, max))
        .unwrap_or(default)
}
