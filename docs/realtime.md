# Cross-device updates

Authenticated dashboard tabs subscribe to `GET /api/events`. Uploads, file and
folder changes, favorites, trash/restore, shares, repositories, profile changes,
vault changes, and session revocations trigger account-scoped invalidations.
The browser refreshes server data while retaining the current route and React
state. File pages also refresh their account-wide counters when a different
folder changes.

## Publication and replay

Migration `026_realtime_changes.sql` installs statement-level database triggers.
They append to `realtime_outbox` in the same transaction as the change. A rollback
therefore emits nothing. Bulk writes merge by transaction, account, and scope;
folder lists collapse to a whole-scope invalidation beyond 32 IDs.

Every API instance owns one dedicated PostgreSQL `LISTEN` connection. A short
dispatcher transaction drains up to 512 committed outbox rows and assigns event
IDs while holding a shared advisory lock. Event IDs are allocated at publication,
so a slow transaction cannot commit an event behind a cursor that a client has
already acknowledged. `NOTIFY` wakes subscribers on every API instance. A
one-second dispatcher sweep recovers from missed wakeups; notifications are not
the source of truth.

The stream accepts `Last-Event-ID`, or a `cursor` query parameter for a newly
created EventSource. It reads the head, retention floor, session validity, and
account events from one database snapshot. A new connection without a cursor,
an expired or future cursor, or more than 128 replay entries produces `reset`.
Clients then refetch the current state. Otherwise the server combines changes
into one `changes` frame. `checkpoint` frames advance the cursor without
refreshing the UI.

Each API instance prunes in bounded batches once per minute. The replay log
targets 24 hours or the latest 100,000 events across accounts, whichever is
smaller. These are eventual retention bounds; traffic bursts and downtime can
temporarily exceed them. The transactional outbox remains durable until drained.

## Authorization and resource limits

- The session cookie determines the account. Clients cannot choose an account
  or subscribe to another user's channel. Cross-site stream requests are rejected.
- Owner events contain scopes and opaque folder/node IDs. Shared recipients
  receive only a generic `shared` invalidation, including former recipients
  after revocation. Events contain no filenames, plaintext content, share tokens,
  encrypted metadata records, or encryption keys.
- Every replay or heartbeat query checks that the exact session token is still
  valid and its account is active. Revocation wakes that account; the server emits
  `session-expired`, and the browser locks its vault and returns to login.
  Heartbeats provide a 15-second recheck when no wakeup arrives.
- Connections are capped at 16 per account and 2,048 per API instance. These are
  per-instance limits. Each connection holds a coalesced wakeup revision, not an
  event queue. Idle sockets do not hold pooled database connections.
- Each stream lasts at most about 25 minutes before reconnecting. The dedicated
  listener requires a direct PostgreSQL connection or session pooling;
  transaction-pooling proxies do not preserve `LISTEN` subscriptions.

## Browser behavior

The refresh coordinator combines event bursts within 200 ms and permits one
route refresh at a time. Local uploads, tree mutations, sharing operations, and
profile saves defer refreshes until the operation finishes. Optimistic file
deletions and favorites remain overlaid until the server confirms them. Existing
selection and unsaved profile or repository-description drafts survive refreshes.

Encrypted folder references are invalidated by affected ID. Shared/vault/reset
events clear the broader metadata resolver. Versioned immutable metadata records
remain reusable after scoped folder invalidation, and old in-flight prefetches
cannot restore an invalidated folder reference.

Hidden or offline tabs close their stream. Returning to the page reconnects and
requests a fresh snapshot. Native reconnects replay from the cursor. If the stream
stops responding for 45 seconds it is recreated. While disconnected, a session
probe runs at most every 30 seconds and refreshes only if the API responds
successfully. This keeps the current page visible during an API outage.

## Deployment

Apply the migration before starting API instances containing the SSE routes:

```bash
npm run db:migrate
```

For an existing installation with migrations 001–025 already applied:

```bash
npm run db:migrate:realtime
```

Deploy the API, frontend, and updated Caddyfile together. Caddy forwards `/api/*`
directly to Actix and excludes `text/event-stream` from compression. The endpoint
sets `Cache-Control: private, no-store, no-transform` and `X-Accel-Buffering: no`.
Any additional proxy must also allow unbuffered event streams. No Redis or new
hosted service is required. Reverting the application can leave migration 026
installed, but its outbox will accumulate while no dispatcher is running.

## Verification

```bash
npm test
npm run test:performance
npm run db:test:realtime
cargo test --locked --manifest-path backend/Cargo.toml
npm run test:realtime:live
```

The database test creates and drops its own database. It checks bulk coalescing,
rollback, account isolation, cascade revocation, staged/encrypted publication,
encrypted recipient revocation, migration replay, commit order, and retention.
The live test requires the local Docker database and a running
local API. It creates randomized temporary accounts/sessions and removes them
in `finally`. It rejects non-loopback API addresses. Use only development data.

To exercise separate API instances or a temporary Caddy proxy:

```bash
AERALYTH_PERF_URL=http://127.0.0.1:18082/health \
AERALYTH_REALTIME_SECOND_ORIGIN=http://127.0.0.1:18081 \
npm run test:realtime:live
```

Local verification on 2026-09-09 covered two independent browser sessions for
upload, favorite/selection preservation, deletion, and restore. The live stream
test passed through Caddy and a second API instance, including replay, cursor
reset, account isolation, session revocation, and a 513-recipient burst. Measured
stream delivery was 184 ms in that run; one browser deletion appeared about
360 ms after its API response. These are local observations, not a production
latency guarantee. Browser checks used legacy files in local E2EE-off mode;
encrypted cache invalidation is covered by resolver tests, not a production
encrypted-vault browser run.
