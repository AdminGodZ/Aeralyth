//! Account-scoped wakeups. PostgreSQL owns replay; slow sockets retain no queue
//! of events and never hold a database connection while waiting for a change.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{StreamExt, stream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio::time::Instant;

use crate::observability::Metrics;
use crate::routes::events::ReplayCache;
use tokio_postgres::{AsyncMessage, NoTls};

const MAX_CONNECTIONS: usize = 2048;
const MAX_CONNECTIONS_PER_USER: usize = 16;
pub const AUTHORIZATION_LIFETIME: Duration = Duration::from_secs(5);
const AUTHORIZATION_INTERVAL: Duration = Duration::from_secs(3);
const AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(1);

const AUTHORIZATION_QUERY: &str = "
    WITH subscribed AS MATERIALIZED (
      SELECT * FROM unnest($1::text[], $2::text[], $3::bytea[])
        AS input(user_id, session_id, token_hash)
    ), heads AS MATERIALIZED (
      SELECT user_id, (SELECT COALESCE(max(id), 0) FROM realtime_events
        WHERE user_id = audience.user_id) AS head
      FROM (SELECT DISTINCT user_id FROM subscribed) audience
    )
    SELECT input.user_id, input.session_id, input.token_hash, heads.head,
      EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = input.session_id AND s.user_id = input.user_id
          AND s.token_hash = input.token_hash AND s.expires_at > now()
          AND u.status = 'active') AS authorized
    FROM subscribed input JOIN heads USING (user_id)
";

#[derive(Clone, Copy)]
pub struct Authorization {
    pub authorized: bool,
    pub checked_at: Instant,
}

struct SessionStreams {
    token_hash: [u8; 32],
    authorization: watch::Sender<Authorization>,
    connections: usize,
}

#[derive(Clone)]
pub struct RealtimeHub {
    users: Arc<Mutex<HashMap<String, UserStreams>>>,
    capacity: Arc<Semaphore>,
    #[cfg(test)]
    authorization_queries: Arc<std::sync::atomic::AtomicUsize>,
}

struct UserStreams {
    wake: watch::Sender<u64>,
    connections: usize,
    sessions: HashMap<String, SessionStreams>,
    head: i64,
    replay: Arc<tokio::sync::Mutex<ReplayCache>>,
}

pub struct Subscription {
    pub wake: watch::Receiver<u64>,
    pub authorization: watch::Receiver<Authorization>,
    pub replay: Arc<tokio::sync::Mutex<ReplayCache>>,
    hub: RealtimeHub,
    user_id: String,
    session_id: String,
    _permit: OwnedSemaphorePermit,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let mut users = self.hub.users.lock().expect("realtime registry poisoned");
        if let Some(user) = users.get_mut(&self.user_id) {
            user.connections -= 1;
            if let Some(session) = user.sessions.get_mut(&self.session_id) {
                session.connections -= 1;
                if session.connections == 0 {
                    user.sessions.remove(&self.session_id);
                }
            }
            if user.connections == 0 {
                users.remove(&self.user_id);
            }
        }
    }
}

