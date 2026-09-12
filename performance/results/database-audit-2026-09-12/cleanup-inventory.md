# Audit cleanup inventory

Read-only inventory prepared for the final checks. Nothing has been stopped or
removed. Root must authorize cleanup after observability and browser acceptance
finish. This is a point-in-time inventory; confirm current process identities,
container IDs and volume/network attachments immediately before cleanup.

The machine-readable records are [Docker inventory](cleanup-docker-inventory.json)
and [server inventory](cleanup-server-inventory.json). They include full IDs,
commands, timestamps, ownership evidence, mounts and ports without environment
secrets.

## Audit Docker resources

| Container | ID prefix | Published port | Ownership |
|---|---|---|---|
| `aeralyth-audit-db-suite-20260912` | `153d72b51279` | `127.0.0.1:55434` | Audit Compose project and dedicated temporary configuration |
| `aeralyth-audit-20260912` | `832beb83fb65` | `127.0.0.1:55432` | `aeralyth.task=performance-audit-20260912` label |
| `aeralyth-audit-s3-20260912` | `62a74a0cbd91` | `127.0.0.1:59000` | Same audit task label |

The two audit-only networks have no non-audit members at capture:

- `aeralyth-audit-db-suite_default`
- `aeralyth-audit-integration-20260912`

These anonymous volumes are attached exclusively to the listed audit containers:

| Container | Exact volume name | Mount |
|---|---|---|
| Audit suite PostgreSQL | `4463f12963892db7ee061df18d0f0273a475a8d9cd6cbf07b77a6f9a51ed0898` | `/var/lib/postgresql` |
| Initial audit PostgreSQL | `e6e80fad3f207d95821b161c774ec3fcb5bef1c0f3882d4c5fbdc22514f3eb7f` | `/var/lib/postgresql` |
| Audit MinIO | `b128e34ef8eb435f79db6ee917120f4e3b63349b7f36a017da243792bf9b705d` | `/data` |

Removing those volumes would remove all disposable audit databases and provider
objects, including the retained final backend fixtures. Keep them until every
final check is complete and root explicitly authorizes their removal. The
repository's `database/init` mount is source data and must remain.

## Task server processes

| Server | Process IDs | Listener | Current purpose |
|---|---|---|---|
| Initial download profile | Node `36612`, child esbuild `36618` | `127.0.0.1:56261` | Author confirmed this is the obsolete hung initial attempt; no benchmark needs it |
| Production Next acceptance | npm launcher `45847`, Next child `45861` | `127.0.0.1:53001` | Required for final browser acceptance |
| Browser acceptance proxy | Node `45872` | `127.0.0.1:53000` | Required for final browser acceptance |

Root confirmed ownership of both browser acceptance servers. Their owning exec
sessions are `31685` for Next and `91794` for the proxy. The proxy script is
`/tmp/aeralyth-browser-acceptance-ak492snw/proxy.mjs`. The download harness is
`performance/download-stage-profile.mjs`; preserve that source and its results.
Its former browser daemon PID `36641` and old browser session PID files are already
absent according to the profiling author.

The final native release API started after the initial capture. Its verified
PID is `50750`, command `backend/target/release/aeralyth-api`, listening on
`127.0.0.1:58083`. Observability owns exec session `45289` and requires it for the
remaining mixed, metadata and browser checks. Its startup script is
`/private/tmp/start-aeralyth-final-native.sh release`. Keep it running.

Observability confirmed the earlier API on `58081` was stopped. These planned
final-check servers have not started at the latest capture:

- `58084`, native debug comparison API
- `58085`, external observability probe API

The earlier worker/Caddy test origin `18090` was also absent. These future or
restarted processes must be inventoried again; a port alone is not enough to
select a process for termination.

## Protected resources

- Original development container `aeralyth-postgres`, ID
  `9bf5ebb64fbc5c5ac706ee14850e30389ad55f7c75dfb4c82e34778c18e3dfaa`, on port `5432`.
- Its original named volume `aeralyth_aeralyth-postgres-data` and network
  `aeralyth_default`.
- Shared Docker Desktop PID `7586`, shared Codex parent PID `1737`, system
  listeners, unrelated containers, and user browser sessions.
- Source files, repository bind mounts, `node_modules`, saved evidence, cargo
  targets/caches and Docker build caches.
- Shared/vendor images. The task-built `aeralyth-audit-20260912:current` image is
  recorded for provenance; image removal is outside this requested inventory.

Do not use broad process-name termination, Docker pruning, or the original
project's Compose teardown. After authorization, use only the refreshed exact
audit identities. Observability owns the final resource hold until its checks
finish; frontend_transfers owns the browser acceptance hold.
