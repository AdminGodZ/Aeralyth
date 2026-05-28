# Aeralyth

Aeralyth is a self-hosted cloud project with a TypeScript/Next.js frontend and
an Actix Web backend.

## Structure

```text
src/app/      Next.js App Router frontend
backend/src/  Actix Web backend
```

The frontend is responsible for the user interface. The backend owns API
behavior, authentication, file permissions, metadata, and storage access.

## Build Checks

```bash
npm run build
cargo build --manifest-path backend/Cargo.toml
```

## Local Database

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U aeralyth -d aeralyth -f /docker-entrypoint-initdb.d/001_auth.sql
```

In local development, the Next.js app uses this Docker database by default when
`DATABASE_URL` is not set:

```text
postgres://aeralyth:aeralyth@127.0.0.1:5432/aeralyth
```

The local seed creates one admin user for development:

```text
username: admingod
password: admingod
```

## Backend Environment

The backend reads these optional environment variables:

```text
AERALYTH_API_HOST=0.0.0.0
AERALYTH_API_PORT=8080
DATABASE_URL=postgres://aeralyth:aeralyth@localhost:5432/aeralyth
AERALYTH_STORAGE_PATH=./data/files
```

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