impl RealtimeHub {
    pub fn new() -> Self {
        Self {
            users: Arc::new(Mutex::new(HashMap::new())),
            capacity: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            #[cfg(test)]
            authorization_queries: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }

    pub fn subscribe(
        &self,
        user_id: &str,
        session_id: &str,
        token_hash: [u8; 32],
    ) -> Option<Subscription> {
        let permit = self.capacity.clone().try_acquire_owned().ok()?;
        let mut users = self.users.lock().expect("realtime registry poisoned");
        let user = users
            .entry(user_id.to_owned())
            .or_insert_with(|| UserStreams {
                wake: watch::channel(0).0,
                connections: 0,
                sessions: HashMap::new(),
                head: 0,
                replay: Arc::new(tokio::sync::Mutex::new(ReplayCache::default())),
            });
        if user.connections >= MAX_CONNECTIONS_PER_USER {
            return None;
        }
        let session = user
            .sessions
            .entry(session_id.to_owned())
            .or_insert_with(|| SessionStreams {
                token_hash,
                authorization: watch::channel(Authorization {
                    authorized: true,
                    checked_at: Instant::now(),
                })
                .0,
                connections: 0,
            });
        // A session whose credential changed cannot share the old authorization.
        if session.token_hash != token_hash {
            return None;
        }
        session.connections += 1;
        user.connections += 1;
        Some(Subscription {
            wake: user.wake.subscribe(),
            authorization: session.authorization.subscribe(),
            replay: Arc::clone(&user.replay),
            hub: self.clone(),
            user_id: user_id.to_owned(),
            session_id: session_id.to_owned(),
            _permit: permit,
        })
    }

    fn notify(&self, user_id: &str) {
        if let Some(user) = self
            .users
            .lock()
            .expect("realtime registry poisoned")
            .get(user_id)
        {
            user.wake
                .send_modify(|revision| *revision = revision.wrapping_add(1));
        }
    }

    fn notify_all(&self) {
        for user in self
            .users
            .lock()
            .expect("realtime registry poisoned")
            .values()
        {
            user.wake
                .send_modify(|revision| *revision = revision.wrapping_add(1));
        }
    }
}

pub async fn run(
    hub: RealtimeHub,
    database_url: String,
    mut shutdown: watch::Receiver<bool>,
    metrics: Metrics,
) {
    let _authorization = ConnectionTask(tokio::spawn(authorize_sessions(
        hub.clone(),
        database_url.clone(),
        shutdown.clone(),
    )));
    let mut collections = ConnectionTask(tokio::spawn(maintain_collections(
        database_url.clone(),
        shutdown.clone(),
    )));
    let mut counts = ConnectionTask(tokio::spawn(maintain_repository_counts(
        database_url.clone(),
        shutdown.clone(),
    )));
    while !*shutdown.borrow() {
        let listener_shutdown = shutdown.clone();
        tokio::select! {
            _ = shutdown.changed() => break,
            result = listen(&hub, &database_url, listener_shutdown, &metrics) => {
                if let Err(error) = result {
                    tracing::error!(%error, "realtime listener disconnected; replay remains available");
                }
            }
        }
        hub.notify_all();
        tokio::select! {
            _ = shutdown.changed() => break,
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
    }
    // Let the workers cancel their SQL before closing their dedicated
    // connections. The guards still abort the tasks if the supervisor itself
    // is cancelled.
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        let _ = tokio::join!(&mut collections.0, &mut counts.0);
    })
    .await;
}

