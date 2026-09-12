use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use bytes::Bytes;
use futures_util::stream;
use serde::{Deserialize, Serialize};

use crate::auth::{SESSION_COOKIE, hash_session_token, require_principal};
use crate::db::Database;
use crate::observability::Metrics;
use crate::realtime::{AUTHORIZATION_LIFETIME, Subscription};
use crate::state::{AppState, LoadShedError};

const HEARTBEAT: Duration = Duration::from_secs(5);
const STREAM_LIFETIME: Duration = Duration::from_secs(25 * 60);
const REPLAY_QUERY: &str = "
    SELECT state.head, state.floor,
      COALESCE((SELECT json_agg(batch)::text FROM (
        SELECT scope, folder_ids AS \"folderIds\" FROM realtime_events
        WHERE user_id = $1 AND id > $2 AND id <= state.head
        ORDER BY id LIMIT 129
      ) batch), '[]') AS changes,
      COALESCE((SELECT max(age) FROM (
        SELECT EXTRACT(EPOCH FROM now() - created_at)::float8 AS age FROM realtime_events
        WHERE user_id = $1 AND id > $2 AND id <= state.head
        ORDER BY id LIMIT 129
      ) ages), 0)::float8 AS delivery_lag
    FROM realtime_stream_state state WHERE singleton
";

