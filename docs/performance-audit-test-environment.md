# Performance audit test environment

The September 12, 2026 audit remediation uses a separate PostgreSQL container and
an empty local MinIO bucket. These services support migration, concurrency, and
transfer verification without changing the existing development database.

## Verified setup

| Component | Verified value |
| --- | --- |
| PostgreSQL container | `aeralyth-audit-20260912` |
| PostgreSQL endpoint | `127.0.0.1:55432` |
| PostgreSQL version | 18.4, Linux ARM64 |
| Baseline database | `aeralyth_audit_baseline` |
| Baseline migrations | `001_auth.sql` through `027_flexible_retention_and_vault_lock.sql` |
| MinIO container | `aeralyth-audit-s3-20260912` |
| S3 endpoint | `http://127.0.0.1:59000` |
| S3 bucket | `aeralyth-audit` |
| MinIO client | `RELEASE.2025-08-13T08-35-41Z` |

Each audit container has a 1 GiB memory limit. Both bind published ports to
localhost and use `--rm`, so stopping them removes the containers and their
anonymous storage. Neither container has a restart policy.

Docker Desktop was stopped before setup. Starting it also resumed the existing
`aeralyth-postgres` container on port 5432 through its existing restart policy.
Audit setup did not alter that container's data or run migrations against it.

The baseline applied every existing migration through 027 with
`ON_ERROR_STOP=1`. It is now a PostgreSQL template. Keep this database unchanged
and apply new migrations to a clone. The following clones were created from it.

| Database | Assigned work |
| --- | --- |
| `aeralyth_audit_metadata` | Root metadata verification |
| `aeralyth_audit_migration` | Database lifetime and migration progress |
| `aeralyth_audit_hierarchy` | Hierarchy, counters, and early ETag |
| `aeralyth_audit_realtime` | Realtime and session batching |
| `aeralyth_audit_storage` | Storage metadata and persistence |
| `aeralyth_audit_tree` | Tree jobs and mutation fences |
| `aeralyth_audit_mixed` | Mixed SQL and S3 workload fixtures |

## Database commands

Run commands from the repository root. Docker calls require access to the local
Docker socket. In Codex's restricted shell this required an approved
`require_escalated` invocation.

Create another independent baseline clone with a unique database name.

```sh
docker exec aeralyth-audit-20260912 psql -X -v ON_ERROR_STOP=1 \
  -U aeralyth -d postgres \
  -c 'CREATE DATABASE aeralyth_audit_example TEMPLATE aeralyth_audit_baseline;'
```

Apply a new migration or fixture directly from the working tree.

```sh
docker exec -i aeralyth-audit-20260912 psql -X -v ON_ERROR_STOP=1 \
  -U aeralyth -d aeralyth_audit_example < database/init/028_migration_progress.sql
```

Replace the example filename with the migration under test. These containers
do not mount the working tree. If a test expects migration files inside
`/docker-entrypoint-initdb.d`, copy the current migration snapshot explicitly.

```sh
docker cp database/init/. aeralyth-audit-20260912:/docker-entrypoint-initdb.d/
```

For Rust tests, use the selected clone in `DATABASE_URL`.

```sh
DATABASE_URL=postgres://aeralyth:aeralyth@127.0.0.1:55432/aeralyth_audit_example \
  cargo test --locked --manifest-path backend/Cargo.toml TEST_NAME \
  -- --ignored --test-threads=1
```

The username and password in this document are throwaway local test credentials.
They have no production use. Existing scripts that hardcode
`docker compose exec -T postgres` target the normal development service.
Inspect their database selection before using them; they do not automatically
use this isolated container or port.

## S3 and API settings

MinIO readiness and bucket creation passed. Its bundled `mc` client has the
`audit` alias configured for the empty local bucket.

```sh
docker exec aeralyth-audit-s3-20260912 mc ready audit
docker exec aeralyth-audit-s3-20260912 mc ls audit/aeralyth-audit
curl --fail http://127.0.0.1:59000/minio/health/ready
```

Use these settings when starting a freshly built API for the mixed workload
tests. Port 58080 was free during setup. Verify it is still free before launch.

```sh
export DATABASE_URL=postgres://aeralyth:aeralyth@127.0.0.1:55432/aeralyth_audit_mixed
export AERALYTH_API_HOST=127.0.0.1
export AERALYTH_API_PORT=58080
export AERALYTH_STORAGE_BACKEND=s3
export AWS_ENDPOINT_URL=http://127.0.0.1:59000
export AWS_ACCESS_KEY_ID=aeralyth-audit-access
export AWS_SECRET_ACCESS_KEY=aeralyth-audit-secret-key-20260912
export AWS_S3_BUCKET_NAME=aeralyth-audit
export AWS_DEFAULT_REGION=us-east-1
export AWS_S3_URL_STYLE=path
export AERALYTH_SHARE_LINK_SECRET=aeralyth-audit-local-share-secret-20260912
export AERALYTH_PERF_POSTGRES_CONTAINER=aeralyth-audit-20260912
```

The API reads `.env` as well as environment variables. Set every
workload-specific value explicitly, including `AERALYTH_E2EE_MODE`, and use
the same settings for the fixture runner. MinIO and the SQL service are ready;
setup alone does not prove API behavior or performance. No API binary was
started during environment preparation because the combined remediation still
needed a fresh build.

## Runtime and resource checks

The host had 24 GiB RAM and about 764 GiB free disk space during setup. Docker
reported 8,318,844,928 bytes of memory and 15 CPUs. The host reported no swap-ins
or swap-outs in its current memory statistics.

The installed tools were Node 26.8.2, npm 11.19.1, Rust 1.97.1, Cargo 1.97.1,
Docker client 29.8.0, and Docker Engine 29.7.2. `npm ls --depth=0` completed
without missing or invalid dependencies. `node_modules` occupied about 844 MiB
and the existing Rust target directory about 45 GiB. These checks confirm the
local tools and dependencies are present; the final build and test runs supply
the remediation acceptance evidence.

When all agents finish using the fixtures, remove only these audit services.

```sh
docker stop aeralyth-audit-s3-20260912 aeralyth-audit-20260912
```

Leave Docker Desktop and the existing development services as they are unless
their owner requests another change.
