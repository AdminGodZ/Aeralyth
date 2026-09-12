use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio_postgres::Row;

use crate::db::Database;
use crate::storage::Storage;

// Reconciliation is deliberately slower than admin polling. Every replica reads
// the same complete sample and a lease fences the worker that advances its cursor.
const REFRESH_SECONDS: i32 = 15 * 60;
const PAGE_TIMEOUT: Duration = Duration::from_secs(30);
const CHUNK_TIME: Duration = Duration::from_secs(10);
const CHUNK_PAGES: usize = 20;
const PAGE_INTERVAL: Duration = Duration::from_millis(500);
// Keep cycle detection bounded and durable. The page count also stops malformed
// providers with cycles longer than the recent history, without restarting work.
const TOKEN_HISTORY: usize = 64;
const MAX_SCAN_PAGES: i64 = 1_000_000;

const READ_QUERY: &str = "
    SELECT used_bytes, object_count,
           (extract(epoch FROM measured_at) * 1000)::bigint AS measured_at,
           lease_until > clock_timestamp() AS refreshing,
           measured_at <= clock_timestamp() - make_interval(secs => $2::integer) OR failed AS stale,
           failed
    FROM bucket_usage_snapshots WHERE namespace = $1
";
const CLAIM_QUERY: &str = "
    UPDATE bucket_usage_snapshots
    SET lease_token = gen_random_uuid()::text,
        lease_until = clock_timestamp() + interval '90 seconds',
        scan_started_at = COALESCE(scan_started_at, clock_timestamp())
    WHERE namespace = $1 AND next_attempt_at <= clock_timestamp()
      AND (lease_until IS NULL OR lease_until <= clock_timestamp())
    RETURNING lease_token, scan_token, scan_used_bytes, scan_object_count, scan_pages, scan_token_hashes
";
const CHECKPOINT_QUERY: &str = "
    UPDATE bucket_usage_snapshots
    SET scan_token = $3, scan_used_bytes = $4, scan_object_count = $5,
        scan_pages = $6, scan_token_hashes = $7,
        lease_until = clock_timestamp() + interval '90 seconds'
    WHERE namespace = $1 AND lease_token = $2 AND lease_until > clock_timestamp()
";
const COMPLETE_QUERY: &str = "
    UPDATE bucket_usage_snapshots
    SET used_bytes = $3, object_count = $4, measured_at = scan_started_at,
        completed_at = clock_timestamp(), failed = false,
        scan_token = NULL, scan_used_bytes = 0, scan_object_count = 0,
        scan_pages = 0, scan_token_hashes = '{}',
        scan_started_at = NULL, lease_token = NULL, lease_until = NULL,
        next_attempt_at = clock_timestamp() + make_interval(secs => $5::integer)
    WHERE namespace = $1 AND lease_token = $2 AND lease_until > clock_timestamp()
";

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
    // This is the start of the completed scan, so a long or interrupted scan
    // never presents old physical data as a freshly measured point-in-time total.
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

#[derive(Clone)]
pub struct BucketUsageCache {
    db: Database,
    running: Arc<AtomicBool>,
}