#[derive(Deserialize)]
pub struct EventQuery {
    cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Change {
    scope: String,
    folder_ids: Vec<String>,
}

#[derive(Clone)]
pub(crate) struct Snapshot {
    head: i64,
    floor: i64,
    changes: Vec<Change>,
    delivery_lag: Duration,
    overflow: bool,
}

#[derive(Default)]
pub(crate) struct ReplayCache {
    entries: VecDeque<(Option<i64>, u64, Arc<Snapshot>)>,
}

#[derive(Serialize)]
struct SyncResponse {
    // PostgreSQL bigint cursors must not lose precision in JavaScript.
    cursor: String,
    reset: bool,
    changes: Vec<Change>,
}

struct EventStream {
    db: Database,
    metrics: Metrics,
    subscription: Subscription,
    user_id: String,
    cursor: Option<i64>,
    initial: Option<Arc<Snapshot>>,
    expires: tokio::time::Instant,
    heartbeat: tokio::time::Instant,
}

pub async fn events(
    state: web::Data<AppState>,
    request: HttpRequest,
    query: web::Query<EventQuery>,
) -> Result<HttpResponse> {
    require_same_origin(&request)?;
    let principal = require_principal(&state, &request).await?;
    // A stream may already hold the per-user replay lock while waiting for a
    // pool lease. Never retain a request lease while waiting for that lock.
    state.db.release_request_connection().await;
    let cursor = request_cursor(&request, &query)?;
    let token_hash = hash_session_token(
        request
            .cookie(SESSION_COOKIE)
            .expect("authenticated cookie")
            .value(),
    );
    let subscription = state
        .realtime
        .subscribe(&principal.id, &principal.session_id, token_hash)
        .ok_or_else(|| LoadShedError::too_many_requests("too many event streams"))?;
    let mut event_stream = EventStream {
        db: state.db.clone(),
        metrics: state.metrics.clone(),
        subscription,
        user_id: principal.id,
        cursor,
        initial: None,
        expires: tokio::time::Instant::now() + STREAM_LIFETIME,
        heartbeat: tokio::time::Instant::now() + HEARTBEAT,
    };
    let initial = snapshot(&event_stream)
        .await
        .map_err(error::ErrorServiceUnavailable)?;
    event_stream.initial = Some(initial);
    state.db.release_request_connection().await;

    let body = stream::unfold(event_stream, |mut state| async move {
        loop {
            let now = tokio::time::Instant::now();
            if now >= state.expires {
                if state.subscription.authorization.borrow().authorized {
                    state.metrics.record_sse_termination("lifetime");
                }
                return None;
            }
            let authorization = *state.subscription.authorization.borrow_and_update();
            if !authorization.authorized {
                state.metrics.record_sse_termination("auth");
                state.expires = now;
                return Some((
                    Ok::<_, actix_web::Error>(Bytes::from_static(
                        b"event: session-expired\ndata: {}\n\n",
                    )),
                    state,
                ));
            }
            // Missing safety checks fail closed within the original five-second
            // security bound, even when the notification connection is down.
            let authorized_until = authorization.checked_at + AUTHORIZATION_LIFETIME;
            if now >= authorized_until {
                state.metrics.record_sse_termination("auth_check_timeout");
                return None;
            }
            let snapshot = if let Some(initial) = state.initial.take() {
                Some(initial)
            } else {
                tokio::select! {
                    changed = state.subscription.authorization.changed() => {
                        if changed.is_err() { state.metrics.record_sse_termination("shutdown"); return None; }
                        continue;
                    }
                    _ = tokio::time::sleep_until(authorized_until.min(state.expires)) => { continue; }
                    result = state.subscription.wake.changed() => {
                        if result.is_err() { state.metrics.record_sse_termination("shutdown"); return None; }
                        tokio::time::sleep(Duration::from_millis(75)).await;
                        state.subscription.wake.borrow_and_update();
                        match tokio::time::timeout_at(authorized_until, snapshot(&state)).await {
                            Ok(Ok(snapshot)) => Some(snapshot),
                            Ok(Err(_)) => { state.metrics.record_sse_termination("database"); return None; },
                            Err(_) => { state.metrics.record_sse_termination("auth_check_timeout"); return None; },
                        }
                    }
                    _ = tokio::time::sleep_until(state.heartbeat) => None,
                }
            };
            // SQL and coalescing may outlive a revocation notification. Check
            // the lease again immediately before emitting any user changes.
            let authorization = *state.subscription.authorization.borrow();
            if !authorization.authorized
                || tokio::time::Instant::now() >= authorization.checked_at + AUTHORIZATION_LIFETIME
            {
                continue;
            }
            let frame = if let Some(snapshot) = snapshot {
                if !snapshot.changes.is_empty() {
                    state.metrics.record_sse_delivery_lag(snapshot.delivery_lag);
                }
                let frame = encode_snapshot(state.cursor, &snapshot);
                state.cursor = Some(snapshot.head);
                frame
            } else {
                format!(
                    "id: {}\nevent: checkpoint\ndata: {{}}\n\n",
                    state.cursor.unwrap_or(0)
                )
            };
            state.heartbeat = tokio::time::Instant::now() + HEARTBEAT;
            return Some((Ok::<_, actix_web::Error>(Bytes::from(frame)), state));
        }
    });
    Ok(HttpResponse::Ok()
        .insert_header(("Content-Type", "text/event-stream"))
        .insert_header(("Cache-Control", "private, no-store, no-transform"))
        .insert_header(("X-Accel-Buffering", "no"))
        .streaming(body))
}

/// Short requests use the same durable replay and session checks as the stream.
/// They do not allocate a streaming subscription or refresh unchanged pages.
pub async fn sync(
    state: web::Data<AppState>,
    request: HttpRequest,
    query: web::Query<EventQuery>,
) -> Result<HttpResponse> {
    require_same_origin(&request)?;
    let principal = require_principal(&state, &request).await?;
    let cursor = request_cursor(&request, &query)?;
    let snapshot = read_snapshot(&state.db, &principal.id, cursor)
        .await
        .map_err(error::ErrorServiceUnavailable)?;
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "private, no-store, no-transform"))
        .json(sync_response(cursor, &snapshot)))
}

fn require_same_origin(request: &HttpRequest) -> Result<()> {
    if request
        .headers()
        .get("sec-fetch-site")
        .is_some_and(|site| site == "cross-site")
    {
        return Err(error::ErrorForbidden("same-origin event stream required"));
    }
    Ok(())
}

fn request_cursor(request: &HttpRequest, query: &EventQuery) -> Result<Option<i64>> {
    request
        .headers()
        .get("last-event-id")
        .map(|value| {
            value
                .to_str()
                .map_err(|_| error::ErrorBadRequest("invalid event cursor"))
        })
        .transpose()?
        .or(query.cursor.as_deref())
        .map(parse_cursor)
        .transpose()
}

fn parse_cursor(value: &str) -> Result<i64> {
    if value.is_empty() || value.len() > 19 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(error::ErrorBadRequest("invalid event cursor"));
    }
    value
        .parse::<i64>()
        .map_err(|_| error::ErrorBadRequest("invalid event cursor"))
}

