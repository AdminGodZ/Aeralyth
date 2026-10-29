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
    pub database_pool_min: usize,
    pub database_pool_queue_capacity: usize,
    pub database_maintenance_pool_max: usize,
    pub database_maintenance_pool_min: usize,
    pub database_maintenance_pool_queue_capacity: usize,
    pub database_pool_wait_ms: u64,
    pub database_connection_max_lifetime_seconds: u64,
    pub database_connection_lifetime_jitter_seconds: u64,
    pub password_workers: usize,
    pub password_queue_capacity: usize,
    pub login_attempts_per_address_minute: u32,
    pub login_attempts_per_account_minute: u32,
    pub upload_control_concurrency: usize,
    pub upload_control_per_user: usize,
    pub recursive_operation_concurrency: usize,
    pub recursive_operation_per_user: usize,
    pub recursive_operation_queue_capacity: usize,
    pub recursive_operation_per_user_queue_capacity: usize,
    pub storage_operation_concurrency: usize,
    pub storage_operation_per_user: usize,
    pub storage_operation_queue_capacity: usize,
    pub storage_operation_per_user_queue_capacity: usize,
    pub metrics_token: Option<String>,
    pub request_slow_ms: u64,
    pub request_success_sample_rate: usize,
    pub structured_logs: bool,
    pub cookie_secure: bool,
    pub storage_path: String,
    pub storage_backend: String,
    pub storage_quota_bytes: u64,
    pub storage_presign_seconds: u64,
    pub storage_multipart_threshold_bytes: u64,
    pub storage_multipart_part_bytes: u64,
    pub storage_multipart_orphan_grace_seconds: u64,
    pub storage_maintenance_concurrency: usize,
    pub e2ee_mode: E2eeMode,
    pub share_link_secret: String,
    pub s3_bucket: Option<String>,
    pub s3_endpoint: Option<String>,
    pub s3_region: String,
    pub s3_access_key_id: Option<String>,
    pub s3_secret_access_key: Option<String>,
    pub s3_force_path_style: bool,
    pub s3_abort_incomplete_multipart_days: Option<u64>,
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
        let database_pool_min = env_usize("AERALYTH_DB_POOL_MIN", 2, 0, database_pool_max);
        let database_pool_queue_capacity = env_usize(
            "AERALYTH_DB_POOL_QUEUE_CAPACITY",
            database_pool_max.saturating_mul(8),
            database_pool_max,
            1_024,
        );
        let database_maintenance_pool_max = env_usize("AERALYTH_DB_MAINTENANCE_POOL_MAX", 2, 1, 8);
        let database_maintenance_pool_min = env_usize(
            "AERALYTH_DB_MAINTENANCE_POOL_MIN",
            1,
            0,
            database_maintenance_pool_max,
        );
        let database_maintenance_pool_queue_capacity = env_usize(
            "AERALYTH_DB_MAINTENANCE_POOL_QUEUE_CAPACITY",
            database_maintenance_pool_max.saturating_mul(8),
            database_maintenance_pool_max,
            128,
        );
        let database_pool_wait_ms = env_u64("AERALYTH_DB_POOL_WAIT_MS", 1_000, 100, 30_000);
        let password_workers = env_usize("AERALYTH_PASSWORD_WORKERS", 2, 1, 8);
        let password_queue_capacity = env_usize(
            "AERALYTH_PASSWORD_QUEUE_CAPACITY",
            16,
            password_workers,
            256,
        );
        let upload_control_concurrency = env_usize("AERALYTH_UPLOAD_CONTROL_CONCURRENCY", 8, 1, 64);
        let upload_control_per_user = env_usize(
            "AERALYTH_UPLOAD_CONTROL_PER_USER",
            3,
            1,
            upload_control_concurrency,
        );
        let recursive_operation_concurrency = env_usize(
            "AERALYTH_RECURSIVE_OPERATION_CONCURRENCY",
            default_recursive_operation_concurrency(database_pool_max),
            1,
            16,
        );
        let recursive_operation_per_user = env_usize(
            "AERALYTH_RECURSIVE_OPERATION_PER_USER",
            2.min(recursive_operation_concurrency),
            1,
            recursive_operation_concurrency,
        );
        let recursive_operation_queue_capacity = env_usize(
            "AERALYTH_RECURSIVE_OPERATION_QUEUE_CAPACITY",
            recursive_operation_concurrency.saturating_mul(4),
            recursive_operation_concurrency,
            128,
        );
        let recursive_operation_per_user_queue_capacity = env_usize(
            "AERALYTH_RECURSIVE_OPERATION_PER_USER_QUEUE_CAPACITY",
            recursive_operation_per_user
                .saturating_mul(4)
                .min(recursive_operation_queue_capacity),
            recursive_operation_per_user,
            recursive_operation_queue_capacity,
        );
        let storage_operation_concurrency =
            env_usize("AERALYTH_STORAGE_OPERATION_CONCURRENCY", 16, 1, 128);
        let storage_operation_per_user = env_usize(
            "AERALYTH_STORAGE_OPERATION_PER_USER",
            8,
            1,
            storage_operation_concurrency,
        );
        let storage_operation_queue_capacity = env_usize(
            "AERALYTH_STORAGE_OPERATION_QUEUE_CAPACITY",
            storage_operation_concurrency.saturating_mul(2),
            storage_operation_concurrency,
            512,
        );
        let storage_operation_per_user_queue_capacity = env_usize(
            "AERALYTH_STORAGE_OPERATION_PER_USER_QUEUE_CAPACITY",
            storage_operation_per_user.saturating_mul(2),
            storage_operation_per_user,
            storage_operation_queue_capacity,
        );
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
        let metrics_token = first_env(&["AERALYTH_METRICS_TOKEN"]);
        if metrics_token.as_ref().is_some_and(|token| token.len() < 32) {
            return Err("AERALYTH_METRICS_TOKEN must contain at least 32 bytes".to_owned());
        }
        let share_link_secret = first_env(&["AERALYTH_SHARE_LINK_SECRET"])
            .or_else(|| (!is_production).then(|| database_url.clone()))
            .ok_or_else(|| {
                "AERALYTH_SHARE_LINK_SECRET is required in production and must contain at least 32 bytes"
                    .to_owned()
            })?;
        if share_link_secret.len() < 32 {
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
        let storage_presign_seconds = env_u64("AERALYTH_STORAGE_PRESIGN_SECONDS", 900, 60, 3_600);
        let storage_multipart_orphan_grace_seconds = env_u64(
            "AERALYTH_MULTIPART_ORPHAN_GRACE_SECONDS",
            60 * 60,
            5 * 60,
            7 * 24 * 60 * 60,
        );
        let s3_abort_incomplete_multipart_days =
            env_optional_u64("AERALYTH_S3_ABORT_INCOMPLETE_MULTIPART_DAYS", 2, 3_650)?;
        if let Some(days) = s3_abort_incomplete_multipart_days {
            let lifecycle_age_seconds = days.saturating_mul(24 * 60 * 60);
            let minimum_safe_age_seconds = storage_multipart_orphan_grace_seconds
                .max(storage_presign_seconds)
                .max(24 * 60 * 60);
            if lifecycle_age_seconds <= minimum_safe_age_seconds {
                return Err(format!(
                    "AERALYTH_S3_ABORT_INCOMPLETE_MULTIPART_DAYS must exceed the longest valid upload or orphan grace period ({minimum_safe_age_seconds} seconds)"
                ));
            }
            if s3_endpoint
                .as_deref()
                .is_some_and(is_railway_bucket_endpoint)
            {
                return Err(
                    "Railway Storage Buckets do not support bucket lifecycle configuration; leave AERALYTH_S3_ABORT_INCOMPLETE_MULTIPART_DAYS unset and retain application reconciliation"
                        .to_owned(),
                );
            }
        }

        Ok(Self {
            host,
            port,
            database_url,
            database_url_configured,
            database_pool_max,
            database_pool_min,
            database_pool_queue_capacity,
            database_maintenance_pool_max,
            database_maintenance_pool_min,
            database_maintenance_pool_queue_capacity,
            database_pool_wait_ms,
            database_connection_max_lifetime_seconds: env_u64(
                "AERALYTH_DB_CONNECTION_MAX_LIFETIME_SECONDS",
                30 * 60,
                10 * 60,
                24 * 60 * 60,
            ),
            database_connection_lifetime_jitter_seconds: env_u64(
                "AERALYTH_DB_CONNECTION_LIFETIME_JITTER_SECONDS",
                10 * 60,
                0,
                60 * 60,
            ),
            password_workers,
            password_queue_capacity,
            login_attempts_per_address_minute: env_u32(
                "AERALYTH_LOGIN_ATTEMPTS_PER_ADDRESS_MINUTE",
                60,
                1,
                10_000,
            ),
            login_attempts_per_account_minute: env_u32(
                "AERALYTH_LOGIN_ATTEMPTS_PER_ACCOUNT_MINUTE",
                10,
                1,
                1_000,
            ),
            upload_control_concurrency,
            upload_control_per_user,
            recursive_operation_concurrency,
            recursive_operation_per_user,
            recursive_operation_queue_capacity,
            recursive_operation_per_user_queue_capacity,
            storage_operation_concurrency,
            storage_operation_per_user,
            storage_operation_queue_capacity,
            storage_operation_per_user_queue_capacity,
            metrics_token,
            request_slow_ms: env_u64("AERALYTH_REQUEST_SLOW_MS", 500, 1, 60_000),
            request_success_sample_rate: env_usize(
                "AERALYTH_REQUEST_SUCCESS_SAMPLE_RATE",
                100,
                1,
                1_000_000,
            ),
            structured_logs: env::var("AERALYTH_STRUCTURED_LOGS")
                .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
                .unwrap_or(is_production),
            cookie_secure,
            storage_path,
            storage_backend,
            storage_quota_bytes: env_u64(
                "AERALYTH_STORAGE_QUOTA_BYTES",
                10 * 1024 * 1024 * 1024,
                1024 * 1024,
                u64::MAX,
            ),
            storage_presign_seconds,
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
            storage_multipart_orphan_grace_seconds,
            storage_maintenance_concurrency: env_usize(
                "AERALYTH_STORAGE_MAINTENANCE_CONCURRENCY",
                8,
                1,
                32,
            ),
            e2ee_mode,
            share_link_secret,
            s3_bucket,
            s3_endpoint,
            s3_region,
            s3_access_key_id,
            s3_secret_access_key,
            s3_force_path_style,
            s3_abort_incomplete_multipart_days,
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

fn env_optional_u64(name: &str, min: u64, max: u64) -> Result<Option<u64>, String> {
    let Some(value) = env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let parsed = value
        .parse::<u64>()
        .map_err(|_| format!("{name} must be an integer between {min} and {max}"))?;
    if !(min..=max).contains(&parsed) {
        return Err(format!("{name} must be between {min} and {max}"));
    }
    Ok(Some(parsed))
}

fn is_railway_bucket_endpoint(endpoint: &str) -> bool {
    endpoint
        .split_once("://")
        .map_or(endpoint, |(_, authority)| authority)
        .split('/')
        .next()
        .is_some_and(|authority| {
            authority == "storage.railway.app" || authority.ends_with(".up.railway.app")
        })
}

/// Admitted traversals each hold a request connection while they query, so the default budget
/// leaves two request connections free for session lookups and other short handlers.
fn default_recursive_operation_concurrency(database_pool_max: usize) -> usize {
    database_pool_max.saturating_sub(2).clamp(2, 16)
}

fn env_u32(name: &str, default: u32, min: u32, max: u32) -> u32 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .map(|value| value.clamp(min, max))
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::{default_recursive_operation_concurrency, is_railway_bucket_endpoint};
    use crate::state::QueuedMutationLimiter;
    use std::time::Duration;
    use tokio::time::timeout;

    #[test]
    fn default_traversal_budget_scales_with_the_request_pool() {
        assert_eq!(default_recursive_operation_concurrency(1), 2);
        assert_eq!(default_recursive_operation_concurrency(4), 2);
        assert_eq!(default_recursive_operation_concurrency(8), 6);
        assert_eq!(default_recursive_operation_concurrency(32), 16);
    }

    #[actix_web::test]
    async fn default_traversal_budget_runs_concurrent_browsing_per_user_and_across_users() {
        let workers = default_recursive_operation_concurrency(8);
        let per_user = 2.min(workers);
        let (interactive, bulk) =
            QueuedMutationLimiter::partition(workers, per_user, workers * 4, per_user * 4);
        let wait = Duration::from_millis(100);

        let first = timeout(wait, interactive.acquire("user")).await.unwrap();
        let second = timeout(wait, interactive.acquire("user"))
            .await
            .expect("one user can open a folder while a download is admitted")
            .unwrap();
        let other = timeout(wait, interactive.acquire("other-user"))
            .await
            .expect("other users are not serialized behind one user's browsing")
            .unwrap();
        let held_bulk = timeout(wait, bulk.acquire("user"))
            .await
            .expect("bulk keeps its own workers")
            .unwrap();
        drop((first.unwrap(), second, other, held_bulk));
    }

    #[test]
    fn recognizes_only_railway_bucket_hosts_for_lifecycle_guarding() {
        assert!(is_railway_bucket_endpoint(
            "https://example-bucket.up.railway.app"
        ));
        assert!(is_railway_bucket_endpoint("https://storage.railway.app"));
        assert!(is_railway_bucket_endpoint(
            "example-bucket.up.railway.app/path"
        ));
        assert!(!is_railway_bucket_endpoint(
            "https://s3.us-east-1.amazonaws.com"
        ));
        assert!(!is_railway_bucket_endpoint(
            "https://up.railway.app.example.com"
        ));
    }
}