impl BucketUsageCache {
    pub fn new(db: Database) -> Self {
        Self {
            db,
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn read(&self, storage: &Storage) -> BucketUsageState {
        let Storage::S3 { namespace, .. } = storage else {
            return BucketUsageState::NotConfigured;
        };
        let namespace = namespace.clone();
        let result = self.read_shared(&namespace).await;
        let state = match result {
            Ok(state) => state,
            Err(error) => {
                tracing::warn!(%error, "Could not read shared bucket usage snapshot");
                return BucketUsageState::Unavailable;
            }
        };
        if self
            .running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            let cache = self.clone();
            let storage = storage.clone();
            tokio::spawn(async move {
                let _running = RunningGuard(Arc::clone(&cache.running));
                if let Err(error) = cache.refresh(&namespace, &storage).await {
                    tracing::warn!(%error, "Bucket usage reconciliation paused; its checkpoint is retained");
                }
            });
        }
        state
    }

    async fn read_shared(&self, namespace: &str) -> Result<BucketUsageState, String> {
        self.db
            .execute(
                "INSERT INTO bucket_usage_snapshots (namespace) VALUES ($1) ON CONFLICT DO NOTHING",
                &[&namespace],
            )
            .await
            .map_err(|error| error.to_string())?;
        let row = self
            .db
            .query_one(READ_QUERY, &[&namespace, &REFRESH_SECONDS])
            .await
            .map_err(|error| error.to_string())?;
        let measured_at: Option<i64> = row.get("measured_at");
        if let Some(measured_at) = measured_at {
            Ok(BucketUsageState::Ready {
                usage: BucketUsage {
                    used_bytes: row.get::<_, i64>("used_bytes") as u64,
                    object_count: row.get::<_, i64>("object_count") as u64,
                    measured_at: measured_at.max(0) as u64,
                },
                refreshing: row.get::<_, Option<bool>>("refreshing").unwrap_or(false),
                stale: row.get::<_, bool>("stale"),
            })
        } else if row.get::<_, bool>("failed") {
            Ok(BucketUsageState::Unavailable)
        } else {
            Ok(BucketUsageState::Loading)
        }
    }

    async fn claim(&self, namespace: &str) -> Result<Option<ScanProgress>, String> {
        self.db
            .query_opt(CLAIM_QUERY, &[&namespace])
            .await
            .map(|row| row.map(ScanProgress::from_row))
            .map_err(|error| error.to_string())
    }

    async fn refresh(&self, namespace: &str, storage: &Storage) -> Result<(), String> {
        loop {
            let Some(mut progress) = self.claim(namespace).await? else {
                return Ok(());
            };
            let result = self
                .run_chunk(
                    namespace,
                    &mut progress,
                    |token| fetch_page(storage, token),
                    CHUNK_TIME,
                    PAGE_INTERVAL,
                )
                .await;
            match result {
                Ok(ChunkResult::Completed | ChunkResult::LeaseLost) => return Ok(()),
                Ok(ChunkResult::Yielded) => {
                    // Release the lease between bounded chunks. Another replica
                    // can take over without starting the full scan again.
                    self.release(namespace, &progress.lease_token, false)
                        .await?;
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                Err(error) => {
                    self.release(namespace, &progress.lease_token, true).await?;
                    return Err(error);
                }
            }
        }
    }

    async fn release(
        &self,
        namespace: &str,
        lease_token: &str,
        failed: bool,
    ) -> Result<(), String> {
        self.db.execute(
            "UPDATE bucket_usage_snapshots
             SET lease_token = NULL, lease_until = NULL, failed = $3,
                 next_attempt_at = clock_timestamp() + CASE WHEN $3 THEN interval '60 seconds' ELSE interval '1 second' END
             WHERE namespace = $1 AND lease_token = $2 AND lease_until > clock_timestamp()",
            &[&namespace, &lease_token, &failed],
        ).await.map(|_| ()).map_err(|error| error.to_string())
    }

    async fn run_chunk<F, Fut>(
        &self,
        namespace: &str,
        progress: &mut ScanProgress,
        mut fetch: F,
        time_budget: Duration,
        page_interval: Duration,
    ) -> Result<ChunkResult, String>
    where
        F: FnMut(Option<String>) -> Fut,
        Fut: Future<Output = Result<BucketPage, String>>,
    {
        let started = Instant::now();
        for _ in 0..CHUNK_PAGES {
            if started.elapsed() >= time_budget {
                break;
            }
            if progress.pages >= MAX_SCAN_PAGES {
                return Err("Bucket pagination exceeded its durable page limit".to_owned());
            }
            let renewed = self.db.execute(
                "UPDATE bucket_usage_snapshots SET lease_until = clock_timestamp() + interval '90 seconds'
                 WHERE namespace = $1 AND lease_token = $2 AND lease_until > clock_timestamp()",
                &[&namespace, &progress.lease_token],
            ).await.map_err(|error| error.to_string())?;
            if renewed == 0 {
                return Ok(ChunkResult::LeaseLost);
            }
            let page = tokio::time::timeout(PAGE_TIMEOUT, fetch(progress.token.clone()))
                .await
                .map_err(|_| "Bucket listing page timed out".to_owned())??;
            let (used_bytes, object_count) = page_totals(progress, &page)?;
            let pages = progress.pages + 1;
            let mut token_hashes = progress.token_hashes.clone();
            if let Some(token) = &page.next_token {
                if token_hashes.len() >= TOKEN_HISTORY {
                    token_hashes.remove(0);
                }
                token_hashes.push(token_hash(token));
            }
            let updated = if page.next_token.is_none() {
                self.db
                    .execute(
                        COMPLETE_QUERY,
                        &[
                            &namespace,
                            &progress.lease_token,
                            &used_bytes,
                            &object_count,
                            &REFRESH_SECONDS,
                        ],
                    )
                    .await
            } else {
                self.db
                    .execute(
                        CHECKPOINT_QUERY,
                        &[
                            &namespace,
                            &progress.lease_token,
                            &page.next_token,
                            &used_bytes,
                            &object_count,
                            &pages,
                            &token_hashes,
                        ],
                    )
                    .await
            }
            .map_err(|error| error.to_string())?;
            if updated == 0 {
                return Ok(ChunkResult::LeaseLost);
            }
            if page.next_token.is_none() {
                return Ok(ChunkResult::Completed);
            }
            progress.token = page.next_token;
            progress.used_bytes = used_bytes;
            progress.object_count = object_count;
            progress.pages = pages;
            progress.token_hashes = token_hashes;
            tokio::time::sleep(page_interval).await;
        }
        Ok(ChunkResult::Yielded)
    }
}

struct RunningGuard(Arc<AtomicBool>);
impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Debug, PartialEq)]
enum ChunkResult {
    Completed,
    Yielded,
    LeaseLost,
}

