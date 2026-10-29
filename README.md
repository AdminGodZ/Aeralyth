# Aeralyth

Aeralyth is a self-hosted cloud project with a TypeScript/Next.js frontend and
an Actix Web backend.

## Structure

```text
src/app/      Next.js App Router frontend
backend/src/  Actix Web backend
```

The frontend is responsible for the user interface. The Actix backend owns API
behavior, authentication, sessions, file permissions, metadata, and storage
access.

## Git workspace setup

Use a Git clone when a workspace needs branches, history, or a working remote:

```bash
git clone https://github.com/AdminGodZ/Aeralyth.git
cd Aeralyth
git rev-parse --show-toplevel
git branch --show-current
git log --oneline -5
git remote -v
```

The `.git` directory belongs to the checkout. Do not copy it into Aeralyth's
tracked source or try to commit it. A GitHub source archive and a plain folder
copy contain a source snapshot, not repository metadata. A workspace created
from either form must clone the repository separately if it needs Git history
or branch operations. GitHub-connected workspace tools should use their
checkout or clone workflow instead of importing the source archive. Aeralyth
does not provide automatic two-way Git synchronization.

Aeralyth's folder-upload review treats `.git` as a hidden directory. It is not
uploaded automatically, but the user can explicitly include it in the review
dialog. That option stores the selected metadata as files in Aeralyth. It does
not turn an unrelated external workspace into a Git checkout.

## Build Checks

```bash
npm run build
cargo build --manifest-path backend/Cargo.toml
```

## Local Database

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U aeralyth -d aeralyth -f /docker-entrypoint-initdb.d/001_auth.sql
docker compose exec -T postgres psql -U aeralyth -d aeralyth -f /docker-entrypoint-initdb.d/002_e2ee.sql
docker compose exec -T postgres psql -U aeralyth -d aeralyth -f /docker-entrypoint-initdb.d/003_share_links.sql
docker compose exec -T postgres psql -U aeralyth -d aeralyth -f /docker-entrypoint-initdb.d/004_repositories.sql
```

In local development, the Actix backend uses this Docker database by default
when `DATABASE_URL` is not set:

```text
postgres://aeralyth:aeralyth@127.0.0.1:5432/aeralyth
```

The local seed creates one admin user for development:

```text
username: admingod
password: admingod
```

The production image refuses to migrate or start while any active account
still uses this seed password. On a fresh production database, set
`AERALYTH_BOOTSTRAP_ADMIN_PASSWORD` (at least 32 characters, for example
`openssl rand -base64 32`) for the first deploy. The migration replaces the
seed password only while it is still the seed, so the variable can be removed
afterwards.

## Local Runtime

Run the local stack in three processes:

```bash
npm run db:up
npm run db:migrate
```

```bash
npm run dev:api
```

```bash
npm run dev
```

The frontend expects the Actix API at `http://127.0.0.1:8080` by default. If
the login page shows a backend unavailable error, the Actix process is not
reachable or `AERALYTH_API_ORIGIN` points at the wrong API origin.

Useful checks:

```bash
curl http://127.0.0.1:8080/api/health
curl http://127.0.0.1:8080/api/health/ready
curl http://127.0.0.1:3000/api/health
```

## Backend Environment

The backend reads these optional environment variables:

```text
AERALYTH_API_HOST=0.0.0.0
AERALYTH_API_PORT=8080
DATABASE_URL=postgres://aeralyth:aeralyth@localhost:5432/aeralyth
AERALYTH_DB_POOL_MAX=8
AERALYTH_DB_POOL_MIN=2
AERALYTH_DB_POOL_QUEUE_CAPACITY=64
AERALYTH_DB_MAINTENANCE_POOL_MAX=2
AERALYTH_DB_MAINTENANCE_POOL_MIN=1
AERALYTH_DB_MAINTENANCE_POOL_QUEUE_CAPACITY=16
AERALYTH_DB_POOL_WAIT_MS=1000
AERALYTH_DB_CONNECTION_MAX_LIFETIME_SECONDS=1800
AERALYTH_DB_CONNECTION_LIFETIME_JITTER_SECONDS=600
AERALYTH_PASSWORD_WORKERS=2
AERALYTH_PASSWORD_QUEUE_CAPACITY=16
AERALYTH_LOGIN_ATTEMPTS_PER_ADDRESS_MINUTE=60
AERALYTH_LOGIN_ATTEMPTS_PER_ACCOUNT_MINUTE=10
AERALYTH_UPLOAD_CONTROL_CONCURRENCY=8
AERALYTH_UPLOAD_CONTROL_PER_USER=3
AERALYTH_RECURSIVE_OPERATION_CONCURRENCY=2
AERALYTH_RECURSIVE_OPERATION_PER_USER=1
AERALYTH_RECURSIVE_OPERATION_QUEUE_CAPACITY=8
AERALYTH_RECURSIVE_OPERATION_PER_USER_QUEUE_CAPACITY=4
AERALYTH_STORAGE_OPERATION_CONCURRENCY=16
AERALYTH_STORAGE_OPERATION_PER_USER=8
AERALYTH_STORAGE_OPERATION_QUEUE_CAPACITY=32
AERALYTH_STORAGE_OPERATION_PER_USER_QUEUE_CAPACITY=16
AERALYTH_STORAGE_MAINTENANCE_CONCURRENCY=8
AERALYTH_COOKIE_SECURE=false
AERALYTH_STORAGE_BACKEND=s3
AERALYTH_E2EE_MODE=migrate
AERALYTH_SHARE_LINK_SECRET=<at-least-32-random-bytes>
```

Request and maintenance database pools are deliberately separate. Treat their
maximum sizes as one per-instance PostgreSQL connection budget when tuning a
deployment. The small prewarmed minimums avoid cold reconnects; healthy idle
connections stay pooled, while maximum-lifetime recycling is staggered by the
configured jitter. Password hashing and verification run in the bounded Rust
worker queue instead of consuming PostgreSQL connections. Upload control,
recursive tree work, and storage-provider calls have separate bounded admission
budgets. Recursive and provider queues absorb ordinary overlap while still
shedding excess work before it can create unbounded waiters behind lightweight
routes.

`AERALYTH_COOKIE_SECURE` defaults to `false` for debug builds and `true` for
release builds.

`AERALYTH_SHARE_LINK_SECRET` is required in production so active share URLs can
be shown to their owner again without storing bearer tokens in PostgreSQL.
Generate it once with `openssl rand -base64 32` and keep it stable; changing it
does not break links already distributed, but those links can no longer be
redisplayed in the owner dialog until they are explicitly replaced.

For compatible S3 providers, setting
`AERALYTH_S3_ABORT_INCOMPLETE_MULTIPART_DAYS=7` installs or updates Aeralyth's
prefix-scoped incomplete-multipart lifecycle rule while preserving unrelated
rules. The value must remain safely beyond valid upload and reconciliation
grace windows. Once the provider confirms the rule, Aeralyth retains its state
repair sweep but reduces the global provider scan from hourly to daily. Railway
Storage Buckets [do not currently support lifecycle
configuration](https://docs.railway.com/storage-buckets), so leave this setting
unset on Railway; the hourly application reconciliation remains the outage
backstop there.

During `next dev`, the Next.js frontend proxies browser `/api/*` requests to
the Actix backend. Override the local target when Actix is not reachable at the
default:

```text
AERALYTH_API_ORIGIN=http://127.0.0.1:8080
```

Production keeps the same public `/api/*` URLs but routes them through Caddy:
API and health traffic goes directly to Actix, while page and static traffic
goes to the standalone Next.js server. The production image reserves port 8081
for Actix so Caddy can safely bind Railway's public `PORT` even when it is 8080.
The startup script also selects collision-free internal ports if `PORT` is
customized to one of the normal internal defaults.
Set
`AERALYTH_ENABLE_NEXT_API_PROXY=true` only as an explicit compatibility fallback
when running `next start` without that ingress router.

## Railway production

The repository includes one production image containing Caddy, the standalone
Next.js server, and the Actix API. Railway runs migrations as a pre-deploy
command and activates a deployment only after `/health/ready` succeeds. PostgreSQL
and the private S3 bucket remain separate Railway resources.

Deployment settings are in [railway.json](railway.json), environment variables
in [.env.example](.env.example), and the production bucket CORS policy in
[deployment/railway-s3-cors.production.json](deployment/railway-s3-cors.production.json).
Attach `cloud.admingod.ch` before applying that origin-restricted bucket policy.

For the durable-tree migration, apply the full migration chain, then drain and
stop older API instances and maintenance workers before starting the updated
API. Workers can resume persisted jobs before public traffic switches. Every
replica and rollback version must honor tree visibility fences while jobs are
pending or running, including when workers are paused.