/// One bounded query validates every distinct session and checks per-user
/// replay heads. It replaces per-socket SQL and recovers missed notifications.
async fn authorize_sessions(
    hub: RealtimeHub,
    database_url: String,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut tick = tokio::time::interval(AUTHORIZATION_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut connected: Option<(tokio_postgres::Client, ConnectionTask)> = None;
    loop {
        tokio::select! {
            _ = shutdown.changed() => return,
            _ = tick.tick() => {},
        }
        let identities: Vec<_> = {
            let users = hub.users.lock().expect("realtime registry poisoned");
            users
                .iter()
                .flat_map(|(user_id, user)| {
                    user.sessions.iter().map(|(session_id, session)| {
                        (
                            user_id.clone(),
                            session_id.clone(),
                            session.token_hash.to_vec(),
                        )
                    })
                })
                .collect()
        };
        if identities.is_empty() {
            continue;
        }
        if connected.is_none() {
            let Ok(mut config) = database_url.parse::<tokio_postgres::Config>() else {
                return;
            };
            config.connect_timeout(AUTHORIZATION_TIMEOUT);
            config.options("-c statement_timeout=1000");
            match tokio::time::timeout(AUTHORIZATION_TIMEOUT, config.connect(NoTls)).await {
                Ok(Ok((client, connection))) => {
                    connected = Some((
                        client,
                        ConnectionTask(tokio::spawn(async move {
                            let _ = connection.await;
                        })),
                    ));
                }
                _ => continue,
            }
        }
        let (user_ids, session_ids, token_hashes): (Vec<_>, Vec<_>, Vec<_>) =
            identities.into_iter().fold(
                (vec![], vec![], vec![]),
                |(mut users, mut sessions, mut hashes), (user, session, hash)| {
                    users.push(user);
                    sessions.push(session);
                    hashes.push(hash);
                    (users, sessions, hashes)
                },
            );
        // The authorization lease starts before SQL, never after a slow read.
        let checked_at = Instant::now();
        #[cfg(test)]
        hub.authorization_queries
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let result = tokio::time::timeout(
            AUTHORIZATION_TIMEOUT,
            connected.as_ref().expect("connected").0.query(
                AUTHORIZATION_QUERY,
                &[&user_ids, &session_ids, &token_hashes],
            ),
        )
        .await;
        let rows = match result {
            Ok(Ok(rows)) => rows,
            _ => {
                connected = None;
                continue;
            }
        };
        let mut users = hub.users.lock().expect("realtime registry poisoned");
        for row in rows {
            let Some(user) = users.get_mut(row.get::<_, &str>("user_id")) else {
                continue;
            };
            if let Some(session) = user.sessions.get(row.get::<_, &str>("session_id")) {
                if session.token_hash.as_slice() != row.get::<_, &[u8]>("token_hash") {
                    continue;
                }
                session.authorization.send_replace(Authorization {
                    authorized: row.get("authorized"),
                    checked_at,
                });
            }
            let head = row.get("head");
            if user.head != head {
                user.head = head;
                user.wake
                    .send_modify(|revision| *revision = revision.wrapping_add(1));
            }
        }
    }
}

struct ConnectionTask(tokio::task::JoinHandle<()>);
impl Drop for ConnectionTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Collection maintenance has independent connections, so it never blocks
/// event dispatch or auth checks. `None` means shut down.
async fn connect_maintenance(
    database_url: &str,
    application_name: &str,
    shutdown: &mut watch::Receiver<bool>,
) -> Option<Result<(tokio_postgres::Client, ConnectionTask), tokio_postgres::Error>> {
    let mut config = database_url.parse::<tokio_postgres::Config>().ok()?;
    config.application_name(application_name);
    config.connect_timeout(Duration::from_secs(5));
    config.options(
        "-c statement_timeout=10000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=15000",
    );
    let connection = tokio::select! {
        _ = shutdown.changed() => return None,
        connection = config.connect(NoTls) => connection,
    };
    Some(connection.map(|(client, connection)| {
        (
            client,
            ConnectionTask(tokio::spawn(async move {
                if let Err(error) = connection.await {
                    tracing::warn!(%error, "collection maintenance connection closed");
                }
            })),
        )
    }))
}

/// Timestamp propagation and repository count deltas. Each pass is bounded and
/// never walks a whole repository; full recounts run in their own task.
async fn maintain_collections(database_url: String, mut shutdown: watch::Receiver<bool>) {
    let mut connected: Option<(tokio_postgres::Client, ConnectionTask)> = None;
    let mut backoff = Duration::from_secs(1);
    let mut delay = Duration::ZERO;
    loop {
        if *shutdown.borrow() {
            return;
        }
        tokio::select! {
            _ = shutdown.changed() => return,
            _ = tokio::time::sleep(delay) => {},
        }
        if connected.is_none() {
            match connect_maintenance(
                &database_url,
                "aeralyth-collection-maintenance",
                &mut shutdown,
            )
            .await
            {
                None => return,
                Some(Ok(connection)) => connected = Some(connection),
                Some(Err(error)) => {
                    tracing::warn!(%error, "collection maintenance connection unavailable");
                    delay = backoff;
                    backoff = (backoff * 2).min(Duration::from_secs(30));
                    continue;
                }
            }
        }
        let client = &connected.as_ref().expect("connected").0;
        match collection_batch(
            client,
            &mut shutdown,
            "SELECT collection_changes_dispatch()",
            &[],
        )
        .await
        .map(|row| row.map(|row| row.get::<_, i32>(0)))
        {
            Ok(Some(count)) => {
                backoff = Duration::from_secs(1);
                delay = if count > 0 {
                    Duration::from_millis(100)
                } else {
                    Duration::from_secs(1)
                };
            }
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(%error, "collection maintenance interrupted; durable work will retry");
                connected = None;
                delay = backoff;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
    }
}

/// Full repository recounts, one repository per statement. The claim commits
/// a backoff before the walk starts, so a recount that times out is retried
/// later while other repositories go first.
async fn maintain_repository_counts(database_url: String, mut shutdown: watch::Receiver<bool>) {
    let mut connected: Option<(tokio_postgres::Client, ConnectionTask)> = None;
    let mut backoff = Duration::from_secs(1);
    let mut delay = Duration::ZERO;
    loop {
        if *shutdown.borrow() {
            return;
        }
        tokio::select! {
            _ = shutdown.changed() => return,
            _ = tokio::time::sleep(delay) => {},
        }
        if connected
            .as_ref()
            .is_some_and(|(client, _)| client.is_closed())
        {
            connected = None;
        }
        if connected.is_none() {
            match connect_maintenance(&database_url, "aeralyth-repository-counts", &mut shutdown)
                .await
            {
                None => return,
                Some(Ok(connection)) => connected = Some(connection),
                Some(Err(error)) => {
                    tracing::warn!(%error, "repository count connection unavailable");
                    delay = backoff;
                    backoff = (backoff * 2).min(Duration::from_secs(30));
                    continue;
                }
            }
        }
        let client = &connected.as_ref().expect("connected").0;
        let claimed = match collection_batch(
            client,
            &mut shutdown,
            "SELECT repository_counts_claim()",
            &[],
        )
        .await
        {
            Ok(Some(row)) => row.get::<_, Option<String>>(0),
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(%error, "repository count claim interrupted; durable work will retry");
                connected = None;
                delay = backoff;
                backoff = (backoff * 2).min(Duration::from_secs(30));
                continue;
            }
        };
        backoff = Duration::from_secs(1);
        let Some(repository_id) = claimed else {
            delay = Duration::from_secs(1);
            continue;
        };
        delay = Duration::from_millis(100);
        match collection_batch(
            client,
            &mut shutdown,
            "SELECT repository_counts_recount($1)",
            &[&repository_id],
        )
        .await
        {
            Ok(Some(_)) => {}
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(%error, repository_id, "repository recount failed; retrying after backoff");
            }
        }
    }
}

