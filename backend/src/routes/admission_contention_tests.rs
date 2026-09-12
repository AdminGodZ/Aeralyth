//! Explicit backend admission measurement. This does not measure browser rendering or S3.
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use actix_web::{body::to_bytes, cookie::Cookie, test::TestRequest, web};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::time::Instant;

use crate::auth::{SESSION_COOKIE, hash_session_token, require_principal};
use crate::db::scope_request;
use crate::state::{AppState, QueuedMutationLimiter};

const PROVIDER_DELAY_MS: u64 = 750;
const ARRIVAL_INTERVALS_MS: [u64; 2] = [20, 10];
const SAMPLES_PER_COHORT: usize = 200;
const REPEATS: usize = 3;
const FILES_PER_OWNER: usize = 500;
const ARCHIVE_QUERY: &str = "
    WITH RECURSIVE tree AS (
      SELECT id, parent_id, size_bytes FROM visible_files
      WHERE id = $1 AND owner_id = $2
      UNION ALL
      SELECT child.id, child.parent_id, child.size_bytes
      FROM visible_files AS child INNER JOIN tree ON child.parent_id = tree.id
      WHERE child.owner_id = $2
    )
    SELECT count(*)::bigint AS nodes, COALESCE(sum(size_bytes), 0)::bigint AS bytes,
      pg_sleep(0.020) FROM tree
";

#[derive(Clone)]
struct Actor {
    user: String,
    folder: String,
    token: String,
}

#[derive(Serialize)]
struct Sample {
    cohort: &'static str,
    status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_details: Option<String>,
    scheduled_to_complete_ms: f64,
    handler_ms: f64,
    arrival_lag_ms: f64,
    started_during_provider: bool,
}

#[derive(Serialize)]
struct Distribution {
    samples: usize,
    p50_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    max_ms: f64,
}

fn distribution(mut values: Vec<f64>) -> Distribution {
    values.sort_by(f64::total_cmp);
    let percentile = |percent: usize| {
        if values.is_empty() {
            0.0
        } else {
            values[(values.len() * percent).div_ceil(100) - 1]
        }
    };
    Distribution {
        samples: values.len(),
        p50_ms: percentile(50),
        p95_ms: percentile(95),
        p99_ms: percentile(99),
        max_ms: values.last().copied().unwrap_or(0.0),
    }
}

#[derive(Serialize)]
struct CohortReport {
    offered: usize,
    successful: usize,
    rejected: usize,
    other_failures: usize,
    provider_window_offered: usize,
    provider_window_successful: usize,
    provider_window_rejected: usize,
    status_counts: BTreeMap<u16, usize>,
    successful_handler: Distribution,
    successful_scheduled_to_complete: Distribution,
    successful_started_during_provider: Distribution,
    arrival_lag: Distribution,
}

fn cohort_report(samples: &[Sample], cohort: &str) -> CohortReport {
    let rows: Vec<_> = samples
        .iter()
        .filter(|sample| sample.cohort == cohort)
        .collect();
    let mut status_counts = BTreeMap::new();
    for sample in &rows {
        *status_counts.entry(sample.status).or_default() += 1;
    }
    let successful: Vec<_> = rows
        .iter()
        .copied()
        .filter(|sample| sample.status == 200)
        .collect();
    let rejected = rows
        .iter()
        .filter(|sample| matches!(sample.status, 429 | 503))
        .count();
    CohortReport {
        offered: rows.len(),
        successful: successful.len(),
        rejected,
        other_failures: rows.len() - successful.len() - rejected,
        provider_window_offered: rows
            .iter()
            .filter(|sample| sample.started_during_provider)
            .count(),
        provider_window_successful: successful
            .iter()
            .filter(|sample| sample.started_during_provider)
            .count(),
        provider_window_rejected: rows
            .iter()
            .filter(|sample| sample.started_during_provider && matches!(sample.status, 429 | 503))
            .count(),
        status_counts,
        successful_handler: distribution(successful.iter().map(|s| s.handler_ms).collect()),
        successful_scheduled_to_complete: distribution(
            successful
                .iter()
                .map(|s| s.scheduled_to_complete_ms)
                .collect(),
        ),
        successful_started_during_provider: distribution(
            successful
                .iter()
                .filter(|s| s.started_during_provider)
                .map(|s| s.handler_ms)
                .collect(),
        ),
        arrival_lag: distribution(rows.iter().map(|s| s.arrival_lag_ms).collect()),
    }
}

