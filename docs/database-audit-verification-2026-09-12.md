# Database audit verification, September 12, 2026

The complete database suite uses a separate Compose project named
`aeralyth-audit-db-suite`. Its PostgreSQL container is
`aeralyth-audit-db-suite-20260912`, published only on `127.0.0.1:55434`, with a
1 GiB memory limit and no restart policy. The existing development container on
port 5432 and its database remain unchanged.

The reproducible configuration is `database/tests/audit-compose.yml`. PostgreSQL
initializes before migration files are copied into its conventional test path;
this allows both historical fresh-migration tests and the complete current chain
to run against appropriate isolated fixtures.

```sh
export COMPOSE_PROJECT_NAME=aeralyth-audit-db-suite
export COMPOSE_FILE=database/tests/audit-compose.yml
export AERALYTH_TEST_CONTAINER=aeralyth-audit-db-suite-20260912
export AERALYTH_TEST_DATABASE_PORT=55434
export PG_CONTAINER=aeralyth-audit-db-suite-20260912
docker compose up -d --wait
python3 database/tests/run_audit_suite.py
bash database/tests/audit_migration_chain.sh
```

`run_audit_suite.py` checks that Compose resolves to the named audit container
before running any test. It records each package entry's exit code, duration and
log in `performance/results/database-audit-2026-09-12/suite-results.json`.
`migration-source-sha256.json` identifies the migration snapshot used for the
run. No production database or provider credentials are used.

Three historical fresh-migration scripts also invoke current Rust query-contract
tests. They now accept an optional `AERALYTH_TEST_DATABASE_PORT` rather than
forcing those connections to the development port. Historical plan, WAL and
replay assertions run against their original schema. The full current migration
chain is then applied before preparing the current backend SQL, so those tests
exercise the actual query dependencies without changing the historical
measurements.

The coherent chain contains 35 SQL files and 31 ledger-backed versions. Existing
migrations 003, 004, 005 and 007 contain idempotent DDL and have never inserted
ledger records. The chain regression checks their schema preservation as part
of full replay, together with the ledger-backed files. It requires no application
row writes and no repeated full hierarchy validation during replay.

The 25 existing package database entries all passed after targeted retries. The
new maintenance notification, upload expiry claim and migration-progress bulk
checks also passed, giving evidence for all 28 current package entries. The count
is derived from `package.json`; equivalent direct SQL executions are identified
in the result JSON.
The result history retains the initial failures and each correction's retry. An
entry that passed earlier was not rerun solely to replace its timestamp; source
snapshots and logs distinguish those runs from the final chain validation.

The complete final chain passed again in a fresh generated database after the
last migration 029 upload guard correction. The final capture is in `chain.log`.
Replay preserved the normalized schema, every application row and every sequence
state, with zero application DML and no hierarchy revalidation. Separate tests
observed two migration sessions waiting concurrently on the advisory lock for
032 and for 035 before releasing each gate. All 35 source hashes remained stable.

Five extra checks also passed on a fresh final-schema database: depth-120 tree
visibility and fencing, bounded dependency draining, concurrent tree fences under
Read Committed and Repeatable Read, multipart initializer/reconciliation
coordination, and the final completion lease exception with protected-field
rejection cases. Their final source hashes and logs are in
`performance/results/database-audit-2026-09-12/extras-results.json`. Earlier
results remain in the `extras-before-final-*` files.

The canonical 100,001-node tree fixture exposed two problems during validation.
Its Rust test initially duplicated the shell's 100,000 seeded children, which
was fixed by seeding only when the root is absent. The next run exposed a real
30-second restore timeout in migration 034's joins over unindexed transition
tables. Narrow set differences and grouped parent-edge deltas replace those
joins. The final run kept the same limits and assertions: the walk took 544.81 ms,
trash and restore used 42 statements, the slowest statement took 1.555 seconds,
and the delete batch took 659.21 ms. The Rust scale test completed in 48.29 seconds.
Six query-contract tests and four optimized SQL execution tests also passed.

A separate final-schema retention run passed after its legacy mixed-state
fixtures were adapted to the new parent publication guard. Parents and active
children are inserted while the parent is active; the parent is then trashed.
This preserves the original cleanup and concurrency assertions without disabling
triggers. The storage agent independently reviewed the 034 repair and ran this
retention suite, with no remaining findings.