struct ScanProgress {
    lease_token: String,
    token: Option<String>,
    used_bytes: i64,
    object_count: i64,
    pages: i64,
    token_hashes: Vec<String>,
}
impl ScanProgress {
    fn from_row(row: Row) -> Self {
        Self {
            lease_token: row.get("lease_token"),
            token: row.get("scan_token"),
            used_bytes: row.get("scan_used_bytes"),
            object_count: row.get("scan_object_count"),
            pages: row.get("scan_pages"),
            token_hashes: row.get("scan_token_hashes"),
        }
    }
}

struct BucketPage {
    sizes: Vec<i64>,
    next_token: Option<String>,
}

fn page_totals(progress: &ScanProgress, page: &BucketPage) -> Result<(i64, i64), String> {
    if page.next_token.as_ref().is_some_and(|token| {
        token.is_empty()
            || Some(token) == progress.token.as_ref()
            || progress.token_hashes.contains(&token_hash(token))
    }) {
        return Err("Bucket pagination stopped making progress".to_owned());
    }
    let mut used_bytes = progress.used_bytes;
    let mut object_count = progress.object_count;
    for &size in &page.sizes {
        if size < 0 {
            return Err("Invalid bucket object size".to_owned());
        }
        used_bytes = used_bytes.checked_add(size).ok_or("Bucket size overflow")?;
        object_count = object_count.checked_add(1).ok_or("Object count overflow")?;
    }
    Ok((used_bytes, object_count))
}

fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

async fn fetch_page(storage: &Storage, token: Option<String>) -> Result<BucketPage, String> {
    let Storage::S3 {
        maintenance_client: client,
        bucket,
        ..
    } = storage
    else {
        return Err("S3 is not configured".to_owned());
    };
    let _permit = storage.maintenance_provider_permit().await;
    list_bucket_page(client, bucket, token).await
}