async fn browse(
    state: web::Data<AppState>,
    actor: Actor,
    cohort: &'static str,
    scheduled: Instant,
    provider_active: Arc<AtomicBool>,
) -> Sample {
    let started = Instant::now();
    let started_during_provider = provider_active.load(Ordering::Acquire);
    let query = web::Query::<super::files::FilesQuery>::from_query(&format!(
        "view=files&folder={}&limit=50",
        actor.folder
    ))
    .unwrap();
    let request = TestRequest::get()
        .app_data(state.clone())
        .cookie(Cookie::new(SESSION_COOKIE, actor.token))
        .to_http_request();
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        scope_request(super::files::list_files(state, request, query)),
    )
    .await;
    let (status, error_details) = match response {
        Ok((Ok(response), _)) => {
            let status = response.status().as_u16();
            let body = to_bytes(response.into_body()).await.unwrap();
            if status == 200 {
                let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(body["entries"].as_array().unwrap().len(), 50);
                assert_eq!(body["currentFolderId"], actor.folder);
            }
            let error_details = (status != 200)
                .then(|| String::from_utf8_lossy(&body).chars().take(2_048).collect());
            (status, error_details)
        }
        Ok((Err(error), _)) => (
            error.as_response_error().status_code().as_u16(),
            // Every request targets the synthetic actors created in this test. Keep the
            // actual handler failure so a saved 500 can be diagnosed after the run.
            Some(format!("{error:?}").chars().take(2_048).collect()),
        ),
        Err(_) => (
            0,
            Some("list_files exceeded the five-second measurement deadline".to_owned()),
        ),
    };
    let finished = Instant::now();
    Sample {
        cohort,
        status,
        error_details,
        started_during_provider,
        scheduled_to_complete_ms: (finished - scheduled).as_secs_f64() * 1000.0,
        handler_ms: (finished - started).as_secs_f64() * 1000.0,
        arrival_lag_ms: started.saturating_duration_since(scheduled).as_secs_f64() * 1000.0,
    }
}

#[derive(Serialize)]
struct RunReport {
    profile: &'static str,
    repeat: usize,
    arrival_interval_ms_per_cohort: u64,
    same_user: CohortReport,
    other_user: CohortReport,
    provider_finalization_ms: f64,
    bulk_completed: usize,
    bulk_completed_during_provider: usize,
    bulk_rejected: usize,
    pool_available_after: usize,
    pool_size_after: usize,
    samples: Vec<Sample>,
}