Release workload measurements separately exposed empty maintenance statements
notifying their own workers. Migration 036 now checks statement transition rows
and scheduling fields before emitting notifications. Its independent reviewer
checked all 16 installed triggers and measured a 10,000-row `HashSetOp Except`
comparison at 3.53 ms. The actual LISTEN test reproduced the old bug and passed
87 checks after the fix, including commit/rollback behavior, no-op and unrelated
updates, notification coalescing, and 64 empty claims with zero self-wakeups.
The migration and test received separate reviews. Post-fix release workload
measurements are recorded with the root release results.

The runner and historical fixture changes also received independent review.
Review found and resolved inherited `PG_CONTAINER` and port escape paths, and a
retry path that could retain a stale unpublished migration behind its ledger.
The runner now derives the container and loopback port from Docker, rebuilds its
disposable base before retry, and records source hashes. The final clean backend
database is `aeralyth_audit_final_backend_v4` in this audit container. Its 35-file
initialization log and hashes are saved as `backend-final-v4-init.log` and
`backend-final-v4-init.json`. At initialization it contained migration seed data
only, one seed user and 31 migration records, and no external tree fixture. It is
separate from every scale fixture. The earlier v3 database and its historical
`backend-final-v3-init.log` and `backend-final-v3-init.json` evidence were
preserved. All 35 migration hashes in v4 match the v3 initialization hashes.

A later independent upload review found three queue/finalization defects and
verified their repairs. Completion and both expiry queues now read at most four
indexed pages of 25 raw candidates per maintenance turn before checking tree
ancestry. They acquire bounded owner locks without waiting and recheck tree
visibility in a fresh database command. Their worker-owned cursors use a fixed
sweep cutoff, so continuous new arrivals cannot starve older work. The cursors
reset after a complete sweep and when a worker restarts; upload state and leases
remain durable in PostgreSQL.

An unavailable upload parent now causes one atomic reservation release and
cleanup queue insertion, preserving signed PUT deadlines. Temporary owner or
parent contention releases only the matching completion lease, schedules a
one-second retry without charging an attempt, and returns HTTP 202. Migration
029 permits only those four bookkeeping fields to change while the upload stays
completing; status, object, identity, quota and deadline changes remain fenced.

The independent reviewer passed all nine upload completion Rust tests in 0.39
seconds, including a single-connection pool, an independent blocking connection,
stale leases, cleanup idempotence, 125 fenced and row-locked prefixes, same-owner
siblings and continuous arrivals. It separately passed all 16 actual PostgreSQL
expiry scenarios against the final worker SQL, including both expiry queues and
continuous arrival fairness. Logs are `upload-completion-independent-final.log`
and `expired-upload-claim-fences-independent-final.log`. Earlier author runs are
retained. All remaining reviewer findings were resolved before this handoff.

The migration-progress bulk check used the author's equivalent isolated
full-chain setup and exact SQL, with independent review. Its wrapper passed
shell syntax checks and was not rerun solely to duplicate the long SQL capture.
With 5,000-node and 100,001-node accounts, all 44 trash/restore statements, 22
pending-to-failed statements and 22 completion statements stayed below the
unchanged 10-second timeout. The measured counter writes were 0, 0 and 22 for
those phases. Full results, source hashes, commands and timing limits are in
`performance/results/migration-progress-2026-09-12/bulk-results.json`.

The following table selects each package entry's latest successful evidence.