async fn list_bucket_page(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    token: Option<String>,
) -> Result<BucketPage, String> {
    // No prefix filter: this measures physical contents, including untracked
    // objects and objects placed outside the application's normal prefixes.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[actix_web::test]
    async fn provider_request_counts_untracked_keys_without_a_prefix_filter() {
        use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
        let received = Arc::new(std::sync::Mutex::new(Vec::new()));
        let server_received = Arc::clone(&received);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = HttpServer::new(move || {
            let received = Arc::clone(&server_received);
            App::new().default_service(web::to(move |request: HttpRequest| {
                received.lock().unwrap().push(request.query_string().to_owned());
                async {
                    HttpResponse::Ok().content_type("application/xml").body(
                        "<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>physical</Name><IsTruncated>false</IsTruncated><KeyCount>3</KeyCount><Contents><Key>objects/normal</Key><Size>13</Size></Contents><Contents><Key>foreign/untracked</Key><Size>57</Size></Contents><Contents><Key>untracked-empty</Key><Size>0</Size></Contents></ListBucketResult>",
                    )
                }
            }))
        }).workers(1).listen(listener).unwrap().run();
        let handle = server.handle();
        actix_web::rt::spawn(server);
        let config = aws_sdk_s3::config::Builder::new()
            .behavior_version_latest()
            .endpoint_url(format!("http://{address}"))
            .region(aws_types::region::Region::new("us-east-1"))
            .credentials_provider(aws_credential_types::Credentials::new(
                "test",
                "test",
                None,
                None,
                "bucket-test",
            ))
            .force_path_style(true)
            .build();
        let page = list_bucket_page(&aws_sdk_s3::Client::from_conf(config), "physical", None)
            .await
            .unwrap();
        assert_eq!(page_totals(&progress(None, 0, 0), &page).unwrap(), (70, 3));
        let requests = received.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        assert!(!requests[0].contains("prefix="));
        assert!(requests[0].contains("max-keys=1000"));
        handle.stop(true).await;
    }

    fn progress(token: Option<&str>, used_bytes: i64, object_count: i64) -> ScanProgress {
        ScanProgress {
            lease_token: "worker".to_owned(),
            token: token.map(str::to_owned),
            used_bytes,
            object_count,
            pages: 0,
            token_hashes: Vec::new(),
        }
    }

    #[test]
    fn physical_totals_include_empty_objects_and_reject_invalid_pages() {
        let first = progress(None, 0, 0);
        let page = BucketPage {
            sizes: vec![13, 0, 57],
            next_token: Some("next".to_owned()),
        };
        assert_eq!(page_totals(&first, &page).unwrap(), (70, 3));
        for sizes in [vec![-1], vec![i64::MAX, 1]] {
            assert!(
                page_totals(
                    &first,
                    &BucketPage {
                        sizes,
                        next_token: None
                    }
                )
                .is_err()
            );
        }
        assert!(
            page_totals(&progress(Some("next"), 70, 3), &page)
                .unwrap_err()
                .contains("progress")
        );
        assert!(
            page_totals(
                &progress(None, 0, i64::MAX),
                &BucketPage {
                    sizes: vec![0],
                    next_token: None
                }
            )
            .is_err()
        );
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

    async fn integration_cache() -> Option<BucketUsageCache> {
        if std::env::var("AERALYTH_DATABASE_INTEGRATION_TESTS").as_deref() != Ok("1") {
            return None;
        }
        let config = crate::config::Config::from_env().expect("integration configuration");
        let db = Database::create(
            &config.database_url,
            crate::db::DatabasePoolSettings {
                role: crate::db::PoolRole::Maintenance,
                max_size: 3,
                min_size: 1,
                checkout_queue_capacity: 6,
                wait_timeout: Duration::from_secs(3),
                max_lifetime: Duration::from_secs(1_800),
                lifetime_jitter: Duration::ZERO,
            },
            crate::observability::Metrics::new(&config),
        )
        .await
        .expect("integration database");
        Some(BucketUsageCache::new(db))
    }

    async fn test_namespace(cache: &BucketUsageCache) -> String {
        let namespace: String = cache
            .db
            .query_one(
                "SELECT 'bucket-usage-test-' || gen_random_uuid()::text AS namespace",
                &[],
            )
            .await
            .unwrap()
            .get("namespace");
        assert!(matches!(
            cache.read_shared(&namespace).await.unwrap(),
            BucketUsageState::Loading
        ));
        namespace
    }

    async fn immediately_retry(cache: &BucketUsageCache, namespace: &str) {
        cache.db.execute("UPDATE bucket_usage_snapshots SET next_attempt_at = clock_timestamp() WHERE namespace = $1", &[&namespace]).await.unwrap();
    }

    #[tokio::test]
    async fn durable_scan_resumes_across_chunks_failure_and_replicas() {
        let Some(cache) = integration_cache().await else {
            return;
        };
        let namespace = test_namespace(&cache).await;
        let replica = BucketUsageCache::new(cache.db.clone());
        let mut first = cache.claim(&namespace).await.unwrap().unwrap();
        assert!(
            replica.claim(&namespace).await.unwrap().is_none(),
            "a second replica must not duplicate the scan"
        );
        // 45,000 physical objects exceed a single bounded chunk. The provider
        // model includes 1,000 objects on each page regardless of their prefix.
        let calls = std::sync::Mutex::new(Vec::new());
        let fetch = |token: Option<String>| {
            let page = token.as_deref().unwrap_or("0").parse::<usize>().unwrap();
            calls.lock().unwrap().push(page);
            std::future::ready(Ok(BucketPage {
                sizes: vec![7; 1_000],
                next_token: (page < 44).then(|| (page + 1).to_string()),
            }))
        };
        assert_eq!(
            cache
                .run_chunk(
                    &namespace,
                    &mut first,
                    &fetch,
                    Duration::from_secs(10),
                    Duration::ZERO
                )
                .await
                .unwrap(),
            ChunkResult::Yielded
        );
        assert_eq!(calls.lock().unwrap().len(), CHUNK_PAGES);
        assert!(
            matches!(
                replica.read_shared(&namespace).await.unwrap(),
                BucketUsageState::Loading
            ),
            "partial totals must not become a sample"
        );
        cache
            .release(&namespace, &first.lease_token, false)
            .await
            .unwrap();
        immediately_retry(&cache, &namespace).await;
        let mut resumed = replica.claim(&namespace).await.unwrap().unwrap();
        assert_eq!(resumed.token.as_deref(), Some("20"));
        assert_eq!(resumed.used_bytes, 140_000);
        let failure = replica
            .run_chunk(
                &namespace,
                &mut resumed,
                |_| std::future::ready(Err("provider failure".to_owned())),
                Duration::from_secs(10),
                Duration::ZERO,
            )
            .await;
        assert!(failure.is_err());
        replica
            .release(&namespace, &resumed.lease_token, true)
            .await
            .unwrap();
        assert!(
            cache.claim(&namespace).await.unwrap().is_none(),
            "failure retry must respect durable cooldown"
        );
        assert!(matches!(
            cache.read_shared(&namespace).await.unwrap(),
            BucketUsageState::Unavailable
        ));
        immediately_retry(&cache, &namespace).await;
        let mut resumed = cache.claim(&namespace).await.unwrap().unwrap();
        assert_eq!(
            resumed.token.as_deref(),
            Some("20"),
            "failed page must retain its prior checkpoint"
        );
        assert_eq!(
            cache
                .run_chunk(
                    &namespace,
                    &mut resumed,
                    &fetch,
                    Duration::from_secs(10),
                    Duration::ZERO
                )
                .await
                .unwrap(),
            ChunkResult::Yielded
        );
        cache
            .release(&namespace, &resumed.lease_token, false)
            .await
            .unwrap();
        immediately_retry(&cache, &namespace).await;
        let mut last = replica.claim(&namespace).await.unwrap().unwrap();
        assert_eq!(
            replica
                .run_chunk(
                    &namespace,
                    &mut last,
                    &fetch,
                    Duration::from_secs(10),
                    Duration::ZERO
                )
                .await
                .unwrap(),
            ChunkResult::Completed
        );
        assert_eq!(*calls.lock().unwrap(), (0..45).collect::<Vec<_>>());
        let BucketUsageState::Ready {
            usage,
            stale,
            refreshing,
        } = cache.read_shared(&namespace).await.unwrap()
        else {
            panic!("missing complete sample")
        };
        assert_eq!(usage.used_bytes, 315_000);
        assert_eq!(usage.object_count, 45_000);
        assert!(!stale && !refreshing);
        assert!(
            cache.claim(&namespace).await.unwrap().is_none(),
            "a completed sample is reused for 15 minutes across replicas"
        );
        cache
            .db
            .execute(
                "DELETE FROM bucket_usage_snapshots WHERE namespace = $1",
                &[&namespace],
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn latency_is_bounded_and_expired_worker_cannot_publish_or_fetch() {
        let Some(cache) = integration_cache().await else {
            return;
        };
        let namespace = test_namespace(&cache).await;
        let mut first = cache.claim(&namespace).await.unwrap().unwrap();
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let outcome = cache
            .run_chunk(
                &namespace,
                &mut first,
                |_| async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    Ok(BucketPage {
                        sizes: vec![1],
                        next_token: Some("1".to_owned()),
                    })
                },
                Duration::from_millis(10),
                Duration::ZERO,
            )
            .await
            .unwrap();
        assert_eq!(outcome, ChunkResult::Yielded);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        cache.db.execute("UPDATE bucket_usage_snapshots SET lease_until = clock_timestamp() - interval '1 second' WHERE namespace = $1", &[&namespace]).await.unwrap();
        let current = cache.claim(&namespace).await.unwrap().unwrap();
        assert_ne!(current.lease_token, first.lease_token);
        let outcome = cache
            .run_chunk(
                &namespace,
                &mut first,
                |_| async { panic!("expired worker must be fenced before another provider call") },
                Duration::from_secs(1),
                Duration::ZERO,
            )
            .await
            .unwrap();
        assert_eq!(outcome, ChunkResult::LeaseLost);
        let stale_publish = cache
            .db
            .execute(
                COMPLETE_QUERY,
                &[
                    &namespace,
                    &first.lease_token,
                    &999_i64,
                    &999_i64,
                    &REFRESH_SECONDS,
                ],
            )
            .await
            .unwrap();
        assert_eq!(stale_publish, 0);
        cache
            .db
            .execute(
                "DELETE FROM bucket_usage_snapshots WHERE namespace = $1",
                &[&namespace],
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn pagination_cycles_and_page_limit_survive_worker_restart() {
        let Some(cache) = integration_cache().await else {
            return;
        };
        let namespace = test_namespace(&cache).await;
        let mut first = cache.claim(&namespace).await.unwrap().unwrap();
        let result = cache
            .run_chunk(
                &namespace,
                &mut first,
                |token| {
                    std::future::ready(match token.as_deref() {
                        None => Ok(BucketPage {
                            sizes: vec![1],
                            next_token: Some("A".to_owned()),
                        }),
                        Some("A") => Ok(BucketPage {
                            sizes: vec![1],
                            next_token: Some("B".to_owned()),
                        }),
                        _ => Err("interrupted".to_owned()),
                    })
                },
                Duration::from_secs(10),
                Duration::ZERO,
            )
            .await;
        assert!(result.is_err());
        cache
            .release(&namespace, &first.lease_token, true)
            .await
            .unwrap();
        immediately_retry(&cache, &namespace).await;
        let mut resumed = cache.claim(&namespace).await.unwrap().unwrap();
        assert_eq!(resumed.pages, 2);
        assert_eq!(resumed.token_hashes, vec![token_hash("A"), token_hash("B")]);
        let result = cache
            .run_chunk(
                &namespace,
                &mut resumed,
                |_| {
                    std::future::ready(Ok(BucketPage {
                        sizes: vec![1],
                        next_token: Some("A".to_owned()),
                    }))
                },
                Duration::from_secs(10),
                Duration::ZERO,
            )
            .await;
        assert!(result.unwrap_err().contains("progress"));
        cache
            .release(&namespace, &resumed.lease_token, true)
            .await
            .unwrap();
        immediately_retry(&cache, &namespace).await;
        cache
            .db
            .execute(
                "UPDATE bucket_usage_snapshots SET scan_pages = $2 WHERE namespace = $1",
                &[&namespace, &MAX_SCAN_PAGES],
            )
            .await
            .unwrap();
        let mut limited = cache.claim(&namespace).await.unwrap().unwrap();
        let result = cache
            .run_chunk(
                &namespace,
                &mut limited,
                |_| async { panic!("page limit must stop provider calls") },
                Duration::from_secs(10),
                Duration::ZERO,
            )
            .await;
        assert!(result.unwrap_err().contains("page limit"));
        cache
            .db
            .execute(
                "DELETE FROM bucket_usage_snapshots WHERE namespace = $1",
                &[&namespace],
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn stale_complete_sample_and_original_measurement_time_survive_failure() {
        let Some(cache) = integration_cache().await else {
            return;
        };
        let namespace = test_namespace(&cache).await;
        cache.db.execute("UPDATE bucket_usage_snapshots SET used_bytes = 70, object_count = 3, measured_at = clock_timestamp() - interval '2 hours', completed_at = clock_timestamp() - interval '1 hour' WHERE namespace = $1", &[&namespace]).await.unwrap();
        let BucketUsageState::Ready {
            usage: old, stale, ..
        } = cache.read_shared(&namespace).await.unwrap()
        else {
            panic!("sample missing")
        };
        assert!(stale);
        let mut scan = cache.claim(&namespace).await.unwrap().unwrap();
        let result = cache
            .run_chunk(
                &namespace,
                &mut scan,
                |_| std::future::ready(Err("offline".to_owned())),
                Duration::from_secs(1),
                Duration::ZERO,
            )
            .await;
        assert!(result.is_err());
        cache
            .release(&namespace, &scan.lease_token, true)
            .await
            .unwrap();
        let BucketUsageState::Ready {
            usage,
            stale,
            refreshing,
        } = cache.read_shared(&namespace).await.unwrap()
        else {
            panic!("last complete sample was lost")
        };
        assert_eq!(usage.used_bytes, old.used_bytes);
        assert_eq!(usage.object_count, old.object_count);
        assert_eq!(usage.measured_at, old.measured_at);
        assert!(stale && !refreshing);
        // Completion uses scan start, rather than pretending a long scan's
        // earlier pages were measured at completion time.
        immediately_retry(&cache, &namespace).await;
        cache.db.execute("UPDATE bucket_usage_snapshots SET scan_started_at = clock_timestamp() - interval '1 hour' WHERE namespace = $1", &[&namespace]).await.unwrap();
        let mut scan = cache.claim(&namespace).await.unwrap().unwrap();
        assert_eq!(
            cache
                .run_chunk(
                    &namespace,
                    &mut scan,
                    |_| std::future::ready(Ok(BucketPage {
                        sizes: vec![9],
                        next_token: None
                    })),
                    Duration::from_secs(1),
                    Duration::ZERO
                )
                .await
                .unwrap(),
            ChunkResult::Completed
        );
        let BucketUsageState::Ready { usage, stale, .. } =
            cache.read_shared(&namespace).await.unwrap()
        else {
            panic!("completed scan missing")
        };
        assert!(stale);
        assert_eq!(usage.used_bytes, 9);
        cache
            .db
            .execute(
                "DELETE FROM bucket_usage_snapshots WHERE namespace = $1",
                &[&namespace],
            )
            .await
            .unwrap();
    }
}
