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
AERALYTH_COOKIE_SECURE=false
AERALYTH_STORAGE_BACKEND=s3
AERALYTH_E2EE_MODE=migrate
```

`AERALYTH_COOKIE_SECURE` defaults to `false` for debug builds and `true` for
release builds.

The Next.js frontend proxies browser `/api/*` requests to the Actix backend.
Override the target when Actix is not reachable at the local default:

```text
AERALYTH_API_ORIGIN=http://127.0.0.1:8080
```

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