| Package entry | Result | Evidence |
|---|---|---|
| `db:test:performance-ledger` | Pass | [db-test-performance-ledger.log](../performance/results/database-audit-2026-09-12/db-test-performance-ledger.log) |
| `db:test:performance-ledger-concurrency` | Pass | [db-test-performance-ledger-concurrency.log](../performance/results/database-audit-2026-09-12/db-test-performance-ledger-concurrency.log) |
| `db:test:performance-ledger-fresh` | Pass | [db-test-performance-ledger-fresh.log](../performance/results/database-audit-2026-09-12/db-test-performance-ledger-fresh.log) |
| `db:test:migration-replay` | Pass | [db-test-migration-replay.log](../performance/results/database-audit-2026-09-12/db-test-migration-replay.log) |
| `db:test:folder-manifest` | Pass | [db-test-folder-manifest.log](../performance/results/database-audit-2026-09-12/db-test-folder-manifest.log) |
| `db:test:folder-manifest-fresh` | Pass | [db-test-folder-manifest-fresh.log](../performance/results/database-audit-2026-09-12/db-test-folder-manifest-fresh.log) |
| `db:test:upload-completion-fresh` | Pass | [db-test-upload-completion-fresh.log](../performance/results/database-audit-2026-09-12/db-test-upload-completion-fresh.log) |
| `db:test:session-counter-performance-fresh` | Pass | [db-test-session-counter-performance-fresh.log](../performance/results/database-audit-2026-09-12/db-test-session-counter-performance-fresh.log) |
| `db:test:vault-query-performance-fresh` | Pass | [db-test-vault-query-performance-fresh.log](../performance/results/database-audit-2026-09-12/db-test-vault-query-performance-fresh.log) |
| `db:test:migration-identity-performance-fresh` | Pass | [db-test-migration-identity-performance-fresh.log](../performance/results/database-audit-2026-09-12/db-test-migration-identity-performance-fresh.log) |
| `db:test:navigation-hot-paths-fresh` | Pass | [db-test-navigation-hot-paths-fresh.log](../performance/results/database-audit-2026-09-12/db-test-navigation-hot-paths-fresh.log) |
| `db:test:collection-hierarchy-performance-fresh` | Pass | [db-test-collection-hierarchy-performance-fresh.log](../performance/results/database-audit-2026-09-12/db-test-collection-hierarchy-performance-fresh.log) |
| `db:test:admin-search-identifier-performance-fresh` | Pass | [db-test-admin-search-identifier-performance-fresh.log](../performance/results/database-audit-2026-09-12/db-test-admin-search-identifier-performance-fresh.log) |
| `db:test:bounded-tree-operations-fresh` | Pass | [db-test-bounded-tree-operations-fresh.retry-2.log](../performance/results/database-audit-2026-09-12/db-test-bounded-tree-operations-fresh.retry-2.log) |
| `db:test:production-preflight-fresh` | Pass | [db-test-production-preflight-fresh.log](../performance/results/database-audit-2026-09-12/db-test-production-preflight-fresh.log) |
| `db:test:realtime` | Pass | [db-test-realtime.log](../performance/results/database-audit-2026-09-12/db-test-realtime.log) |
| `db:test:flexible-settings` | Pass | [db-test-flexible-settings.log](../performance/results/database-audit-2026-09-12/db-test-flexible-settings.log) |
| `db:test:migration-progress` | Pass | [db-test-migration-progress.log](../performance/results/database-audit-2026-09-12/db-test-migration-progress.log) |
| `db:test:migration-progress-fresh` | Pass | [db-test-migration-progress-fresh.log](../performance/results/database-audit-2026-09-12/db-test-migration-progress-fresh.log) |
| `db:test:repository-change-tracking` | Pass | [db-test-repository-change-tracking.log](../performance/results/database-audit-2026-09-12/db-test-repository-change-tracking.log) |
| `db:test:tree-operation-fences` | Pass | [db-test-tree-operation-fences.log](../performance/results/database-audit-2026-09-12/db-test-tree-operation-fences.log) |
| `db:test:realtime-background-audiences` | Pass | [db-test-realtime-background-audiences.log](../performance/results/database-audit-2026-09-12/db-test-realtime-background-audiences.log) |
| `db:test:realtime-pruning` | Pass | [db-test-realtime-pruning.log](../performance/results/database-audit-2026-09-12/db-test-realtime-pruning.log) |
| `db:test:indexed-trash-expiry` | Pass | [indexed-trash-expiry-final-independent.log](../performance/results/database-audit-2026-09-12/indexed-trash-expiry-final-independent.log) |
| `db:test:multipart-reconciliation` | Pass | [db-test-multipart-reconciliation.log](../performance/results/database-audit-2026-09-12/db-test-multipart-reconciliation.log) |
| `db:test:maintenance-notifications` | Pass | [maintenance-notifications.log](../performance/results/database-audit-2026-09-12/maintenance-notifications.log) |
| `db:test:expired-upload-claim-fences` | Pass | [expired-upload-claim-fences-independent-final.log](../performance/results/database-audit-2026-09-12/expired-upload-claim-fences-independent-final.log) |
| `db:test:migration-progress-bulk-fresh` | Pass | [bulk-regression.log](../performance/results/migration-progress-2026-09-12/bulk-regression.log) |

Python parsing, shell syntax, scoped Rust formatting, package Biome, and `git diff --check` passed. No production or development data was changed, and no commits were made.
