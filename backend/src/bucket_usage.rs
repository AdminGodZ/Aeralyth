use std::collections::HashSet;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::storage::Storage;

const CACHE_TTL: Duration = Duration::from_secs(60);
const SCAN_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_SCAN_PAGES: usize = 10_000;

pub fn provider_label(backend: &str, endpoint: Option<&str>) -> &'static str {
    if backend != "s3" {
        return "Local storage";
    }
    let is_railway = endpoint
        .and_then(|endpoint| endpoint.parse::<actix_web::http::Uri>().ok())
        .and_then(|uri| uri.host().map(str::to_ascii_lowercase))
        .is_some_and(|host| {
            host == "storage.railway.app"
                || host.ends_with(".up.railway.app")
                || host.ends_with(".storageapi.dev")
        });
    if is_railway {
        "Railway S3"
    } else {
        "S3-compatible storage"
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketUsage {
    used_bytes: u64,
    object_count: u64,
    measured_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum BucketUsageState {
    NotConfigured,
    Loading,
    Ready {
        usage: BucketUsage,
        refreshing: bool,
        stale: bool,
    },
    Unavailable,
}

#[derive(Clone, Default)]
pub struct BucketUsageCache(Arc<Mutex<CachedUsage>>);

#[derive(Default)]
struct CachedUsage {
    usage: Option<BucketUsage>,
    attempted_at: Option<Instant>,
    refreshing: bool,
    failed: bool,
}

impl BucketUsageCache {
    pub fn read(&self, storage: &Storage) -> BucketUsageState {
        let Storage::S3 { client, bucket, .. } = storage else {
            return BucketUsageState::NotConfigured;
        };
        let client = client.clone();
        let bucket = bucket.clone();
        self.read_or_refresh(move || scan_bucket(client, bucket))
    }

    fn read_or_refresh<F, Fut>(&self, fetch: F) -> BucketUsageState
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Result<BucketUsage, String>> + Send,
    {
        let mut cached = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if !cached.refreshing
            && cached
                .attempted_at
                .is_none_or(|attempted_at| attempted_at.elapsed() >= CACHE_TTL)
        {
            cached.refreshing = true;
            cached.attempted_at = Some(Instant::now());
            let shared = Arc::clone(&self.0);
            // A cold page returns immediately. Only one bounded scan runs per replica;
            // subsequent requests keep the last complete snapshot while it refreshes.
            tokio::spawn(async move {
                let result = tokio::time::timeout(SCAN_TIMEOUT, fetch()).await;
                let mut cached = shared.lock().unwrap_or_else(|error| error.into_inner());
                cached.refreshing = false;
                cached.attempted_at = Some(Instant::now());
                match result {
                    Ok(Ok(usage)) => {
                        cached.usage = Some(usage);
                        cached.failed = false;
                    }
                    _ => {
                        cached.failed = true;
                        tracing::warn!(
                            "S3 bucket usage refresh failed; retaining the last snapshot"
                        );
                    }
                }
            });
        }

        if let Some(usage) = &cached.usage {
            BucketUsageState::Ready {
                usage: usage.clone(),
                refreshing: cached.refreshing,
                stale: cached.failed,
            }
        } else if cached.refreshing {
            BucketUsageState::Loading
        } else {
            BucketUsageState::Unavailable
        }
    }
}

struct BucketPage {
    sizes: Vec<i64>,
    next_token: Option<String>,
}

async fn scan_bucket(client: aws_sdk_s3::Client, bucket: String) -> Result<BucketUsage, String> {
    collect_usage(|token| {
        let client = client.clone();
        let bucket = bucket.clone();
        async move {
            let response = client
                .list_objects_v2()
                .bucket(bucket)
                .max_keys(1_000)
                .set_continuation_token(token)
                .send()
                .await
                .map_err(|error| error.to_string())?;
            let next_token = if response.is_truncated() == Some(true) {
                Some(
                    response
                        .next_continuation_token()
                        .filter(|token| !token.is_empty())
                        .ok_or("Truncated bucket page has no continuation token")?
                        .to_owned(),
                )
            } else {
                None
            };
            let sizes = response
                .contents()
                .iter()
                .map(|object| object.size().ok_or("Bucket object has no size".to_owned()))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(BucketPage { sizes, next_token })
        }
    })
    .await
}

async fn collect_usage<F, Fut>(mut fetch_page: F) -> Result<BucketUsage, String>
where
    F: FnMut(Option<String>) -> Fut,
    Fut: Future<Output = Result<BucketPage, String>>,
{
    let mut used_bytes = 0_u64;
    let mut object_count = 0_u64;
    let mut token = None;
    let mut seen_tokens = HashSet::new();
    for _ in 0..MAX_SCAN_PAGES {
        let page = fetch_page(token).await?;
        for size in page.sizes {
            let size = u64::try_from(size).map_err(|_| "Invalid bucket object size")?;
            used_bytes = used_bytes.checked_add(size).ok_or("Bucket size overflow")?;
            object_count = object_count.checked_add(1).ok_or("Object count overflow")?;
        }
        let Some(next_token) = page.next_token else {
            return Ok(BucketUsage {
                used_bytes,
                object_count,
                measured_at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
            });
        };
        if !seen_tokens.insert(next_token.clone()) {
            return Err("Bucket pagination stopped making progress".to_owned());
        }
        token = Some(next_token);
    }
    Err("Bucket scan exceeded its page limit".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[tokio::test]
    async fn collects_every_page_and_counts_empty_objects() {
        let mut pages = VecDeque::from([
            BucketPage {
                sizes: vec![13, 0],
                next_token: Some("next".to_owned()),
            },
            BucketPage {
                sizes: vec![57],
                next_token: None,
            },
        ]);
        let mut tokens = Vec::new();
        let usage = collect_usage(|token| {
            tokens.push(token);
            std::future::ready(Ok(pages.pop_front().unwrap()))
        })
        .await
        .unwrap();
        assert_eq!(tokens, [None, Some("next".to_owned())]);
        assert_eq!(usage.used_bytes, 70);
        assert_eq!(usage.object_count, 3);
        assert!(usage.measured_at > 0);
    }

    #[tokio::test]
    async fn rejects_failed_or_repeating_pages_without_publishing_partial_totals() {
        let result = collect_usage(|token| {
            std::future::ready(if token.is_none() {
                Ok(BucketPage {
                    sizes: vec![50],
                    next_token: Some("next".to_owned()),
                })
            } else {
                Err("Provider unavailable".to_owned())
            })
        })
        .await;
        assert!(result.is_err());
        let result = collect_usage(|_| {
            std::future::ready(Ok(BucketPage {
                sizes: vec![50],
                next_token: Some("repeated".to_owned()),
            }))
        })
        .await;
        assert!(result.unwrap_err().contains("progress"));
    }

    #[tokio::test]
    async fn rejects_invalid_sizes_and_overflow() {
        for sizes in [vec![-1], vec![i64::MAX, i64::MAX, i64::MAX]] {
            let result = collect_usage(|_| {
                std::future::ready(Ok(BucketPage {
                    sizes: sizes.clone(),
                    next_token: None,
                }))
            })
            .await;
            assert!(result.is_err());
        }
    }

    #[tokio::test]
    async fn deduplicates_refreshes_and_preserves_last_success_after_failure() {
        let cache = BucketUsageCache::default();
        let (release, pending) = tokio::sync::oneshot::channel();
        assert!(matches!(
            cache.read_or_refresh(|| async {
                pending.await.unwrap();
                Ok(BucketUsage {
                    used_bytes: 70,
                    object_count: 3,
                    measured_at: 1,
                })
            }),
            BucketUsageState::Loading
        ));
        assert!(matches!(
            cache.read_or_refresh(|| async {
                panic!("A concurrent request started another scan");
            }),
            BucketUsageState::Loading
        ));
        release.send(()).unwrap();
        tokio::task::yield_now().await;
        assert!(matches!(
            cache.read_or_refresh(|| async {
                panic!("A fresh snapshot started another scan");
            }),
            BucketUsageState::Ready {
                refreshing: false,
                stale: false,
                ..
            }
        ));

        cache.0.lock().unwrap().attempted_at = Some(Instant::now() - CACHE_TTL);
        cache.read_or_refresh(|| async { Err("offline".to_owned()) });
        tokio::task::yield_now().await;
        let BucketUsageState::Ready {
            usage,
            stale,
            refreshing,
        } = cache.read_or_refresh(|| async {
            panic!("A failure did not respect the retry cooldown");
        })
        else {
            panic!("Lost the last complete measurement");
        };
        assert_eq!(usage.used_bytes, 70);
        assert!(stale);
        assert!(!refreshing);
    }

    #[tokio::test]
    async fn a_failed_first_scan_is_unavailable_not_zero_usage() {
        let cache = BucketUsageCache::default();
        cache.read_or_refresh(|| async { Err("offline".to_owned()) });
        tokio::task::yield_now().await;
        assert!(matches!(
            cache.read_or_refresh(|| async { panic!("unexpected retry") }),
            BucketUsageState::Unavailable
        ));
    }

    #[test]
    fn identifies_railway_without_mislabeling_other_backends() {
        assert_eq!(
            provider_label("s3", Some("https://t3.storageapi.dev")),
            "Railway S3"
        );
        assert_eq!(
            provider_label("s3", Some("https://storage.railway.app")),
            "Railway S3"
        );
        assert_eq!(
            provider_label("s3", Some("https://bucket.up.railway.app")),
            "Railway S3"
        );
        assert_eq!(
            provider_label("s3", Some("https://storageapi.dev.example.com")),
            "S3-compatible storage"
        );
        assert_eq!(
            provider_label("local", Some("https://t3.storageapi.dev")),
            "Local storage"
        );
    }

    #[tokio::test]
    #[ignore = "Read-only live S3 check; requires AERALYTH_TEST_S3_* environment variables"]
    async fn reads_configured_bucket_read_only() {
        let value = |name: &str| std::env::var(format!("AERALYTH_TEST_S3_{name}")).expect(name);
        let config = aws_sdk_s3::config::Builder::new()
            .behavior_version_latest()
            .endpoint_url(value("ENDPOINT"))
            .region(aws_types::region::Region::new(value("REGION")))
            .credentials_provider(aws_credential_types::Credentials::new(
                value("ACCESS_KEY_ID"),
                value("SECRET_ACCESS_KEY"),
                None,
                None,
                "bucket-usage-test",
            ))
            .force_path_style(std::env::var("AERALYTH_TEST_S3_PATH_STYLE").as_deref() == Ok("true"))
            .build();
        let usage = tokio::time::timeout(
            SCAN_TIMEOUT,
            scan_bucket(aws_sdk_s3::Client::from_conf(config), value("BUCKET")),
        )
        .await
        .unwrap()
        .unwrap();
        println!(
            "Bucket measurement: {} bytes, {} objects",
            usage.used_bytes, usage.object_count
        );
    }
}