async fn snapshot(
    state: &EventStream,
) -> std::result::Result<Arc<Snapshot>, Box<dyn std::error::Error + Send + Sync>> {
    // This helper is also used during initial HTTP setup, where auth may
    // have acquired a task-local lease. Release it before the shared lock.
    state.db.release_request_connection().await;
    let generation = *state.subscription.wake.borrow();
    let mut cache = state.subscription.replay.lock().await;
    if let Some((_, _, snapshot)) = cache
        .entries
        .iter()
        .find(|(cursor, revision, _)| *cursor == state.cursor && *revision == generation)
    {
        return Ok(Arc::clone(snapshot));
    }
    let snapshot = Arc::new(read_snapshot(&state.db, &state.user_id, state.cursor).await?);
    cache
        .entries
        .retain(|(_, revision, _)| *revision == generation);
    if cache.entries.len() >= 2 {
        cache.entries.pop_front();
    }
    cache
        .entries
        .push_back((state.cursor, generation, Arc::clone(&snapshot)));
    Ok(snapshot)
}

async fn read_snapshot(
    db: &Database,
    user_id: &str,
    cursor: Option<i64>,
) -> std::result::Result<Snapshot, Box<dyn std::error::Error + Send + Sync>> {
    let row = db
        .query_one(REPLAY_QUERY, &[&user_id, &cursor.unwrap_or(0)])
        .await?;
    let changes: Vec<Change> = serde_json::from_str(row.get::<_, &str>("changes"))?;
    Ok(Snapshot {
        head: row.get("head"),
        floor: row.get("floor"),
        overflow: changes.len() > 128,
        changes: merge_changes(&changes),
        delivery_lag: Duration::from_secs_f64(row.get::<_, f64>("delivery_lag").max(0.0)),
    })
}

fn encode_snapshot(cursor: Option<i64>, snapshot: &Snapshot) -> String {
    let response = sync_response(cursor, snapshot);
    if response.reset {
        return format!(
            "retry: 2000\nid: {}\nevent: reset\ndata: {{}}\n\n",
            snapshot.head
        );
    }
    if response.changes.is_empty() {
        return format!("id: {}\nevent: checkpoint\ndata: {{}}\n\n", snapshot.head);
    }
    format!(
        "id: {}\nevent: changes\ndata: {}\n\n",
        snapshot.head,
        serde_json::to_string(&response.changes).expect("change metadata is JSON serializable")
    )
}

fn sync_response(cursor: Option<i64>, snapshot: &Snapshot) -> SyncResponse {
    let reset = cursor.is_none_or(|cursor| cursor < snapshot.floor || cursor > snapshot.head)
        || snapshot.overflow
        || snapshot.changes.len() > 128;
    SyncResponse {
        cursor: snapshot.head.to_string(),
        reset,
        changes: if reset {
            vec![]
        } else {
            merge_changes(&snapshot.changes)
        },
    }
}

