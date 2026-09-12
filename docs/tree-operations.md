# Tree operation behavior

Trash, restore, permanent deletion, and editor-link removal use the same tree operation service. It probes at most 257 nodes. Operations that fit the 256-node synchronous limit run in one transaction with a three-second deadline. A delete that needs more than the bounded dependency preparation budget becomes a durable job too.

A larger operation returns HTTP 202 with a job ID. Publishing that job hides the affected subtree atomically. Requests for a descendant, including an independently shared descendant, cannot authorize access through `visible_files` until the job completes. The subtree remains unavailable after a worker crash. The owner client polls `/api/files/operations/{id}` and reports completion only after the persisted job is complete. Shared-link controls refresh after acceptance, when the entry is already hidden by the logical fence. Cancelling the client request stops polling and leaves the accepted server job running. Native form submissions redirect to the files page.

The worker divides one 256-row discovery budget across its bounded parent frontier. Each parent receives a positive quota, and the quotas sum to 256; sparse and empty folders share the same page budget. This avoids scanning 256 children for every parent when only 256 total children can be processed. Persistent parent cursors survive a process or database connection failure. Physical mutations use at most 256 nodes per transaction. Permanent deletion processes the deepest nodes first and drains uploads, generation history, cryptographic records, sharing records, and repository archive dependencies in separate bounded pages. Object deletion jobs preserve outstanding signed-upload deadlines. Completed node cursor rows are removed as each physical page commits.

Physical worker batches use a two-second statement timeout and a three-second deadline. The outer four-second deadline also covers completion delivery and job checkout. Errors roll back its cursor and physical changes together, then retry with persisted backoff. Workers use the maintenance database pool, release connections between batches, and select jobs with `FOR UPDATE SKIP LOCKED`. Every page advances its scheduling timestamp so another queued owner can make progress during discovery as well as physical mutation. An owner has at most one pending tree job; unrelated file writes and browsing continue through the shared side of the owner publication lock.

Read queries in API routes must select `visible_files`. Mutation targets, maintenance accounting, and the tree worker use the physical `files` table. The database rejects competing writes to the affected tree, including changes through uploads, sharing, cryptographic metadata, and both the old and new parent of a move. A persistent owner version closes the race with a writer whose repeatable-read snapshot predates publication. Active child publication also checks a current active parent under a shared lifecycle lock; a finished trash operation cannot admit a late upload into its trashed folder. Exclusive parent lifecycle conflicts fail immediately with a retryable serialization error. Ancestor checks fail closed when the existing hierarchy depth bound is exceeded.

API summaries use `visible_user_file_counters`. Worker counter deltas are captured for each affected account. The view subtracts pending deltas, retaining the pre-operation contribution while still incorporating sibling changes. Completion removes the read fence and this compensation atomically. The physical storage ledger remains authoritative for quotas, so permanent deletion can release storage capacity as physical metadata is removed. Durable completion invalidations include recipients whose sharing rows were deleted before the final commit. Status records remain available for seven days; cursor rows and delivered counter deltas do not accumulate with completed operations.

Deployment requires the full current migration chain before the updated API starts. Railway's checked-in `preDeployCommand` runs `scripts/migrate-production.sh`; a direct launch through `scripts/start-production.sh` does not apply migrations. Migration 029 adds read views and write guards but does not hide physical `files` rows from older binaries, so this upgrade requires a coordinated API replacement: drain and stop older API instances, including in-flight requests and their maintenance workers, before starting the updated API and worker. The new worker starts and can resume jobs before Caddy accepts public traffic, so delaying the public traffic switch alone is insufficient. Keep the configured `overlapSeconds: 0`; its separate 30-second draining setting does not itself prove every old request has finished. Once jobs are admitted, retain this release or newer fence-aware API versions as the rollback floor; do not serve an older binary while any jobs are pending or running. These requirements apply to every replica sharing the database.

Use an isolated database with all migrations applied for verification:

```sh
PSQL=psql python3 database/tests/tree_operation_fence_concurrency.py
PSQL=psql python3 database/tests/tree_operation_parent_concurrency.py
PSQL=psql python3 database/tests/tree_operation_upload_bookkeeping.py
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/tests/tree_operation_parent_publication.sql
cargo test --manifest-path backend/Cargo.toml durable_tree_jobs_yield_between_owner_discovery_pages -- --ignored --nocapture
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/tests/tree_operation_fences.sql
AERALYTH_TREE_SCALE=65536 AERALYTH_TREE_BRANCHES=256 cargo test --manifest-path backend/Cargo.toml durable_tree_jobs_preserve_visibility -- --ignored --nocapture
AERALYTH_TREE_SCALE=100000 cargo test --manifest-path backend/Cargo.toml durable_tree_jobs_preserve_visibility -- --ignored --nocapture
AERALYTH_TREE_SCALE=1000000 cargo test --manifest-path backend/Cargo.toml durable_tree_jobs_preserve_visibility -- --ignored --nocapture
AERALYTH_TREE_SCALE=10000 AERALYTH_TREE_EMPTY_FOLDERS=1 cargo test --manifest-path backend/Cargo.toml durable_tree_jobs_preserve_visibility -- --ignored --nocapture
AERALYTH_TREE_SCALE=150 AERALYTH_TREE_DEEP_CHAIN=1 cargo test --manifest-path backend/Cargo.toml durable_tree_jobs_preserve_visibility -- --ignored --nocapture
```

The worker test terminates a database backend with uncommitted cursor work, resumes the job, checks hidden descendant reads and stable counters, exercises sibling writes, and measures concurrent navigation for the same owner and another owner. It reports batch durations, process RSS, WAL growth, and dead tuple estimates. WAL is a PostgreSQL-instance measure, so run timing comparisons without unrelated database workloads.

Local 10k, 100k, and million-node results and their measurement limits are recorded in [the acceptance results](../performance/results/tree-operations-2026-09-12/README.md).
