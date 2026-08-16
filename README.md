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

## Build Checks

```bash
npm run build
cargo build --manifest-path backend/Cargo.toml
```

The encrypted vault design and rollout procedure are documented in
[docs/e2ee.md](docs/e2ee.md). Object-storage configuration is documented in
[docs/storage.md](docs/storage.md).

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
worker queue instead of consuming PostgreSQL connections.

`AERALYTH_COOKIE_SECURE` defaults to `false` for debug builds and `true` for
release builds.

`AERALYTH_SHARE_LINK_SECRET` is required in production so active share URLs can
be shown to their owner again without storing bearer tokens in PostgreSQL.
Generate it once with `openssl rand -base64 32` and keep it stable; changing it
does not break links already distributed, but those links can no longer be
redisplayed in the owner dialog until they are explicitly replaced.

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
command and activates a deployment only after `/health` succeeds. PostgreSQL
and the private S3 bucket remain separate Railway resources.

Follow [docs/production-railway.md](docs/production-railway.md) for the ordered
database cutover, variables, GitHub CI gate, bucket CORS, and
`cloud.admingod.ch` domain setup.