async fn run_profile(shared: bool, repeat: usize, arrival_interval_ms: u64) -> RunReport {
    let state = crate::state::database_test_state(4).await;
    let mut inner = Arc::try_unwrap(state.into_inner())
        .ok()
        .expect("unshared test state");
    if shared {
        let gate = QueuedMutationLimiter::new(2, 1, 8, 4);
        inner.interactive_operation_limiter = gate.clone();
        inner.recursive_operation_limiter = gate;
    }
    let state = web::Data::new(inner);
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let mut actors = Vec::new();
    for index in 0..2 {
        let user = format!("usr_admission_{suffix}_{index}");
        let folder = format!("fil_admission_{suffix}_{index}");
        let session = format!("ses_admission_{suffix}_{index}");
        let token = format!("admission-token-{suffix}-{index}");
        let hash = hash_session_token(&token);
        state.db.execute("INSERT INTO users(id,username,password_hash,role,status) VALUES($1,$1,'not-a-login-hash','user','active')", &[&user]).await.unwrap();
        state.db.execute("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,'csrf',now()+interval '1 hour')", &[&session, &user, &hash.as_slice()]).await.unwrap();
        state.db.execute("INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type) VALUES($1,$2,'admission-root',$1,0,'folder')", &[&folder,&user]).await.unwrap();
        state.db.execute("INSERT INTO files(id,owner_id,parent_id,original_name,storage_name,size_bytes,entry_type) SELECT $1 || '_' || n,$2,$1,'tiny-' || lpad(n::text,4,'0'),$1 || '/' || n,1024,'file' FROM generate_series(1,$3::integer) AS n", &[&folder,&user,&(FILES_PER_OWNER as i32)]).await.unwrap();
        actors.push(Actor {
            user,
            folder,
            token,
        });
    }
    let provider_active = Arc::new(AtomicBool::new(false));
    // Prepare each handler/pool path before collecting measurements.
    for actor in &actors {
        for _ in 0..4 {
            assert_eq!(
                browse(
                    state.clone(),
                    actor.clone(),
                    "warmup",
                    Instant::now(),
                    provider_active.clone()
                )
                .await
                .status,
                200
            );
        }
    }
    let (provider_started, started) = tokio::sync::oneshot::channel();
    let provider_state = state.clone();
    let provider_actor = actors[0].clone();
    let provider_marker = provider_active.clone();
    let provider = actix_web::rt::spawn(async move {
        let request = TestRequest::post()
            .app_data(provider_state.clone())
            .cookie(Cookie::new(SESSION_COOKIE, provider_actor.token))
            .to_http_request();
        let (elapsed, _) = scope_request(async {
            require_principal(&provider_state, &request).await.unwrap();
            let held = if shared {
                Some(
                    provider_state
                        .acquire_recursive_operation(&provider_actor.user)
                        .await
                        .unwrap(),
                )
            } else {
                None
            };
            let start = Instant::now();
            provider_state
                .storage_operations
                .run(&provider_actor.user, async {
                    provider_marker.store(true, Ordering::Release);
                    provider_started.send(()).unwrap();
                    tokio::time::sleep(Duration::from_millis(PROVIDER_DELAY_MS)).await;
                    provider_marker.store(false, Ordering::Release);
                })
                .await
                .unwrap();
            let commit_permit = if shared {
                None
            } else {
                Some(
                    provider_state
                        .acquire_recursive_operation(&provider_actor.user)
                        .await
                        .unwrap(),
                )
            };
            provider_state
                .db
                .execute(
                    "UPDATE files SET updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2",
                    &[&provider_actor.folder, &provider_actor.user],
                )
                .await
                .unwrap();
            drop((held, commit_permit));
            start.elapsed().as_secs_f64() * 1000.0
        })
        .await;
        elapsed
    });
    started.await.unwrap();
    let bulk_completed = Arc::new(AtomicUsize::new(0));
    let bulk_during_provider = Arc::new(AtomicUsize::new(0));
    let bulk_rejected = Arc::new(AtomicUsize::new(0));
    let bulk_state = state.clone();
    let bulk_actor = actors[1].clone();
    let completed = bulk_completed.clone();
    let during_provider = bulk_during_provider.clone();
    let rejected = bulk_rejected.clone();
    let provider_marker = provider_active.clone();
    let start = Instant::now() + Duration::from_millis(10);
    let stop = start + Duration::from_millis(SAMPLES_PER_COHORT as u64 * arrival_interval_ms);
    let bulk = actix_web::rt::spawn(async move {
        while Instant::now() < stop {
            let (result, _) = scope_request(async {
                let permit = bulk_state
                    .acquire_recursive_operation(&bulk_actor.user)
                    .await;
                let Ok(_permit) = permit else {
                    return false;
                };
                let row = bulk_state
                    .db
                    .query_one(ARCHIVE_QUERY, &[&bulk_actor.folder, &bulk_actor.user])
                    .await
                    .unwrap();
                assert_eq!(row.get::<_, i64>("nodes"), (FILES_PER_OWNER + 1) as i64);
                assert_eq!(row.get::<_, i64>("bytes"), (FILES_PER_OWNER * 1024) as i64);
                true
            })
            .await;
            if result {
                completed.fetch_add(1, Ordering::Relaxed);
                if provider_marker.load(Ordering::Acquire) {
                    during_provider.fetch_add(1, Ordering::Relaxed);
                }
            } else {
                rejected.fetch_add(1, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
    });
    let mut requests = Vec::new();
    for sample in 0..SAMPLES_PER_COHORT {
        let scheduled = start + Duration::from_millis(sample as u64 * arrival_interval_ms);
        tokio::time::sleep_until(scheduled).await;
        for (index, cohort) in ["same_user", "other_user"].into_iter().enumerate() {
            requests.push(actix_web::rt::spawn(browse(
                state.clone(),
                actors[index].clone(),
                cohort,
                scheduled,
                provider_active.clone(),
            )));
        }
    }
    let mut samples = Vec::with_capacity(requests.len());
    for request in requests {
        samples.push(request.await.unwrap());
    }
    let provider_finalization_ms = provider.await.unwrap();
    bulk.await.unwrap();
    let report = RunReport {
        profile: if shared {
            "shared_gate_counterfactual"
        } else {
            "partitioned"
        },
        repeat,
        arrival_interval_ms_per_cohort: arrival_interval_ms,
        same_user: cohort_report(&samples, "same_user"),
        other_user: cohort_report(&samples, "other_user"),
        provider_finalization_ms,
        bulk_completed: bulk_completed.load(Ordering::Relaxed),
        bulk_completed_during_provider: bulk_during_provider.load(Ordering::Relaxed),
        bulk_rejected: bulk_rejected.load(Ordering::Relaxed),
        pool_available_after: state.db.status().available,
        pool_size_after: state.db.status().size,
        samples,
    };
    assert_eq!(report.pool_available_after, report.pool_size_after);
    for actor in actors {
        state
            .db
            .execute("DELETE FROM users WHERE id=$1", &[&actor.user])
            .await
            .unwrap();
    }
    report
}

#[actix_web::test]
#[ignore = "explicit PostgreSQL backend admission latency measurement; creates durable report"]
async fn measure_provider_bulk_and_browse_admission_contention() {
    let mut runs = Vec::new();
    for arrival_interval_ms in ARRIVAL_INTERVALS_MS {
        for repeat in 1..=REPEATS {
            // Alternate order to avoid always assigning the colder host to one profile.
            for shared in if repeat % 2 == 1 {
                [true, false]
            } else {
                [false, true]
            } {
                runs.push(run_profile(shared, repeat, arrival_interval_ms).await);
            }
        }
    }
    let mut source_sha256 = BTreeMap::new();
    for (name, source) in [
        (
            "backend/src/routes/admission_contention_tests.rs",
            include_str!("admission_contention_tests.rs"),
        ),
        ("backend/src/routes/files.rs", include_str!("files.rs")),
        ("backend/src/state.rs", include_str!("../state.rs")),
        ("backend/src/auth.rs", include_str!("../auth.rs")),
        ("backend/src/db.rs", include_str!("../db.rs")),
    ] {
        source_sha256.insert(name, format!("{:x}", Sha256::digest(source.as_bytes())));
    }
    let report = serde_json::json!({
        "generated_unix_ms": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis(),
        "measurement": "actual list_files handler completion through real PostgreSQL and production admission primitives",
        "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "provider_delay_ms": PROVIDER_DELAY_MS,
        "arrival_intervals_ms_per_cohort": ARRIVAL_INTERVALS_MS,
        "samples_per_cohort_per_run": SAMPLES_PER_COHORT,
        "repeats": REPEATS,
        "request_pool_max": 4,
        "recursive_workers_total": 2,
        "recursive_queue_total": 8,
        "per_user_workers_per_class": 1,
        "files_per_owner": FILES_PER_OWNER,
        "listing_page_size": 50,
        "archive_query_artificial_delay_ms": 20,
        "limitations": [
            "The baseline is a same-build shared-gate counterfactual, not an old deployed binary.",
            "Provider finalization is a controlled delay inside the real storage admission service; no S3 request or encrypted publication is sent.",
            "Bulk work is a real bounded recursive PostgreSQL query with a 20 ms pg_sleep to keep contention reproducible.",
            "The actual listing handler, sessions, folder authorization, listing and summary SQL run; HTTP transport, browser rendering and client decryption are excluded.",
            "Scheduled-to-complete latency includes arrival scheduling delay; successful latency distributions exclude explicit rejections, which are reported separately.",
            "This is a local debug test on a shared development host and does not establish production latency."
        ],
        "source_sha256": source_sha256,
        "runs": runs,
    });
    let directory = std::env::var_os("AERALYTH_ADMISSION_REPORT_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!(
                "aeralyth-admission-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            ))
        });
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join("results.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!(
        "admission report={}",
        directory.join("results.json").display()
    );
    for run in &runs {
        assert_eq!(run.same_user.offered, SAMPLES_PER_COHORT);
        assert_eq!(run.other_user.offered, SAMPLES_PER_COHORT);
        println!(
            "admission profile={} repeat={} interval_ms={} same_p95_ms={:.3} same_p99_ms={:.3} same_rejected={} other_p95_ms={:.3} other_p99_ms={:.3} other_rejected={} bulk_completed={} bulk_during_provider={}",
            run.profile,
            run.repeat,
            run.arrival_interval_ms_per_cohort,
            run.same_user.successful_handler.p95_ms,
            run.same_user.successful_handler.p99_ms,
            run.same_user.rejected,
            run.other_user.successful_handler.p95_ms,
            run.other_user.successful_handler.p99_ms,
            run.other_user.rejected,
            run.bulk_completed,
            run.bulk_completed_during_provider
        );
        assert_eq!(
            run.same_user.other_failures + run.other_user.other_failures,
            0
        );
        if run.profile == "partitioned" {
            assert!(
                run.bulk_completed >= 10 && run.bulk_completed_during_provider >= 5,
                "bulk must make progress during browsing and provider delay"
            );
        }
    }
    for interval in ARRIVAL_INTERVALS_MS {
        for cohort in ["same_user", "other_user"] {
            let select = |shared: bool| {
                runs.iter()
                    .filter(|run| {
                        run.arrival_interval_ms_per_cohort == interval
                            && (run.profile == "shared_gate_counterfactual") == shared
                    })
                    .flat_map(|run| run.samples.iter())
                    .filter(|sample| sample.cohort == cohort)
                    .collect::<Vec<_>>()
            };
            let baseline = select(true);
            let current = select(false);
            let latency = |samples: &[&Sample]| {
                distribution(
                    samples
                        .iter()
                        .filter(|sample| sample.status == 200)
                        .map(|sample| sample.handler_ms)
                        .collect(),
                )
            };
            assert!(
                latency(&current).p99_ms < latency(&baseline).p99_ms,
                "reserved capacity must reduce this controlled workload's successful handler p99"
            );
            let rejects = |samples: &[&Sample]| {
                samples
                    .iter()
                    .filter(|sample| matches!(sample.status, 429 | 503))
                    .count()
            };
            assert!(
                rejects(&current) <= rejects(&baseline),
                "tail improvement must not come from rejecting more requests"
            );
        }
    }
}
