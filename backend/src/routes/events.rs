use std::collections::BTreeMap;
use std::time::Duration;

use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use bytes::Bytes;
use futures_util::stream;
use serde::{Deserialize, Serialize};

use crate::auth::{SESSION_COOKIE, hash_session_token, require_principal};
use crate::db::Database;
use crate::realtime::Subscription;
use crate::state::{AppState, LoadShedError};

const HEARTBEAT: Duration = Duration::from_secs(5);
const STREAM_LIFETIME: Duration = Duration::from_secs(25 * 60);
const REPLAY_QUERY: &str = "
    SELECT state.head, state.floor,
      EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $2 AND s.user_id = $1 AND s.token_hash = $4
          AND s.expires_at > now() AND u.status = 'active') AS authorized,
      COALESCE((SELECT json_agg(batch)::text FROM (
        SELECT scope, folder_ids AS \"folderIds\" FROM realtime_events
        WHERE user_id = $1 AND id > $3 AND id <= state.head
        ORDER BY id LIMIT 129
      ) batch), '[]') AS changes
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

struct Snapshot {
    head: i64,
    floor: i64,
    authorized: bool,
    changes: Vec<Change>,
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
    subscription: Subscription,
    user_id: String,
    session_id: String,
    token_hash: [u8; 32],
    cursor: Option<i64>,
    initial: Option<Snapshot>,
    expires: tokio::time::Instant,
}

pub async fn events(
    state: web::Data<AppState>,
    request: HttpRequest,
    query: web::Query<EventQuery>,
) -> Result<HttpResponse> {
    require_same_origin(&request)?;
    let principal = require_principal(&state, &request).await?;
    let cursor = request_cursor(&request, &query)?;
    let subscription = state
        .realtime
        .subscribe(&principal.id)
        .ok_or_else(|| LoadShedError::too_many_requests("too many event streams"))?;
    let token_hash = hash_session_token(
        request
            .cookie(SESSION_COOKIE)
            .expect("authenticated cookie")
            .value(),
    );
    let mut event_stream = EventStream {
        db: state.db.clone(),
        subscription,
        user_id: principal.id,
        session_id: principal.session_id,
        token_hash,
        cursor,
        initial: None,
        expires: tokio::time::Instant::now() + STREAM_LIFETIME,
    };
    let initial = snapshot(&event_stream)
        .await
        .map_err(error::ErrorServiceUnavailable)?;
    if !initial.authorized {
        return Err(error::ErrorUnauthorized("session expired"));
    }
    event_stream.initial = Some(initial);
    state.db.release_request_connection().await;

    let body = stream::unfold(event_stream, |mut state| async move {
        if tokio::time::Instant::now() >= state.expires {
            return None;
        }
        let snapshot = if let Some(initial) = state.initial.take() {
            initial
        } else {
            tokio::select! {
                result = state.subscription.wake.changed() => {
                    if result.is_err() { return None; }
                    // Coalesce bulk commits before reading the current snapshot.
                    tokio::time::sleep(Duration::from_millis(75)).await;
                    state.subscription.wake.borrow_and_update();
                }
                _ = tokio::time::sleep(HEARTBEAT) => {}
            }
            match snapshot(&state).await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    tracing::warn!(%error, "event stream interrupted; client will resume");
                    return None;
                }
            }
        };
        if !snapshot.authorized {
            state.expires = tokio::time::Instant::now();
            return Some((
                Ok::<_, actix_web::Error>(Bytes::from_static(
                    b"event: session-expired\ndata: {}\n\n",
                )),
                state,
            ));
        }
        let frame = encode_snapshot(state.cursor, &snapshot);
        state.cursor = Some(snapshot.head);
        Some((Ok::<_, actix_web::Error>(Bytes::from(frame)), state))
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
    let token_hash = hash_session_token(
        request
            .cookie(SESSION_COOKIE)
            .expect("authenticated cookie")
            .value(),
    );
    let snapshot = read_snapshot(
        &state.db,
        &principal.id,
        &principal.session_id,
        &token_hash,
        cursor,
    )
    .await
    .map_err(error::ErrorServiceUnavailable)?;
    if !snapshot.authorized {
        return Err(error::ErrorUnauthorized("session expired"));
    }
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
) -> std::result::Result<Snapshot, Box<dyn std::error::Error + Send + Sync>> {
    read_snapshot(
        &state.db,
        &state.user_id,
        &state.session_id,
        &state.token_hash,
        state.cursor,
    )
    .await
}

async fn read_snapshot(
    db: &Database,
    user_id: &str,
    session_id: &str,
    token_hash: &[u8; 32],
    cursor: Option<i64>,
) -> std::result::Result<Snapshot, Box<dyn std::error::Error + Send + Sync>> {
    let row = db
        .query_one(
            REPLAY_QUERY,
            &[
                &user_id,
                &session_id,
                &cursor.unwrap_or(0),
                &token_hash.as_slice(),
            ],
        )
        .await?;
    Ok(Snapshot {
        head: row.get("head"),
        floor: row.get("floor"),
        authorized: row.get("authorized"),
        changes: serde_json::from_str(row.get::<_, &str>("changes"))?,
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
            authorized: true,
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
            authorized: true,
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
