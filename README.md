<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.svg">
  <img alt="Aeralyth — a simple, performant, self-hosted cloud" src=".github/assets/banner-light.svg" width="100%">
</picture>

<p align="center">
  <b>Your files. Your server. Your keys.</b><br>
  End-to-end encrypted cloud storage with a Rust core and a Next.js frontend.
</p>

<p align="center">
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-0a0a0a?style=flat-square&logo=nextdotjs&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-0a0a0a?style=flat-square&logo=react&logoColor=white">
  <img alt="Rust · Actix Web" src="https://img.shields.io/badge/Rust-Actix_Web-0a0a0a?style=flat-square&logo=rust&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-0a0a0a?style=flat-square&logo=postgresql&logoColor=white">
  <img alt="S3 compatible" src="https://img.shields.io/badge/S3-compatible-0a0a0a?style=flat-square&logo=amazons3&logoColor=white">
  <img alt="End-to-end encrypted" src="https://img.shields.io/badge/E2EE-AES--256--GCM-f4b64d?style=flat-square">
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#deployment">Deployment</a>
</p>

<br>

## Features

|                          |                                                                                                                                        |
| :----------------------- | :------------------------------------------------------------------------------------------------------------------------------------- |
| **Zero-knowledge vault** | Files and names are encrypted in a browser worker before they leave the device. The server and bucket only ever see ciphertext.        |
| **Fast transfers**       | Small files upload in batched requests, large ones stream straight to the bucket in parallel multipart chunks. Downloads resume.       |
| **Folders, end to end**  | Drop whole folders — `.gitignore` rules are honoured. Download any folder as a ZIP assembled locally, never on the server.             |
| **Share links**          | Expiring links with viewer or editor access, re-displayable to their owner without storing bearer tokens.                              |
| **Live everywhere**      | Changes stream to every open tab and device over server-sent events.                                                                   |
| **Trash & auto-lock**    | Configurable trash retention and a vault that locks itself after inactivity.                                                           |
| **Invite-only**          | No public sign-up: admins create accounts or send invitation links, and get a live storage overview.                                   |
| **Built to stay up**     | Bounded queues per route class, separate request and maintenance pools, and early `429` / `503 Retry-After` instead of piling up work. |

<details>
<summary><b>Cryptography at a glance</b></summary>
<br>

| Purpose            | Primitive                             |
| :----------------- | :------------------------------------ |
| Content encryption | AES-256-GCM, 4 MiB chunks             |
| Password → key     | Argon2id                              |
| Key wrapping       | HPKE · X25519 · HKDF-SHA256           |
| Record integrity   | Ed25519 signatures                    |
| Upload integrity   | Incremental SHA-256 of the ciphertext |

All crypto runs in a dedicated Web Worker. `AERALYTH_E2EE_MODE` rolls encryption out as `off` → `migrate` → `required`.

</details>

## Architecture

```text
                 ┌──────────────────────── Browser ─────────────────────────┐
                 │   Next.js UI    ·    Web Workers: encrypt · hash · zip    │
                 └───────────┬──────────────────────────────────┬───────────┘
                             │ pages · /api/*                    │ ciphertext
                             ▼                                   │ (presigned)
                 ┌───────── Caddy ─────────┐                     │
                 ▼                         ▼                     ▼
          Next.js server            Actix API (Rust) ───────▶ S3 bucket
          UI · SSR                  auth · sessions · tree
                                    shares · events · jobs
                                           │
                                           ▼
                                      PostgreSQL
```

The frontend owns the interface. The Actix API owns everything else: authentication, sessions, permissions, metadata, and storage access.

```text
src/app/         Next.js App Router
src/features/    vault, uploads, sharing, realtime, archive, …
backend/src/     Actix Web API
database/init/   numbered, immutable SQL migrations
deployment/      Caddy ingress and production config
```

## Quick start

> **Requires** Node.js, Rust (stable), and Docker.

```bash
npm install
npm run db:up && npm run db:migrate   # PostgreSQL in Docker
npm run dev:api                       # Actix API  → http://127.0.0.1:8080
npm run dev                           # Next.js    → http://localhost:3000
```

Sign in with the development seed account **`aeralyth` / `aeralyth`**.

During `next dev`, browser `/api/*` requests are proxied to the API. Point `AERALYTH_API_ORIGIN` elsewhere if Actix isn't on the default port. Without `DATABASE_URL`, the API uses the Docker database at `postgres://aeralyth:aeralyth@127.0.0.1:5432/aeralyth`.

<details>
<summary><b>Checks</b></summary>
<br>

