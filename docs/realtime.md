# Cross-device updates

Authenticated dashboard tabs subscribe to `GET /api/events`. Uploads, file and
folder changes, favorites, trash/restore, shares, repositories, profile changes,
vault changes, and session revocations produce account-scoped invalidations.
Ordinary changes refresh the affected view. Account counters use a separate
compact request, so activity in another folder does not reload the current list.

## Publication and replay

Migration `026_realtime_changes.sql` installs the durable outbox and replay log.
Migration `031_realtime_background_audiences.sql` moves recipient expansion into
bounded background work. Foreground triggers append transaction-coalesced work;
a rollback publishes nothing. The dispatcher expands recipients in bounded
pages and publishes up to 512 outbox rows per transaction. Delivery receipts
prevent overlapping ancestor grants from repeatedly notifying one recipient.

The serialized publication transaction allocates event IDs after the writer
commits. A slow writer cannot publish behind an acknowledged cursor. PostgreSQL
`NOTIFY` wakes each API instance, and a one-second dispatcher sweep recovers
missed wakeups. Notifications are hints; the committed replay log is authoritative.

Ordinary `files` events contain distinct affected parent-list IDs. The separate
`paths` scope identifies folders whose names, locations, visibility, or encrypted
metadata changed. This distinction lets a sibling update remain local while an
ancestor rename still refreshes a descendant's breadcrumbs. Moves include both
old and new parent lists. A batch of 1,000 files in one folder retains that single
folder scope. More than 32 distinct IDs collapses the affected scope to a broad
invalidation. Shared recipients receive generic `shared` changes.

The stream accepts `Last-Event-ID`, or a `cursor` query parameter when creating
an EventSource. Replay reads the head, floor, and account changes from one
snapshot. Missing, expired, or future cursors and more than 128 replay entries
produce `reset`; otherwise changes merge into a bounded frame. Concurrent tabs
for one account share compact replay results at the same cursor and wakeup
revision. Each account caches at most two results. Five-second idle `checkpoint`
frames reuse the acknowledged cursor without a replay query.

Pruning targets 24 hours or the latest 100,000 events across accounts, whichever
is smaller. A pass uses a 250 ms between-batch budget for bounded deletes and resumes
after 100 ms while eligible rows remain. An in-flight statement remains subject
to the database timeout. Its deadline is independent of dispatch
wakeups. With no backlog, the next check is after 60 seconds. Metrics record
deleted rows, remaining backlog, oldest retained event age, and time-based prune
lag. Retention is eventual; the transactional replay floor forces a reset when
pruning removes required history. The outbox stays durable until dispatched.

## Authorization and database connections

The session cookie determines the account. Clients cannot choose another
account's stream, and cross-site stream requests are rejected. Events contain
scopes and opaque IDs, never filenames, file contents, share tokens, encrypted
metadata records, or encryption keys.

One batched safety query checks every distinct subscribed session and each
user's replay head every three seconds. It verifies the exact token, session
expiry, and active account status. The query has a one-second timeout. Each
stream enforces a five-second authorization deadline measured from the start of
the last successful check. Verified revocation emits `session-expired`; a missed
safety check closes the stream. This retains the security bound when database
notifications are lost. User-head checks also recover missed change wakeups.

Each API instance has up to three dedicated connections for this runtime:

- The `LISTEN` connection runs event dispatch and replay pruning.
- The authorization connection performs batched session checks. It is opened
  when subscriptions exist and is separate from dispatch work.
- The collection-maintenance connection handles ancestor timestamps, repository
  recounts, and archive cleanup. It polls once per second when idle, continues
  after 100 ms when it processed work, and backs off after failures. Shutdown
  sends PostgreSQL a cancellation request before closing the worker connection.

These connections are additional to the request and maintenance pools. Large
repository recounts cannot occupy the listener or authorization connection.
`LISTEN` requires a direct PostgreSQL connection or session pooling;
transaction-pooling proxies cannot preserve its subscription.

Admission remains capped at 16 streams per account and 2,048 per API instance.
Subscriptions hold coalesced wakeup and authorization revisions, not an event
queue or an idle pooled connection. Initial authorization releases its request
connection before waiting for the shared replay lock. Streams reconnect after
at most approximately 25 minutes.

## Browser snapshots and refreshes

`GET /api/auth/bootstrap` returns the authenticated user, bound CSRF token, and
realtime cursor from one normal-session database read. Legacy sessions missing
a CSRF token use a conditional initialization write. React request-scoped
memoization shares the bootstrap within one server render. Page data reads
start after that cursor fence, and every committed dashboard page supplies its
fence to the realtime provider.

The provider retains up to 512 coalesced received updates. When navigation
commits a snapshot read before an event, it reconsiders updates newer than that
page's fence against the newly displayed route. This covers changes consumed
while a different folder was visible. Missing retained coverage and server
replay gaps still force broad resets.

