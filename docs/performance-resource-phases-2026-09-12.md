# Database phases and admission validation — September 12, 2026

The refreshed audit's PERF-001, PERF-002, PERF-003, PERF-008, and PERF-024 changes are verified below. These measurements use the isolated local audit PostgreSQL instance, not production traffic.

## Resource lifetimes

Migration claims release their owned client after commit and before obtaining the summary. Both the candidate and empty-result paths now work with a one-connection request pool. Synchronized claims also complete when every connection starts occupied by authentication. Staging the locked file precedes updating its migration row so repository revision and migration progress locks have the same order as file publication.

Control JSON and binary metadata readers end the implicit request database phase before reading bytes. Control bodies have a five-second idle deadline, a sixty-second total deadline, and their existing route byte limits. This does not change large file streaming deadlines. JSON decoding revalidates the live session after receipt; account CPU and publication workflows revalidate after later waits. A changed session or role invalidates earlier authorization decisions. Upload lease renewal requires an unexpired pending upload, including single-upload checksum reservation.

Storage, CPU, and traversal admission release the implicit request connection before waiting. Owned transaction clients still have explicit lexical/drop boundaries. Publication and share/epoch operations hold traversal permits only during their database phases, retaining snapshot comparisons and transactional authorization checks between those phases.

## Admission budgets

`AERALYTH_RECURSIVE_OPERATION_CONCURRENCY` is an aggregate traversal budget. Its default of two now reserves one interactive worker and one bulk worker, with separately bounded admission and per-user fairness. The classes do not double total traversal concurrency. A deliberately configured one-worker traversal budget necessarily shares that worker.

The existing CPU worker budget is also partitioned: metadata/download decoding uses `interactive_validation`; publication/account validation uses `vault_validation`. When the calculated CPU budget is one worker, separate bounded queues share one weighted-priority worker. A waiting metadata operation can pass queued bulk operations after the current operation finishes; after at most four interactive operations, a waiting bulk operation gets a turn. Active blocking work is not cancelled or preempted. Cancellation removes queued waiters without consuming future capacity.

Admission wait histograms expose the classes `interactive`, `bulk`, `interactive_cpu`, and `publication_cpu`. End-to-end mixed workload latency must be assessed separately from these focused scheduling checks.

## Focused execution evidence

All tests below ran against the application code. The migration database had migrations 001–030 when the final claim regression ran. The independent reviewer reran all four PostgreSQL resource tests and both single-CPU scheduling tests successfully.

| Test | What it checks |
| --- | --- |
| `migration_claims_return_connections_with_one_slot_and_synchronized_claims` | Candidate/empty claims, pool sizes one and two, synchronized occupied pools, persisted ownership, pool returned after response |
| `slow_control_body_releases_pool_and_honors_session_revocation` | Actual `parse_json_body` hook, concurrent query with one connection, revocation while body is pending returns 401 |
| `storage_admission_wait_releases_the_request_pool` | An occupied provider worker plus an authenticated queued operation leaves the request connection available |
| `single_presign_does_not_revive_a_lease_expired_during_body_read` | Expiry during delayed body receipt yields conflict and leaves checksum/expiry unchanged |
| `control_body_enforces_idle_and_total_deadlines` | Idle stream and continuously trickling stream both time out at the relevant deadline |
| `interactive_and_bulk_reservations_make_independent_progress` | Same-user bulk work cannot take the interactive reservation; browsing cannot take the bulk reservation |
| `metadata_cpu_capacity_is_reserved_during_publication_validation` | A publication CPU worker does not take the separate metadata CPU reservation |
| `single_cpu_prioritizes_metadata_without_adding_a_worker` | One aggregate CPU operation at a time; queued metadata runs before queued bulk work |
| `single_cpu_cancelled_waiter_does_not_block_other_class` | Cancelled priority waiters release admission correctly |

The database-specific tests are explicitly ignored in ordinary unit runs. Run them against an initialized disposable database with `DATABASE_URL` set:

```sh
cargo test --manifest-path backend/Cargo.toml migration_claims_return_connections -- --ignored --nocapture
cargo test --manifest-path backend/Cargo.toml slow_control_body_releases_pool -- --ignored --nocapture
cargo test --manifest-path backend/Cargo.toml storage_admission_wait_releases -- --ignored --nocapture
cargo test --manifest-path backend/Cargo.toml single_presign_does_not_revive -- --ignored --nocapture
cargo test --manifest-path backend/Cargo.toml single_cpu_ -- --nocapture
```

Migration progress uses transactionally maintained counters and an O(1) account lookup. Its dedicated SQL regressions exercised retries, rollback, staged/incomplete overlap, cleanup, bulk writes, ownership changes, cascades, backfill, replay, and explicit reconciliation. Actual query-plan source rows were 1,000 for 1,000 tiny-node transitions and 2,000 for 2,000 transitions. See `database/tests/migration_progress.sql` and `database/tests/fresh_migration_progress.sh`. Reconciliation is a separate maintenance action, never a request or timer recount.

## Connection recycling decision

**Keep Verified recycling.** The experiment measured a small healthy-connection improvement from Fast, but fault injection introduced failed application reads. Both policies kept connection lifetime/jitter hooks and the same one-connection pool settings. The harness retries only its known-safe `SELECT 1` recovery probe; the application does not automatically replay mutations or ambiguous commits.

The local `cargo test` development-profile run discarded twenty warm-up samples and measured five hundred subsequent samples per policy:

| Measurement | Verified | Fast |
| --- | ---: | ---: |
| Warm checkout p95 | 572 µs | 16 µs |
| Warm checkout p99 | 630 µs | 22 µs |
| Checkout plus cached `SELECT 1` p95 | 1,114 µs | 534 µs |
| Checkout plus cached `SELECT 1` p99 | 1,218 µs | 598 µs |
| Idle connections terminated | 25 | 25 |
| Failed safe reads before recovery | 0 | 37 |
| Terminated-connection recovery maximum | 32.810 ms | 33.649 ms |
| Interrupted uncommitted write rows | 0 | 0 |

A separate TCP proxy fault test forwarded COMMIT to PostgreSQL while discarding its acknowledgement. An independent connection confirmed the write committed before the proxy cut the connection. Both policies reported the ambiguous commit as an error, preserved exactly one durable row, exposed the network partition, and recovered a safe read after connectivity returned. Observed restored-read times were 32.652 ms and 33.375 ms respectively.

```sh
cargo test --manifest-path backend/Cargo.toml recycling_ -- --ignored --nocapture --test-threads=1
```

These are local measurements from development-profile test binaries; they are not production RTT or release-capacity numbers. The observed Fast-policy reliability cost rejects changing the production default on this evidence. A future policy change requires repeating healthy/fault p95/p99 and ambiguity checks on the actual deployment network.