```bash
npm run lint                                    # Biome
npm test                                        # Vitest
cargo test --manifest-path backend/Cargo.toml   # API
npm run build                                   # production build

curl http://127.0.0.1:8080/api/health/ready     # API + database readiness
```

</details>

## Configuration

Everything is optional in development. In production, these matter:

| Variable                            | Purpose                                                                       |
| :---------------------------------- | :---------------------------------------------------------------------------- |
| `DATABASE_URL`                      | PostgreSQL connection string                                                  |
| `AERALYTH_STORAGE_BACKEND=s3`       | Store objects in S3, configured through the standard `AWS_*` variables        |
| `AERALYTH_E2EE_MODE`                | `off`, `migrate`, or `required` (the last two need S3)                        |
| `AERALYTH_SHARE_LINK_SECRET`        | **Required.** Generate once with `openssl rand -base64 32` and keep it stable |
| `AERALYTH_BOOTSTRAP_ADMIN_PASSWORD` | First deploy only — replaces the seed password (≥ 32 characters)              |
| `AERALYTH_COOKIE_SECURE`            | `false` in debug builds; `true` in release, as `__Host-aeralyth_session`      |
| `AERALYTH_TRUSTED_PROXY_RANGES`     | CIDRs whose `X-Forwarded-For` Caddy trusts (default `100.64.0.0/10`)          |

The production image refuses to start while any active account still uses the seed password. The full list, including pool sizes, admission budgets, and multipart tuning, lives in [`.env.example`](.env.example).

<details>
<summary><b>How the admission budgets fit together</b></summary>
<br>

- **Database** — request and maintenance pools are separate; treat their combined maximum as one per-instance PostgreSQL connection budget.
- **Passwords** — hashing runs in a bounded Rust worker queue, never holding a database connection.
- **Tree work** — the recursive budget (default `AERALYTH_DB_POOL_MAX - 2`) is split evenly between interactive browsing and bulk work like trash or delete, so a large delete never blocks navigation.
- **Uploads** — encrypted files up to 1 MiB are published in batches through the API (≤ 9 MiB per batch); larger files go from the browser straight to the bucket.
- **Storage** — provider calls have their own bounded queue; overflow sheds early with `503 Retry-After`.

</details>

## Deployment

One image runs **Caddy**, the standalone **Next.js** server, and the **Actix** API. Caddy routes `/api/*` straight to Actix and everything else to Next.js. PostgreSQL and the private S3 bucket stay separate resources.

On [Railway](https://railway.com), migrations run as a pre-deploy command and a deployment only goes live once `/health/ready` passes.

| File                                                                                       | Contents                  |
| :----------------------------------------------------------------------------------------- | :------------------------ |
| [`railway.json`](railway.json)                                                             | Build and deploy settings |
| [`Dockerfile`](Dockerfile)                                                                 | The production image      |
| [`deployment/Caddyfile`](deployment/Caddyfile)                                             | Ingress routing           |
| [`deployment/railway-s3-cors.production.json`](deployment/railway-s3-cors.production.json) | Bucket CORS policy        |
| [`database/MIGRATIONS.md`](database/MIGRATIONS.md)                                         | Migration contract        |

<details>
<summary><b>Operational notes</b></summary>
<br>

- Attach the public domain before applying the origin-restricted bucket CORS policy.
- Behind Cloudflare, Railway reports Cloudflare's address as the client. Caddy then takes the visitor from `CF-Connecting-IP`, but only when the reported address is inside `AERALYTH_CLOUDFLARE_RANGES` (Cloudflare's published ranges by default); from any other address that header is ignored.
- On S3 providers that support lifecycle rules, `AERALYTH_S3_ABORT_INCOMPLETE_MULTIPART_DAYS=7` installs a prefix-scoped cleanup rule and relaxes the provider scan from hourly to daily. Railway buckets don't support lifecycle rules, so leave it unset there.
- Changing `AERALYTH_SHARE_LINK_SECRET` doesn't break existing links, but their owners can no longer re-display them until they're replaced.
- Set `AERALYTH_ENABLE_NEXT_API_PROXY=true` only when running `next start` without the Caddy ingress.
- A CDN in front of Railway does not stop anyone from connecting to Railway's edge directly with the custom domain as the host name. Set `AERALYTH_ALLOWED_EDGE_RANGES` to the CDN's address ranges and Caddy answers 403 to every other caller, except on the health endpoints Railway probes itself.
- For the durable-tree migration, apply the full chain, then drain older API instances and workers before starting the new API.

</details>

<br>

<p align="center">
  <img src="public/aeralyth_logo.svg" width="28" alt=""><br>
  <sub>Made for people who'd rather own their cloud.</sub>
</p>