The refresh coordinator combines bursts within 200 ms and permits one route
refresh at a time. Active local mutations defer pending changes for at most
one second. Mutation completion drains scoped changes instead of injecting a
reset. Optimistic deletions and favorites remain overlaid until confirmed;
selection and unsaved drafts retain the existing refresh behavior.

Account counters use a coalesced, single-flight `GET /api/files/summary` request.
Older responses cannot undo newer snapshots. Conflicting SSR and live counter
values trigger a fresh serialized confirmation read. Counters marked
`treeOperationPending` retain their coherent values and display “Updating
files…” while a large tree operation is pending.

Encrypted folder references invalidate by affected folder ID. Shared, vault,
and reset invalidations clear the broader resolver. Valid immutable metadata
records remain reusable across scoped changes and unchanged visibility resumes.
Unlocking alone no longer requests a full reset. Vault/security changes keep
their explicit invalidation behavior.

## Recovery

Hidden, offline, and page-hidden tabs suspend streams, requests, and timers.
Resume reconnects from the retained cursor. An unchanged replay does not refresh
the route; changes use scoped invalidation, and missing coverage resets it.
Failed SSR data reads retry independently of cursor validity, with bounded
jitter and the same refresh backpressure. Permanent client errors such as an
invalid cursor or deleted folder do not start an endless retry loop.

SSE and short `GET /api/events/sync` requests share one recovery schedule. A
failed stream closes before catch-up starts. Retries use full jitter with an
exponential cap up to ten seconds and a minimum 500 ms request spacing. A
successful replay permits the next stream attempt through that same budget;
there is no parallel one-second polling loop. Fetch recovery honors
`Retry-After`, including across suspension, and times out after ten seconds.
Both first-frame and subsequent-frame watchdogs allow 15 seconds, covering three
five-second heartbeat intervals. Canceled or superseded responses cannot
regress the cursor. Explicit `reconnect=1` marks subsequent EventSource attempts
for observability without counting the initial cursor-bearing connection.

A 401 or `session-expired` event stops recovery, locks the vault, and returns to
login. Transient failures preserve the visible page. Timing limits describe
application scheduling, not a network or production latency guarantee.

## Deployment and verification

Apply the full current migration chain before starting the updated API and
frontend together:

```bash
npm run db:migrate
```

`db:migrate:realtime` alone installs only migration 026. The current runtime also
depends on later audience, collection, and tree-operation migrations. Caddy
forwards `/api/*` directly to Actix and excludes event streams from compression.
The endpoint sends `Cache-Control: private, no-store, no-transform` and
`X-Accel-Buffering: no`. Additional proxies must allow unbuffered event streams.
No Redis or additional hosted service is required.

```bash
npm test
npm run test:performance
npm run db:test:realtime
npm run db:test:realtime-pruning
cargo test --locked --manifest-path backend/Cargo.toml
npm run test:realtime:live
```

Database integration tests require `AERALYTH_DATABASE_INTEGRATION_TESTS=1` and a
throwaway `DATABASE_URL`. The realtime SQL suite creates its own database. The
pruning fixture runs in a transaction and rolls back, but still requires an
isolated test database because it takes table locks. The live smoke test rejects
non-loopback API addresses and uses disposable accounts and sessions.

The September 12 implementation evidence is recorded in
[the realtime verification record](../performance/results/realtime-2026-09-12/verification-record.json).
The real PostgreSQL test exercised 1, 100, and 2,048 server subscriptions. Each
cohort used one initial authorization batch with zero idle replay wakeups;
revocation without notifications was detected by the next batch within the
five-second bound. These are in-process subscriptions, not a 2,048-socket HTTP
load test or a sustained whole-database idle-QPS measurement.

The final scoped frontend suite passed 113 tests. Its synchronized recovery
test used 100 client instances with fake timers and transport: exactly 100
requests occurred at 100 distinct timestamps during 1.5 seconds. Route tests
cover unrelated changes, breadcrumb changes, mutation completion, delayed page
commits, replay gaps, unavailable data, counter races, and bootstrap ordering.
They do not substitute for browser RSC/name-resolution/React-commit counts or
cold-entry and resume timing measurements.

The durable [pruning log](../performance/results/database-audit-2026-09-12/db-test-realtime-pruning.log)
records 50,000 expired rows drained in 25 bounded batches and a local steady
40,000-write probe with no expired backlog after each pass. The
[realtime SQL log](../performance/results/database-audit-2026-09-12/db-test-realtime.log)
records actual trigger payload and audience/replay checks. Full release and
container workload results are recorded separately under
`performance/results/release-2026-09-12` and
`performance/results/production-2026-09-12`; those runs have their own fixture
and workload limits.