async fn collection_batch(
    client: &tokio_postgres::Client,
    shutdown: &mut watch::Receiver<bool>,
    query: &str,
    params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
) -> Result<Option<tokio_postgres::Row>, tokio_postgres::Error> {
    tokio::select! {
        _ = shutdown.changed() => {
            let _ = tokio::time::timeout(Duration::from_secs(1), client.cancel_token().cancel_query(NoTls)).await;
            Ok(None)
        }
        result = client.query_one(query, params) => result.map(Some),
    }
}

async fn listen(
    hub: &RealtimeHub,
    database_url: &str,
    mut shutdown: watch::Receiver<bool>,
    metrics: &Metrics,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut config: tokio_postgres::Config = database_url.parse()?;
    config.connect_timeout(Duration::from_secs(5));
    config.options("-c statement_timeout=10000 -c idle_in_transaction_session_timeout=15000");
    let (client, connection) = config.connect(NoTls).await?;
    let (pending, mut pending_wake) = watch::channel(0_u64);
    let listener_hub = hub.clone();
    let _connection = ConnectionTask(tokio::spawn(async move {
        let mut connection = Box::pin(connection);
        let mut messages =
            stream::poll_fn(move |context| connection.as_mut().poll_message(context));
        while let Some(message) = messages.next().await {
            match message {
                Ok(AsyncMessage::Notification(notification)) => {
                    if let Some(user_id) = notification.payload().strip_prefix("user:") {
                        listener_hub.notify(user_id);
                    } else {
                        pending.send_modify(|revision| *revision = revision.wrapping_add(1));
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(%error, "realtime notification connection failed");
                    break;
                }
            }
        }
    }));
    client.batch_execute("LISTEN aeralyth_changes").await?;
    hub.notify_all();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut next_prune = Instant::now();
    let mut work_pending = false;
    let mut prune_pending = false;
    loop {
        if !wait_for_work(
            &mut shutdown,
            &mut pending_wake,
            &mut tick,
            work_pending,
            prune_pending,
            next_prune,
        )
        .await?
        {
            return Ok(());
        }
        // Multiple replicas may call this; the database serializes only this
        // short publication transaction, never the application's mutations.
        let dispatch_deadline = Instant::now() + Duration::from_millis(200);
        work_pending = false;
        loop {
            let count: i32 = client
                .query_one("SELECT realtime_dispatch()", &[])
                .await?
                .get(0);
            if count < 512 {
                break;
            }
            if Instant::now() >= dispatch_deadline {
                work_pending = true;
                break;
            }
            tokio::task::yield_now().await;
        }
        if Instant::now() >= next_prune {
            let prune_deadline = Instant::now() + Duration::from_millis(250);
            let mut deleted = 0_u64;
            loop {
                let count: i32 = client
                    .query_one("SELECT realtime_prune()", &[])
                    .await?
                    .get(0);
                deleted += count as u64;
                if count < 2048 || Instant::now() >= prune_deadline {
                    break;
                }
                tokio::task::yield_now().await;
            }
            let retention = client.query_one(
                "SELECT COALESCE(EXTRACT(EPOCH FROM now() - (SELECT min(created_at) FROM realtime_events)), 0)::float8 AS oldest_age,
                  EXISTS (SELECT 1 FROM realtime_events WHERE created_at < now() - interval '24 hours'
                    OR id <= (SELECT head - 100000 FROM realtime_stream_state WHERE singleton)) AS backlog", &[]
            ).await?;
            let oldest_age =
                Duration::from_secs_f64(retention.get::<_, f64>("oldest_age").max(0.0));
            let backlog: bool = retention.get("backlog");
            metrics.record_realtime_retention(
                deleted,
                backlog,
                oldest_age,
                oldest_age.saturating_sub(Duration::from_secs(86400)),
            );
            // Bounded work per pass, immediate follow-up while rows remain.
            // This removes the former 16,384 rows/minute service-rate ceiling.
            next_prune = Instant::now()
                + if backlog {
                    Duration::from_millis(100)
                } else {
                    Duration::from_secs(60)
                };
            prune_pending = backlog;
        }
    }
}

async fn wait_for_work(
    shutdown: &mut watch::Receiver<bool>,
    pending: &mut watch::Receiver<u64>,
    tick: &mut tokio::time::Interval,
    dispatch_pending: bool,
    prune_pending: bool,
    next_prune: Instant,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    tokio::select! {
        _ = shutdown.changed() => return Ok(false),
        changed = pending.changed() => {
            changed.map_err(|_| "realtime database connection closed")?;
        }
        _ = tick.tick() => {}
        _ = tokio::time::sleep(Duration::from_millis(100)), if dispatch_pending => {}
        // An early notification may drain dispatch work. It must not discard
        // the independent deadline for a still-pending retention backlog.
        _ = tokio::time::sleep_until(next_prune), if prune_pending => {}
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn slow_collection_work_does_not_block_dispatch_and_cancels_on_shutdown() {
        if std::env::var("AERALYTH_DATABASE_INTEGRATION_TESTS").as_deref() != Ok("1") {
            return;
        }
        let url = std::env::var("DATABASE_URL").unwrap();
        let (collection, connection) = tokio_postgres::connect(&url, NoTls).await.unwrap();
        let _collection_driver = ConnectionTask(tokio::spawn(async move {
            let _ = connection.await;
        }));
        let (dispatch, connection) = tokio_postgres::connect(&url, NoTls).await.unwrap();
        let _dispatch_driver = ConnectionTask(tokio::spawn(async move {
            let _ = connection.await;
        }));
        let pid: i32 = collection
            .query_one("SELECT pg_backend_pid()", &[])
            .await
            .unwrap()
            .get(0);
        let (stop, mut shutdown) = watch::channel(false);
        let slow = tokio::spawn(async move {
            let result = collection_batch(
                &collection,
                &mut shutdown,
                "SELECT 1::integer FROM pg_sleep(30)",
                &[],
            )
            .await;
            (result, collection)
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let active: bool = dispatch.query_one("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND state='active' AND query LIKE '%pg_sleep(30)%')", &[&pid]).await.unwrap().get(0);
                if active { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("collection query should be in flight");
        tokio::time::timeout(
            Duration::from_millis(250),
            dispatch.query_one("SELECT realtime_dispatch()", &[]),
        )
        .await
        .expect("event publication waited for a collection recount")
        .unwrap();
        stop.send(true).unwrap();
        let (result, collection) = tokio::time::timeout(Duration::from_secs(2), slow)
            .await
            .expect("collection SQL did not cancel on shutdown")
            .unwrap();
        assert!(result.unwrap().is_none());
        // A queued command proves PostgreSQL stopped the sleeping statement,
        // rather than merely abandoning its Rust future for thirty seconds.
        tokio::time::timeout(
            Duration::from_millis(250),
            collection.query_one("SELECT 1", &[]),
        )
        .await
        .expect("collection SQL kept running after shutdown")
        .unwrap();
    }

    #[tokio::test]
    async fn early_notification_cannot_cancel_the_prune_backlog_deadline() {
        let (_stop, mut shutdown) = watch::channel(false);
        let (notify, mut pending) = watch::channel(0_u64);
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.tick().await;
        let deadline = Instant::now() + Duration::from_millis(100);
        notify.send(1).unwrap();
        assert!(
            wait_for_work(&mut shutdown, &mut pending, &mut tick, true, true, deadline)
                .await
                .unwrap()
        );
        // Dispatch has drained on the early wake, but pruning is not due yet.
        // The next wake must honor its original deadline rather than the 1s tick.
        assert!(
            tokio::time::timeout(
                Duration::from_millis(500),
                wait_for_work(
                    &mut shutdown,
                    &mut pending,
                    &mut tick,
                    false,
                    true,
                    deadline
                )
            )
            .await
            .expect("prune continuation waited for idle tick")
            .unwrap()
        );
        assert!(Instant::now() >= deadline);
    }

    #[tokio::test]
    async fn notifications_are_scoped_and_coalesced_without_an_event_queue() {
        let hub = RealtimeHub::new();
        let mut first = hub.subscribe("alice", "alice-session", [1; 32]).unwrap();
        let second = hub.subscribe("bob", "bob-session", [2; 32]).unwrap();
        for _ in 0..10000 {
            hub.notify("alice");
        }
        assert!(first.wake.has_changed().unwrap());
        assert!(!second.wake.has_changed().unwrap());
        assert_eq!(*first.wake.borrow_and_update(), 10000);
        assert!(!first.wake.has_changed().unwrap());
    }

    #[test]
    fn tabs_share_replay_and_session_validation_but_credentials_do_not() {
        let hub = RealtimeHub::new();
        let first = hub.subscribe("alice", "session-a", [1; 32]).unwrap();
        let second = hub.subscribe("alice", "session-a", [1; 32]).unwrap();
        let other = hub.subscribe("alice", "session-b", [2; 32]).unwrap();
        assert!(Arc::ptr_eq(&first.replay, &second.replay));
        assert!(Arc::ptr_eq(&first.replay, &other.replay));
        assert_eq!(hub.users.lock().unwrap()["alice"].sessions.len(), 2);
        assert!(hub.subscribe("alice", "session-a", [3; 32]).is_none());
    }

    #[tokio::test]
    async fn postgres_batches_2048_streams_and_detects_revocation_without_notifications() {
        if std::env::var("AERALYTH_DATABASE_INTEGRATION_TESTS").as_deref() != Ok("1") {
            return;
        }
        let url = std::env::var("DATABASE_URL").expect("isolated database URL");
        let (client, connection) = tokio_postgres::connect(&url, NoTls).await.unwrap();
        let _connection = ConnectionTask(tokio::spawn(async move {
            connection.await.unwrap();
        }));
        let prefix = format!("rt_batch_{}", std::process::id());
        let user_ids: Vec<_> = (0..128).map(|i| format!("{prefix}_{i}")).collect();
        client.execute("INSERT INTO users (id,username,password_hash,role) SELECT id,id,'test-only','user' FROM unnest($1::text[]) ids(id)", &[&user_ids]).await.unwrap();
        let session_ids: Vec<_> = (0..256).map(|i| format!("{prefix}_session_{i}")).collect();
        let session_users: Vec<_> = (0..256).map(|i| user_ids[i / 2].clone()).collect();
        let hashes: Vec<Vec<u8>> = session_ids
            .iter()
            .map(|id| crate::auth::hash_session_token(id).to_vec())
            .collect();
        client.execute("INSERT INTO sessions (id,user_id,token_hash,csrf_token,expires_at) SELECT id,user_id,hash,'csrf-test',now()+interval '1 hour' FROM unnest($1::text[],$2::text[],$3::bytea[]) inputs(id,user_id,hash)", &[&session_ids,&session_users,&hashes]).await.unwrap();
        for count in [1, 100, 2048] {
            let hub = RealtimeHub::new();
            let mut subscriptions: Vec<_> = (0..count)
                .map(|i| {
                    hub.subscribe(
                        &user_ids[i / 16],
                        &session_ids[i / 8],
                        hashes[i / 8].clone().try_into().unwrap(),
                    )
                    .unwrap()
                })
                .collect();
            let started = Instant::now();
            let (stop, shutdown) = watch::channel(false);
            let task = tokio::spawn(authorize_sessions(hub.clone(), url.clone(), shutdown));
            tokio::time::timeout(
                Duration::from_secs(2),
                subscriptions[0].authorization.changed(),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(
                hub.authorization_queries
                    .load(std::sync::atomic::Ordering::Relaxed),
                1
            );
            assert!(
                subscriptions
                    .iter()
                    .all(|subscription| subscription.authorization.borrow().authorized)
            );
            assert!(
                subscriptions
                    .iter()
                    .all(|subscription| !subscription.wake.has_changed().unwrap())
            );
            eprintln!(
                "idle cohort {count}: one authorization batch, zero replay wakeups in {:?}",
                started.elapsed()
            );
            if count == 2048 {
                // The listener is deliberately absent. Periodic batching must
                // detect both durable missed changes and session revocation.
                client.execute("INSERT INTO realtime_events (user_id,scope,folder_ids) VALUES ($1,'files',ARRAY['folder'])", &[&user_ids[0]]).await.unwrap();
                client
                    .execute("DELETE FROM sessions WHERE id=$1", &[&session_ids[0]])
                    .await
                    .unwrap();
                let revoked = Instant::now();
                loop {
                    tokio::time::timeout(
                        Duration::from_secs(5),
                        subscriptions[0].authorization.changed(),
                    )
                    .await
                    .unwrap()
                    .unwrap();
                    if !subscriptions[0].authorization.borrow().authorized {
                        break;
                    }
                }
                assert!(revoked.elapsed() < AUTHORIZATION_LIFETIME);
                assert!(subscriptions[0].wake.has_changed().unwrap());
                assert!(subscriptions[8].authorization.borrow().authorized);
                assert!(subscriptions[16].authorization.borrow().authorized);
                assert_eq!(
                    hub.authorization_queries
                        .load(std::sync::atomic::Ordering::Relaxed),
                    2
                );
            }
            stop.send(true).unwrap();
            task.await.unwrap();
        }
        client
            .execute("DELETE FROM sessions WHERE id=ANY($1)", &[&session_ids])
            .await
            .unwrap();
        client
            .execute("DELETE FROM users WHERE id=ANY($1)", &[&user_ids])
            .await
            .unwrap();
        client
            .execute(
                "DELETE FROM realtime_events WHERE user_id=ANY($1)",
                &[&user_ids],
            )
            .await
            .unwrap();
    }

    #[test]
    fn connection_limits_and_registry_entries_are_released_on_disconnect() {
        let hub = RealtimeHub::new();
        let subscriptions: Vec<_> = (0..MAX_CONNECTIONS_PER_USER)
            .map(|_| hub.subscribe("alice", "alice-session", [1; 32]).unwrap())
            .collect();
        assert!(hub.subscribe("alice", "alice-session", [1; 32]).is_none());
        drop(subscriptions);
        assert!(hub.users.lock().unwrap().is_empty());
        assert_eq!(hub.capacity.available_permits(), MAX_CONNECTIONS);
        assert!(hub.subscribe("alice", "alice-session", [1; 32]).is_some());
    }
}