fn merge_changes(changes: &[Change]) -> Vec<Change> {
    let mut scopes: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for change in changes {
        scopes
            .entry(change.scope.clone())
            .and_modify(|folders| {
                if folders.is_empty() || change.folder_ids.is_empty() {
                    folders.clear();
                    return;
                }
                folders.extend(change.folder_ids.iter().cloned());
                folders.sort();
                folders.dedup();
                if folders.len() > 32 {
                    folders.clear();
                }
            })
            .or_insert_with(|| change.folder_ids.clone());
    }
    scopes
        .into_iter()
        .map(|(scope, folder_ids)| Change { scope, folder_ids })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[actix_web::test]
    async fn shared_replay_releases_request_lease_before_waiting_and_reuses_the_result() {
        if std::env::var("AERALYTH_DATABASE_INTEGRATION_TESTS").as_deref() != Ok("1") {
            return;
        }
        let config = crate::config::Config::from_env().unwrap();
        let metrics = Metrics::new(&config);
        let db = Database::create(
            &config.database_url,
            crate::db::DatabasePoolSettings {
                role: crate::db::PoolRole::Request,
                max_size: 1,
                min_size: 1,
                checkout_queue_capacity: 4,
                wait_timeout: Duration::from_secs(1),
                max_lifetime: Duration::from_secs(60),
                lifetime_jitter: Duration::ZERO,
            },
            metrics.clone(),
        )
        .await
        .unwrap();
        let hub = crate::realtime::RealtimeHub::new();
        let subscription = hub
            .subscribe("replay-test", "test-session", [1; 32])
            .unwrap();
        let replay = Arc::clone(&subscription.replay);
        let stream = EventStream {
            db: db.clone(),
            metrics,
            subscription,
            user_id: "replay-test".into(),
            cursor: Some(0),
            initial: None,
            expires: tokio::time::Instant::now() + STREAM_LIFETIME,
            heartbeat: tokio::time::Instant::now() + HEARTBEAT,
        };
        let held_lock = replay.lock_owned().await;
        let (leased, lease_ready) = tokio::sync::oneshot::channel();
        let request_db = db.clone();
        let waiting_request = actix_web::rt::spawn(crate::db::scope_request(async move {
            // Simulate the authorization read of an incoming SSE request.
            request_db.query_one("SELECT 1", &[]).await.unwrap();
            leased.send(()).unwrap();
            let first = snapshot(&stream).await.unwrap();
            let second = snapshot(&stream).await.unwrap();
            assert!(
                Arc::ptr_eq(&first, &second),
                "tabs at the same cursor reuse one replay"
            );
            request_db.release_request_connection().await;
        }));
        lease_ready.await.unwrap();
        // Simulate the earlier stream that owns the shared lock and needs
        // the only database connection. Retaining auth's lease deadlocks it.
        tokio::time::timeout(Duration::from_millis(250), db.ping())
            .await
            .expect("incoming auth lease starved replay owner")
            .unwrap();
        drop(held_lock);
        tokio::time::timeout(Duration::from_millis(250), waiting_request)
            .await
            .expect("initial SSE replay did not finish")
            .unwrap();
    }

    #[test]
    fn cursors_cannot_inject_sse_fields_or_overflow() {
        for value in ["", "-1", "1\nevent: reset", "9223372036854775808", "1.5"] {
            assert!(parse_cursor(value).is_err());
        }
        assert_eq!(parse_cursor("9223372036854775807").unwrap(), i64::MAX);
    }

    #[test]
    fn stale_future_and_large_replays_require_a_snapshot() {
        let mut snapshot = Snapshot {
            head: 50,
            floor: 10,
            delivery_lag: Duration::ZERO,
            overflow: false,
            changes: vec![],
        };
        for cursor in [None, Some(9), Some(51)] {
            assert!(encode_snapshot(cursor, &snapshot).contains("event: reset"));
        }
        assert!(encode_snapshot(Some(10), &snapshot).contains("event: checkpoint"));
        snapshot.changes = vec![
            Change {
                scope: "files".into(),
                folder_ids: vec![]
            };
            129
        ];
        assert!(encode_snapshot(Some(10), &snapshot).contains("event: reset"));
    }

    #[test]
    fn sync_preserves_bigint_cursors_and_uses_the_same_reset_and_merge_rules() {
        let snapshot = Snapshot {
            head: i64::MAX,
            floor: 10,
            delivery_lag: Duration::ZERO,
            overflow: false,
            changes: vec![
                Change {
                    scope: "files".into(),
                    folder_ids: vec!["a".into()]
                };
                2
            ],
        };
        let response = sync_response(Some(10), &snapshot);
        assert_eq!(response.cursor, "9223372036854775807");
        assert!(!response.reset);
        assert_eq!(response.changes.len(), 1);
        assert_eq!(response.changes[0].folder_ids, vec!["a"]);
        assert_eq!(
            serde_json::to_value(&response).unwrap()["cursor"],
            "9223372036854775807"
        );
        let reset = sync_response(Some(9), &snapshot);
        assert!(reset.reset);
        assert!(reset.changes.is_empty());
    }

    #[test]
    fn bulk_changes_merge_and_full_invalidation_is_not_narrowed() {
        let changes = vec![
            Change {
                scope: "files".into(),
                folder_ids: vec!["a".into()],
            },
            Change {
                scope: "files".into(),
                folder_ids: vec!["b".into()],
            },
            Change {
                scope: "shared".into(),
                folder_ids: vec![],
            },
            Change {
                scope: "shared".into(),
                folder_ids: vec!["c".into()],
            },
        ];
        let merged = merge_changes(&changes);
        assert_eq!(merged[0].folder_ids, ["a", "b"]);
        assert!(merged[1].folder_ids.is_empty());
    }
}
