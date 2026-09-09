//! Account-scoped wakeups. PostgreSQL owns replay; slow sockets retain no queue
//! of events and never hold a database connection while waiting for a change.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{StreamExt, stream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio_postgres::{AsyncMessage, NoTls};

const MAX_CONNECTIONS: usize = 2048;
const MAX_CONNECTIONS_PER_USER: usize = 16;

#[derive(Clone)]
pub struct RealtimeHub {
    users: Arc<Mutex<HashMap<String, UserStreams>>>,
    capacity: Arc<Semaphore>,
}

struct UserStreams {
    wake: watch::Sender<u64>,
    connections: usize,
}

pub struct Subscription {
    pub wake: watch::Receiver<u64>,
    hub: RealtimeHub,
    user_id: String,
    _permit: OwnedSemaphorePermit,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let mut users = self.hub.users.lock().expect("realtime registry poisoned");
        if let Some(user) = users.get_mut(&self.user_id) {
            user.connections -= 1;
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
        }
    }

    pub fn subscribe(&self, user_id: &str) -> Option<Subscription> {
        let permit = self.capacity.clone().try_acquire_owned().ok()?;
        let mut users = self.users.lock().expect("realtime registry poisoned");
        let user = users
            .entry(user_id.to_owned())
            .or_insert_with(|| UserStreams {
                wake: watch::channel(0).0,
                connections: 0,
            });
        if user.connections >= MAX_CONNECTIONS_PER_USER {
            return None;
        }
        user.connections += 1;
        Some(Subscription {
            wake: user.wake.subscribe(),
            hub: self.clone(),
            user_id: user_id.to_owned(),
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

pub async fn run(hub: RealtimeHub, database_url: String, mut shutdown: watch::Receiver<bool>) {
    while !*shutdown.borrow() {
        let listener_shutdown = shutdown.clone();
        tokio::select! {
            _ = shutdown.changed() => break,
            result = listen(&hub, &database_url, listener_shutdown) => {
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
}

struct ConnectionTask(tokio::task::JoinHandle<()>);
impl Drop for ConnectionTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn listen(
    hub: &RealtimeHub,
    database_url: &str,
    mut shutdown: watch::Receiver<bool>,
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
    let mut last_prune = tokio::time::Instant::now() - Duration::from_secs(60);
    loop {
        tokio::select! {
            _ = shutdown.changed() => return Ok(()),
            changed = pending_wake.changed() => {
                changed.map_err(|_| "realtime database connection closed")?;
            }
            _ = tick.tick() => {}
        }
        // Multiple replicas may call this; the database serializes only this
        // short publication transaction, never the application's mutations.
        for _ in 0..8 {
            let count: i32 = client
                .query_one("SELECT realtime_dispatch()", &[])
                .await?
                .get(0);
            if count < 512 {
                break;
            }
            tokio::task::yield_now().await;
        }
        if last_prune.elapsed() >= Duration::from_secs(60) {
            for _ in 0..8 {
                let count: i32 = client
                    .query_one("SELECT realtime_prune()", &[])
                    .await?
                    .get(0);
                if count < 2048 {
                    break;
                }
            }
            last_prune = tokio::time::Instant::now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn notifications_are_scoped_and_coalesced_without_an_event_queue() {
        let hub = RealtimeHub::new();
        let mut first = hub.subscribe("alice").unwrap();
        let second = hub.subscribe("bob").unwrap();
        for _ in 0..10000 {
            hub.notify("alice");
        }
        assert!(first.wake.has_changed().unwrap());
        assert!(!second.wake.has_changed().unwrap());
        assert_eq!(*first.wake.borrow_and_update(), 10000);
        assert!(!first.wake.has_changed().unwrap());
    }

    #[test]
    fn connection_limits_and_registry_entries_are_released_on_disconnect() {
        let hub = RealtimeHub::new();
        let subscriptions: Vec<_> = (0..MAX_CONNECTIONS_PER_USER)
            .map(|_| hub.subscribe("alice").unwrap())
            .collect();
        assert!(hub.subscribe("alice").is_none());
        drop(subscriptions);
        assert!(hub.users.lock().unwrap().is_empty());
        assert_eq!(hub.capacity.available_permits(), MAX_CONNECTIONS);
        assert!(hub.subscribe("alice").is_some());
    }
}
