# Aeralyth performance and latency audit

**Repository:** `AdminGodZ/Aeralyth`  
**Snapshot:** `master` at `fe9556cf9f011297e16500f18cdf04b991b35635`  
**Commit:** “Add admin storage overview with bucket usage metrics” — September 11, 2026, 20:18:02 UTC  
**Audit date:** September 12, 2026  
**Method:** Read-only source inspection through the connected GitHub repository, with primary documentation checked for relevant runtime behavior.  
**Deliverable:** 44 prioritized findings and optimization opportunities; no application code or repository files were changed.

## Executive conclusion

The largest remaining opportunities are not a language/framework rewrite or indiscriminately increasing concurrency. They are **shortening scarce-resource lifetimes, isolating interactive reads from bulk work, bounding work before materialization, reducing repeated hierarchy/realtime work, and replacing transfer batch barriers with bounded rolling pipelines**.

The five P1 findings concern a nested database checkout, cached DB connections retained during non-DB waits, shared interactive/bulk admission, late metadata limits, and synchronous very large tree mutations. They should be addressed before micro-optimizations. Browser-visible speed also depends on encrypted metadata resolution and content transfer, not only API handler latency.

| Priority | Count | Meaning in this report |
|---|---:|---|
| P0 | 0 | No P0 established by the reviewed evidence. This is not a certification that none exists. |
| P1 | 5 | High-priority availability/tail-latency or resource-exhaustion risks on supported paths; reproduce and repair first. |
| P2 | 32 | Material repeated work, scaling/transfer/recovery bottlenecks, deployment costs, or validation gaps. |
| P3 | 7 | Smaller or explicitly measurement-gated optimizations; do not trade correctness for an unproven speedup. |

**Important limits:** This is a static audit, not a measured production incident report or a claim that every possible P0–P3 issue has been discovered. No production database, traffic traces, provider timings, browser profiles, EXPLAIN plans, builds, or repository tests were executed for this audit. Production configuration may override the defaults. Some large files were inspected in targeted ranges rather than line by line. The coverage section identifies these boundaries. Every numerical scaling example below is derived from code/constants and stated assumptions, not an observed benchmark.

**How to use the findings:** Each entry gives a commit-pinned source location, visible evidence, the latency mechanism, a recommended design, and an acceptance test. Source links intentionally use stable files plus searchable function/query names; connector response-wrapper line numbers are not source-code line numbers. “Best fix” means the recommended starting design under the existing architecture, not a benchmark-proven universal optimum. Related entries describe distinct layers of the same amplification chain; their expected gains must not be added together.

## Navigation

- [Finding index](#finding-index)
- [Backend and database findings](#backend-and-database-findings)
- [Frontend and transfer findings](#frontend-and-transfer-findings)
- [Deployment and build findings](#deployment-and-build-findings)
- [Observability and validation findings](#observability-and-validation-findings)
- [Implementation order and architecture](#implementation-order-and-architecture)
- [Validation matrix](#validation-matrix)
- [Existing optimizations not reported as missing](#existing-optimizations-not-reported-as-missing)
- [Coverage and remaining verification](#coverage-and-remaining-verification)

## Finding index

| ID | Priority | Area | Finding |
|---|---|---|---|
| [PERF-001](#perf-001) | P1 | Backend / database | Migration claims retain a connection while requesting a second one |
| [PERF-002](#perf-002) | P1 | Backend / resource lifetime | Authenticated control requests retain scarce database connections during non-database waits |
| [PERF-003](#perf-003) | P1 | Backend / scheduling | Interactive browsing and expensive mutations share one tiny recursive-operation queue |
| [PERF-004](#perf-004) | P1 | Backend / metadata memory | Metadata limits are enforced after expensive SQL expansion and row materialization |
| [PERF-005](#perf-005) | P1 | Backend / bulk mutation | Million-node tree operations remain synchronous, memory-heavy, long transactions |
| [PERF-006](#perf-006) | P2 | Backend / metadata pagination | Metadata continuation pages repeat work for plans that were already returned |
| [PERF-007](#perf-007) | P2 | Backend / serialization | Metadata response sizing serializes plans that are serialized again for delivery |
| [PERF-008](#perf-008) | P2 | Backend / migration | Per-node migration progress recounts the remaining account-wide work |
| [PERF-009](#perf-009) | P2 | Backend / CPU scheduling | Large account JSON decoding and validation still run on an Actix worker |
| [PERF-010](#perf-010) | P2 | Backend / realtime write amplification | Foreground realtime triggers perform recursive audience expansion and per-recipient work |
| [PERF-011](#perf-011) | P2 | Backend / hierarchy writes | Every leaf update can rewrite and contend on common ancestor rows |
| [PERF-012](#perf-012) | P2 | Backend / repository navigation | Unrelated owner changes invalidate every repository, then browsing recounts a whole tree |
| [PERF-013](#perf-013) | P2 | Backend / archive pagination | Each repository archive page rebuilds and aggregates the complete tree |
| [PERF-014](#perf-014) | P2 | Backend / realtime idle load | Every idle SSE connection performs a database replay query every five seconds |
| [PERF-015](#perf-015) | P2 | Backend / realtime retention | Realtime pruning has a fixed service-rate ceiling that can fall behind writes |
| [PERF-016](#perf-016) | P2 | Backend / storage overview | Admin bucket usage repeatedly performs a full, replica-local bucket scan |
| [PERF-017](#perf-017) | P2 | Backend / maintenance queries | Trash expiry and next-due calculation repeatedly evaluate cross-table deadlines |
| [PERF-018](#perf-018) | P2 | Backend / maintenance database capacity | Multipart reconciliation pins a maintenance connection across an entire provider sweep |
| [PERF-019](#perf-019) | P2 | Backend / aggregate storage admission | Maintenance concurrency limits are per worker, with nested provider fanout |
| [PERF-020](#perf-020) | P2 | Backend / reconciliation round trips | Multipart orphan reconciliation still performs serial per-candidate database rechecks |
| [PERF-021](#perf-021) | P2 | Backend / presign batching | The supported presign batch can overrun its own per-user storage admission budget |
| [PERF-022](#perf-022) | P2 | Backend / local downloads | The reviewed local-file download route always streams the complete object |
| [PERF-023](#perf-023) | P3 | Backend / conditional responses | ETags are checked only after database work and full JSON serialization |
| [PERF-024](#perf-024) | P3 | Backend / connection recycling | Verified connection recycling adds a validation query to warm checkouts |
| [PERF-025](#perf-025) | P2 | Frontend / realtime recovery | Deterministic reconnects plus fixed polling amplify a shared outage |
| [PERF-026](#perf-026) | P2 | Frontend / invalidation | Unrelated file changes trigger full current-route refreshes |
| [PERF-027](#perf-027) | P2 | Frontend / startup and resume | Mount, resume, and unlock can force full resets even when replay can prove freshness |
| [PERF-028](#perf-028) | P2 | Frontend / worker failure latency | A fatal crypto-worker error can leave later requests waiting indefinitely |
| [PERF-029](#perf-029) | P2 | Frontend / upload throughput | Multipart encryption waits for four prepared parts and advances in slowest-part waves |
| [PERF-030](#perf-030) | P2 | Frontend / folder upload preparation | All folder preparation is completed before any selected file upload starts |
| [PERF-031](#perf-031) | P2 | Frontend / download pipeline | Application-level decryption and sink writes are awaited serially per chunk |
| [PERF-032](#perf-032) | P2 | Frontend / interrupted transfers | Encrypted downloads lack bounded range-based resume after a transient failure |
| [PERF-033](#perf-033) | P2 | Frontend / repository preview | A small text preview can download and decrypt an entire much larger file |
| [PERF-034](#perf-034) | P3 | Frontend / preview allocations | Legacy preview buffering makes an explicit extra copy of each network chunk |
| [PERF-035](#perf-035) | P3 | Frontend / file scheduling | Every file larger than 8 MiB reserves the entire selection-level file budget |
| [PERF-036](#perf-036) | P3 | Frontend / session bootstrap | Each dashboard session bootstrap uses separate authenticated user and CSRF reads |
| [PERF-037](#perf-037) | P2 | Deployment / database migration | Migration 015 revalidates the complete hierarchy on ordinary production redeploys |
| [PERF-038](#perf-038) | P2 | Deployment / worker assets | A deployment removes old hashed worker URLs still referenced by open clients |
| [PERF-039](#perf-039) | P3 | Build / browser worker delivery | Production worker bundles are bundled but not explicitly minified |
| [PERF-040](#perf-040) | P2 | Observability / latency measurement | HTTP metrics stop before streamed bodies finish and infer bytes from headers |
| [PERF-041](#perf-041) | P2 | Observability / request-path I/O | Synchronous logging can amplify latency during error or slow-request bursts |
| [PERF-042](#perf-042) | P3 | Observability / metrics contention | Metrics exposition formats output while holding hot shared mutexes |
| [PERF-043](#perf-043) | P2 | Validation / workload model | The generic HTTP gate cannot establish mixed-load production capacity |
| [PERF-044](#perf-044) | P2 | Validation / production equivalence | The live backend latency job runs a debug build rather than the production release binary |

## Backend and database findings

<a id="perf-001"></a>

### PERF-001 — P1 — Migration claims retain a connection while requesting a second one

**Area:** Backend / database  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/routes/vault.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/vault.rs) — claim_migration.
- [backend/src/db.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/db.rs) — Database::get; RequestConnectionSlot::take_owned.

**What the code does.** `claim_migration` obtains an owned pooled client, commits its transaction, and then awaits `migration_summary(&state, &user)` without dropping the client. This happens both when no candidate exists and after a successful claim. `Database::get` removes the connection from the request-local slot, so the summary's ordinary database helper must check out another connection. Committing a transaction does not return its owning client to the pool.

**Why it hurts.** Concurrent migration requests can each hold one connection and wait for another until checkout timeouts fire. A pool-size-one integration test exposes this without significant load; at larger sizes the failure depends on concurrent occupancy. Even below saturation, a claim consumes more pool capacity and incurs another checkout/recycle than necessary. This is bounded timeout/starvation, not a demonstrated permanent deadlock.

**Recommended fix.** End the owned-client scope immediately after commit, before either summary call. Prefer returning the candidate/result from an inner transactional block, then obtaining the summary after that block. Alternatively pass the existing client to a summary helper and perform the post-commit read through it. Audit all owned-client call sites for the same pattern; a request-slot clear does not release a separate owned local client. Preserve the summary's intended post-commit visibility.

**Acceptance test.** Add a real-Postgres test with max pool size 1 and a compatible minimum size, covering both candidate/no-candidate branches. Repeat with all pool connections occupied by synchronized claims. Assert successful completion without nested-checkout waits, correct claim ownership, and no connection remaining checked out after the response.

**Runtime reference:** [Rust Reference — destructors and drop scopes](https://doc.rust-lang.org/reference/destructors.html).

<a id="perf-002"></a>

### PERF-002 — P1 — Authenticated control requests retain scarce database connections during non-database waits

**Area:** Backend / resource lifetime  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/db.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/db.rs) — request-local shared connection lifetime.
- [backend/src/routes/vault.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/vault.rs) — setup; account mutation body parsing; presign_content; presign_part; presign_parts.
- [backend/src/routes/files.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/files.rs) — init_upload.
- [backend/src/state.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/state.rs) — AsyncOperationService::run.
- [deployment/Caddyfile](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/deployment/Caddyfile) — read_body timeout.

**What the code does.** Authentication leaves a shared client in the request-local database slot. Several control routes then read a request body without releasing it; examples include vault setup and the ordinary non-editor upload-init path. Vault presigning routes also read/renew an upload and enter `storage_operations.run` without releasing that cached client. The storage service does not automatically release it. Caddy permits bodies to take up to ten minutes; size limits alone do not enforce a short control-body deadline.

**Why it hurts.** Slow authenticated body senders or a backed-up storage queue can occupy the small request pool while PostgreSQL itself is idle. Unrelated authentication, browsing, and realtime replay then wait or fail. Presigning is generally local signing with the configured credentials; the problem is retaining a DB resource while waiting for shared admission, not an assumed S3 HTTP call for each signature.

**Recommended fix.** Authenticate and perform the minimum access check, release the request connection, then read the bounded body or wait for external/CPU admission. Reacquire and revalidate session, ownership, upload lease, and mutable permissions before committing a change. Introduce route-specific body idle/total deadlines for control JSON/binary bodies, separately from legitimate large file streams. Encode explicit database phases in helper APIs so holding a connection across unrelated waits becomes difficult. Do not fix this by merely increasing pool size or timing out an entire non-cancellation-safe mutation.

**Acceptance test.** Occupy all request slots with authenticated, slowly delivered control bodies and with deliberately saturated storage admission. Concurrent browsing/authentication should still obtain DB connections. Verify revocation during the gap is honored and retries cannot duplicate committed publications.

<a id="perf-003"></a>

### PERF-003 — P1 — Interactive browsing and expensive mutations share one tiny recursive-operation queue

**Area:** Backend / scheduling  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/routes/files.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/files.rs) — index; download; folder_archive_manifest.
- [backend/src/routes/repositories.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/repositories.rs) — detail; archive_manifest.
- [backend/src/routes/vault.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/vault.rs) — metadata_plans; publish_upload.
- [backend/src/state.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/state.rs) — acquire_recursive_operation.
- [README.md](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/README.md) — recursive-operation defaults.

**What the code does.** The same recursive-operation admission class covers folder context/listing, repository detail, encrypted metadata, archive work, and publication. Defaults are two active operations globally and one per user. Publication obtains this permit before its body, validation, provider finalization, and database work have all finished. Ordinary legacy download URL generation also enters this class.

**Why it hurts.** One slow publication can block the same user's folder click or metadata resolution; two long operations can delay other users. Queue bounds protect memory but do not provide latency isolation. A queue timeout can turn a healthy, cheap read into an overload error merely because unrelated expensive work is ahead of it.

**Recommended fix.** Separate bounded interactive reads from bulk mutations/archive preparation. Reserve measured database/CPU capacity for browsing and metadata, with per-user fairness. Scope each permit to the phase it protects: do not hold a traversal permit while accepting a body or waiting on S3. Retain all recursive authorization, depth/cycle bounds, and mutation serialization where correctness requires them. Size the classes against one aggregate resource budget; splitting queues must not double total DB or CPU pressure. Add per-class admission-wait metrics.

**Acceptance test.** Inject a long provider-finalization delay and run archive/tree work while another user and the same user navigate. Compare click-to-visible-name p95/p99 and rejection rates. Confirm interactive requests no longer sit behind the bulk gate and bulk jobs still make progress under sustained browsing.

<a id="perf-004"></a>

### PERF-004 — P1 — Metadata limits are enforced after expensive SQL expansion and row materialization

**Area:** Backend / metadata memory  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/routes/vault.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/vault.rs) — OWNED_METADATA_PLANS_QUERY; metadata_plans.

**What the code does.** Owned metadata traversal expands requested nodes through ancestors, joins metadata payloads, and uses a collecting database query. The handler checks the 512-node cap after the rows are returned. Wrappers/plans are also loaded and constructed before the final response-byte budget is applied. An outer 8 MiB response cap therefore does not bound the work or memory required to produce it.

**Why it hurts.** A request containing many deep, disjoint paths can expand to thousands of intermediate/ancestor records before being rejected. Large manifests amplify database work, wire bytes, heap allocation, base64 expansion, and serialization. The exact peak memory depends on valid record sizes and shared ancestry; this audit did not measure an out-of-memory event.

**Recommended fix.** First resolve and authorize a bounded set of lightweight node identities, deduplicating common ancestors before joining large payloads. Detect overflow with a limit-plus-one plan before materializing record contents. Apply a separate cumulative byte budget when fetching payloads, with per-record limits, and load only the selected page. Check the actual recursive execution plan: simply adding an outer LIMIT after a sort/materialized join is not sufficient. Preserve ancestor-first key dependencies and authorization for shared nodes.

**Acceptance test.** Seed deep disjoint chains, a broad shared-ancestor tree, and maximum-valid records. Record SQL rows/buffers, database response bytes, and API RSS for a rejected request. Work and memory should be bounded by the admission/page budget rather than the entire expanded tree; valid small requests must remain fast alongside adversarially large ones.

**Runtime reference:** [PostgreSQL — recursive CTEs and materialization](https://www.postgresql.org/docs/current/queries-with.html).

<a id="perf-005"></a>

### PERF-005 — P1 — Million-node tree operations remain synchronous, memory-heavy, long transactions

**Area:** Backend / bulk mutation  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/routes/tree_walk.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/tree_walk.rs) — walk_subtree; update_tree_state.
- [backend/src/routes/files.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/files.rs) — restore; delete.
- [backend/src/routes/share_links.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/share_links.rs) — tree-state mutation using update_tree_state.

**What the code does.** The tree walker retains a node vector, visited set, and frontier, allowing up to 1,000,000 nodes. State updates are divided into 5,000-node statements, but callers pass one transaction and commit only after all chunks finish. Permanent deletion sorts the complete retained tree and executes every deletion batch inside that same request transaction.

**Why it hurts.** Per-statement limits do not bound total transaction duration, accumulated row locks, total WAL, or full-tree memory. A 10-second statement timeout is not a 10-second transaction deadline. Large operations occupy the recursive gate and a connection for their entire lifetime and can increase writer contention and vacuum pressure. The ceiling is finite, but very large relative to an interactive request.

**Recommended fix.** Use a durable, resumable tree-operation job above a measured synchronous threshold. Publish an atomic root-level operation state/version fence that makes reads and competing writes observe the required all-or-nothing logical state, then process bounded batches with short transactions and persistent cursors. Keep authorization, old/new parent checks, leaf-first deletion, object cleanup, counter changes, and failure recovery correct. Do not simply commit every 5,000 rows without defining partial-tree visibility. For smaller synchronous operations, retain a strict whole-operation node/byte/time budget and cancellation-safe rollback.

**Acceptance test.** Exercise 10k, 100k, and 1M-node trees alongside sibling writes and browsing. Track peak RSS, transaction age, lock wait, WAL, vacuum lag, and operation recovery after a worker crash. Confirm partial physical progress never exposes an inconsistent logical tree or grants access to a subtree marked deleted.

**Runtime reference:** [PostgreSQL — row locks and transaction lifetime](https://www.postgresql.org/docs/17/explicit-locking.html).

<a id="perf-006"></a>

### PERF-006 — P2 — Metadata continuation pages repeat work for plans that were already returned

**Area:** Backend / metadata pagination  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/routes/vault.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/vault.rs) — metadata_plans; encode_bounded_metadata_plans.

**What the code does.** The continuation offset is applied by the encoder after the handler has rerun metadata queries and built the candidate plans. Skipping earlier plans changes what is returned, not which records were fetched and prepared.

**Why it hurts.** A request split across several byte-limited responses repeatedly loads and encodes the same input set. With P pages over N plans, preparation can approach P times the all-plan work. Offset continuation is also fragile if the underlying ordered set changes between requests, creating wasted retries or inconsistent page boundaries.

**Recommended fix.** Page lightweight, deterministically ordered identities before loading manifests/wrappers. Bind continuation to a stable representation/version and authorization scope. Use a keyset cursor or a bounded, expiring result snapshot with a byte-aware page builder. Keep parent material available to children without resending every parent repeatedly; a versioned dictionary/reference format can help. This depends on the early bounding fix in PERF-004.

**Acceptance test.** Force metadata into multiple response pages. Compare fetched rows, bytes, and prepared plans per page; later pages must not redo all earlier payload work. Mutate a referenced record between pages and verify a clean version-conflict/reset rather than silent omission or duplicate publication of stale metadata.

<a id="perf-007"></a>

### PERF-007 — P2 — Metadata response sizing serializes plans that are serialized again for delivery

**Area:** Backend / serialization  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/routes/vault.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/vault.rs) — encode_bounded_metadata_plans; encode_json_response.

**What the code does.** The bounded metadata encoder serializes individual plans into temporary JSON buffers to determine their lengths. The selected plans are subsequently serialized again into the final response. Binary record material has already been represented as base64 strings.

**Why it hurts.** Near the response-size ceiling, this adds a full serialization pass, temporary allocations, and memory-bandwidth pressure. Pagination can repeat these costs. This is a measurable optimization opportunity, not evidence that encryption should be weakened or that every JSON response is expensive.

**Recommended fix.** Serialize selected plans once into a capped output writer, accounting for array delimiters and envelope bytes, and reuse those exact bytes in the response. Do not build a whole unbounded value merely to learn its size. A negotiated binary metadata format can also eliminate base64/string expansion, but should be versioned, bounded, and rolled out with client compatibility tests; optimizing the JSON path first is a smaller change.

**Acceptance test.** Benchmark the maximum valid metadata page and many small pages in release mode. Count allocation volume and encode CPU separately from SQL. Test exact boundary sizes, one oversized record, empty pages, and continuation behavior so the hard response cap is preserved.

<a id="perf-008"></a>

### PERF-008 — P2 — Per-node migration progress recounts the remaining account-wide work

**Area:** Backend / migration  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/routes/vault.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/vault.rs) — migration_summary; status; claim_migration.

**What the code does.** Status and migration claims call `migration_summary`, whose aggregates count relevant legacy/staged and incomplete migration state. A single-node claim therefore also performs account-wide progress work, including immediately after the claim transaction.

**Why it hurts.** When a migration processes N nodes one at a time and recounts the shrinking population on each claim, total examined rows can approach a quadratic series rather than linear migration work. This is particularly noticeable for many tiny files, where control-plane work dominates content transfer.

**Recommended fix.** Track migration totals and completed/pending counts transactionally with state transitions, reconcile them separately, or return a cheap progress revision and refresh exact progress less frequently. Batch claims within a bounded byte/file budget when parent ordering permits. Reuse a single post-commit read path and fix PERF-001 first. Progress optimization must not allow duplicate claims or misrepresent unfinished cleanup as complete.

**Acceptance test.** Run a migration consisting of many tiny nodes and inspect total SQL calls and rows processed as N increases. Doubling N should not approximately quadruple progress-query work. Verify counters after retries, interrupted uploads, skipped folders, and reconciliation.

<a id="perf-009"></a>

### PERF-009 — P2 — Large account JSON decoding and validation still run on an Actix worker

**Area:** Backend / CPU scheduling  
**Confidence/conditions:** High for the synchronous code path; magnitude is profile-gated and depends on account-state size.

**Where:**

- [backend/src/auth.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/auth.rs) — parse_json_body.
- [backend/src/routes/vault.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/vault.rs) — setup; validate_setup_material; account rewrap paths.
- [backend/src/state.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/state.rs) — VaultValidationService.

**What the code does.** Account setup/rewrap paths accept the large account JSON envelope, parse it through the JSON-body helper, and perform material decoding/validation directly in the async route. In contrast, several publication and response-encoding paths already use explicit bounded offloading. Async syntax does not move synchronous parsing or validation onto a CPU worker.

**Why it hurts.** Valid large encrypted account-state payloads can monopolize an Actix event-loop worker during JSON/base64 parsing, validation, and copies. The importance depends on account-state size and concurrency; small accounts may see negligible cost. This is not a claim that backend Argon2 or all vault crypto runs on the request loop.

**Recommended fix.** Separate bounded body collection from synchronous decode/validation. After releasing the DB connection, submit the CPU phase to the existing bounded validation service or another explicitly budgeted pool. Enforce admission before retaining multiple large buffers, and preserve detailed validation limits. Consider a binary account-state envelope to reduce string/copy overhead only after compatibility and profiling work.

**Acceptance test.** Send maximum-valid account-state requests while measuring an independent lightweight endpoint on every Actix worker. Inspect event-loop stalls and allocation profiles. Reject malformed/oversized payloads before expensive work, and ensure offload cancellation cannot release capacity while the blocking computation still runs.

<a id="perf-010"></a>

### PERF-010 — P2 — Foreground realtime triggers perform recursive audience expansion and per-recipient work

**Area:** Backend / realtime write amplification  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [database/init/026_realtime_changes.sql](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/database/init/026_realtime_changes.sql) — file/head change triggers; ancestor/audience expansion; realtime_enqueue.

**What the code does.** The realtime migration installs foreground triggers that derive changed nodes, walk ancestors, identify owner/share/link audiences, and loop over recipients to enqueue notifications. File changes and vault-head changes can both trigger related expansion inside one logical operation. Unique outbox keys coalesce stored events, but do not remove the work done before that upsert.

**Why it hurts.** Mutation latency grows with hierarchy and sharing fanout, and repeated trigger paths amplify CPU, locking, and writes. A publication can spend substantial time constructing notifications before its transaction may commit. This is a scale-dependent P2; a very high-fanout deployment could warrant P1 after measurement.

**Recommended fix.** Keep a minimal durable, transactionally written change/outbox record on the foreground path. Resolve and coalesce audiences in a bounded background dispatcher or, for a smaller change, replace recipient loops with set-based inserts and deduplicate changed ancestor sets once per transaction. Preserve the old and new audiences needed for revocation and moves. Retain a committed ordering/cursor protocol; never send uncommitted notifications or rely on lossy in-memory events for correctness.

**Acceptance test.** Vary changed-node count, tree depth, and recipient fanout independently. Measure mutation time, trigger time, WAL, and outbox write count. Test recipient removal, folder moves, rollback, and concurrent publications: every affected recipient must receive a valid change or reset without the request waiting for full delivery.

<a id="perf-011"></a>

### PERF-011 — P2 — Every leaf update can rewrite and contend on common ancestor rows

**Area:** Backend / hierarchy writes  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/collection_timestamps.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/collection_timestamps.rs) — touch_ancestor_collections.
- [database/init/026_realtime_changes.sql](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/database/init/026_realtime_changes.sql) — file-update notification triggers.

**What the code does.** `touch_ancestor_collections` recursively finds ancestor folders and updates their `updated_at` values, then updates matching repository rows. These are real writes to the shared hierarchy, not merely an in-memory timestamp calculation.

**Why it hurts.** Independent sibling uploads can converge on the same root folder and serialize on that row. Deep trees multiply row versions, index maintenance, realtime-trigger work, and WAL. This can limit write throughput even when S3 transfers run concurrently. The effect is workload-dependent, not evidence that plain SELECT browsing takes an exclusive lock.

**Recommended fix.** First coalesce ancestor updates across a batch and avoid semantically unnecessary repeated writes. For higher scale, separate leaf content versions from collection change revisions/derived display timestamps, using a bounded dirty-ancestor queue and explicit freshness semantics. Keep versions used for archive consistency accurate; a cosmetic timestamp may be eventually consistent, but a correctness fence may not. Do not remove hierarchy guards or replace shared-root contention with one new globally contended counter.

**Acceptance test.** Publish concurrently into sibling folders at several depths and inspect row-lock waits on common ancestors, WAL per publication, and events emitted. Verify breadcrumbs, recent ordering, repository snapshots, and archive change detection retain the intended semantics.

**Runtime reference:** [PostgreSQL — row locks and transaction lifetime](https://www.postgresql.org/docs/17/explicit-locking.html).

<a id="perf-012"></a>

### PERF-012 — P2 — Unrelated owner changes invalidate every repository, then browsing recounts a whole tree

**Area:** Backend / repository navigation  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [database/init/014_navigation_hot_paths.sql](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/database/init/014_navigation_hot_paths.sql) — mark_repository_counts_dirty_after_insert/delete/update.
- [backend/src/routes/repositories.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/repositories.rs) — detail: stale repository totals and foreground recount.

**What the code does.** Dirty-count triggers update repositories by affected owner, rather than limiting invalidation to repository roots affected by the old/new path. `detail` detects the stale version and waits for a recursive full-tree count alongside the child list, with one additional recount if a concurrent structural write changes the version.

**Why it hurts.** Uploading elsewhere in an account can make the next visit to an unrelated repository scan its entire tree. Multiple simultaneous readers may repeat a cold recount, and continuous changes can force retries. The displayed page may contain only a few hundred entries while its summary work examines the whole repository.

**Recommended fix.** Compute affected repository roots from old/new ancestor sets and invalidate only those. Maintain count deltas transactionally where practical, with a version-fenced background reconciliation path. Otherwise single-flight recounts by repository/version and serve clearly stale summaries separately from the immediately usable listing when product semantics permit it. Avoid a broad repository table update for every owner mutation.

**Acceptance test.** Create several independent repositories for one owner, mutate only one or a non-repository folder, then load another. Its count version and recount activity should remain unchanged. Under true in-repository changes, confirm totals remain correct and concurrent detail requests do not launch duplicate full scans.

<a id="perf-013"></a>

### PERF-013 — P2 — Each repository archive page rebuilds and aggregates the complete tree

**Area:** Backend / archive pagination  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/routes/repositories.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/repositories.rs) — REPOSITORY_ARCHIVE_PAGE_QUERY.
- [backend/src/routes/repositories.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/repositories.rs) — archive_manifest.

**What the code does.** The archive query recursively constructs the whole tree, materializes joined archive entries, computes windowed totals and change detection, and only then filters the cursor and applies the page limit. Output is paginated, but the expensive prefix of the query is repeated on every page.

**Why it hurts.** For 50,000 entries and 1,000-entry pages, approximately 50 full-tree preparations may be performed, corresponding to roughly 2.5 million entry visits before considering joins, sorts, or ancestor bookkeeping. This is arithmetic from the query structure, not a measured execution count or elapsed time.

**Recommended fix.** Prepare a versioned immutable manifest once, including totals and content-version checks, then page an indexed ordinal/key from that snapshot. Alternatively maintain suitable tree membership/order metadata so each page can be fetched without reconstructing all descendants. Bind the manifest to owner, repository version, access scope, and expiry. Do not trade the current change-detection guarantee for a cursor that silently mixes different repository states.

**Acceptance test.** Capture EXPLAIN ANALYZE/BUFFERS in staging for first, middle, and last pages and total database work for a complete archive. Total scan work should approach one preparation plus page reads, not page count times tree size. Mutations between pages must cause the documented conflict/reset behavior.

**Runtime reference:** [PostgreSQL — recursive CTEs and materialization](https://www.postgresql.org/docs/current/queries-with.html).

<a id="perf-014"></a>

### PERF-014 — P2 — Every idle SSE connection performs a database replay query every five seconds

**Area:** Backend / realtime idle load  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/routes/events.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/events.rs) — heartbeat loop; REPLAY_QUERY.
- [backend/src/realtime.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/realtime.rs) — stream admission limits.

**What the code does.** SSE releases its connection before streaming, which is correct. However, each stream performs a replay/session-validation query on the five-second heartbeat even when there are no changes. Streams for the same user independently do this work.

**Why it hurts.** N idle streams generate roughly N/5 replay queries per second, excluding auth on connection setup and pool verification. At the configured 2,048-stream ceiling that is about 409.6 queries/second before real browsing. Multiple tabs amplify the same user's work. This is a scaling limit, not a claim that a quiet single-user deployment is currently overloaded.

**Recommended fix.** Use cheap socket heartbeats and coalesced per-user replay/fanout rather than per-socket SQL. Keep session-specific authorization validation separately bounded and batchable, with revocation notifications plus a short periodic safety check. Preserve the existing revocation-latency requirement; simply removing session validation or increasing its interval is not an acceptable speed fix. A cross-tab leader can reduce sockets further, but server-side sharing should not depend on browser cooperation.

**Acceptance test.** Measure idle database QPS at 1, 100, and 2,048 streams, including several sessions/tabs for one user. Verify query growth is no longer one replay per socket per heartbeat. Disable a session and confirm its stream expires within the existing security bound even if notifications are missed.

<a id="perf-015"></a>

### PERF-015 — P2 — Realtime pruning has a fixed service-rate ceiling that can fall behind writes

**Area:** Backend / realtime retention  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/realtime.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/realtime.rs) — 60-second prune cadence; bounded prune loop.

**What the code does.** Pruning runs on a 60-second cadence with at most eight batches of 2,048 rows per pass. The retention target does not increase this pass budget when the expired/event backlog is larger.

**Why it hurts.** The nominal ceiling is 16,384 deleted rows per minute per active pruning loop, or about 273 rows/second before execution overhead. Sustained eligible-row creation above effective cleanup capacity causes a growing table and indexes despite the configured retention target. Coalescing means file-operation count is not necessarily event-row count, and replicas may change effective capacity.

**Recommended fix.** Make cleanup backlog-aware with a bounded wall-time/I/O budget and rapid rescheduling while eligible rows remain. Track prune lag and oldest retained event, not only a desired row count. At larger scale, evaluate time/range partition retirement, while preserving the replay floor and a safe reset protocol for clients whose cursors fall behind. Do not run an unbounded DELETE on the foreground path.

**Acceptance test.** Generate event rows above and below effective prune throughput for a sustained interval. After writers stop, the backlog must drain predictably; under supported sustained load, retention lag must stabilize. Test replay cursors spanning each pruning boundary and ensure no missed updates are presented as a successful catch-up.

<a id="perf-016"></a>

### PERF-016 — P2 — Admin bucket usage repeatedly performs a full, replica-local bucket scan

**Area:** Backend / storage overview  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/bucket_usage.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/bucket_usage.rs) — cache refresh; full ListObjectsV2 scan; scan timeout.

**What the code does.** The overview correctly serves cached/loading state instead of synchronously blocking the admin response. Its cache is nevertheless local to each process, expires after 60 seconds, and refreshes by serially listing the entire bucket in 1,000-object pages. Refresh has a 120-second timeout and a page limit, and does not persist partial progress. It uses its own provider request path rather than the shared operation gate.

**Why it hurts.** With repeated admin reads, each replica may repeat O(bucket object count) work. For N objects, one scan needs approximately ceil(N/1000) listing requests; R replicas can duplicate it R times. If a full scan cannot finish within its deadline, repeated attempts restart without producing a fresh total. This is background provider cost/contention and stale data, not a synchronous 120-second page wait.

**Recommended fix.** Use a shared durable physical-usage snapshot refreshed by one fenced worker. Prefer provider inventory/metrics where their freshness and accounting semantics fit, or maintain an object-change ledger plus slower reconciliation. Make reconciliation resumable, rate-limited, and checkpointed, and expose sample age. Retain physical/untracked-object accounting: replacing it with logical user quota counters alone changes the feature's meaning.

**Acceptance test.** Test a large paginated bucket, artificial listing latency, failure mid-scan, and multiple replicas. Verify one bounded refresh workload, progress across retries, correct accounting for objects outside normal application prefixes, and an honest stale timestamp when a fresh complete sample is unavailable.

<a id="perf-017"></a>

### PERF-017 — P2 — Trash expiry and next-due calculation repeatedly evaluate cross-table deadlines

**Area:** Backend / maintenance queries  
**Confidence/conditions:** High for the repeated cross-table calculation; the chosen query/index repair is execution-plan dependent.

**Where:**

- [backend/src/storage.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/storage.rs) — EXPIRE_TRASH_BATCH_QUERY.
- [backend/src/storage.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/storage.rs) — MaintenanceWorker::next_due_delay; expire_trash_batches.
- [database/init/027_flexible_retention_and_vault_lock.sql](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/database/init/027_flexible_retention_and_vault_lock.sql) — minute-based retention and policy changes.

**What the code does.** Trash expiry compares `files.trashed_at + users.trash_retention_minutes * interval` with now, joining the policy table. The idle next-due query computes a MIN over that same cross-table expression. Limiting deleted rows to 500 does not bound rows inspected to find eligible leaves or to compute the next wake time.

**Why it hurts.** A large population of unexpired trash can cause expensive scans even when no item is deleted. Repeated notifications and replica-local maintenance loops can repeat the work. The precise scan plan requires EXPLAIN on actual data; the expression cannot simply be covered by an ordinary single-table index on the combined policy-dependent deadline.

**Recommended fix.** Introduce an indexed due-work representation or use per-owner indexed cutoffs with a fair owner-level scheduler. If materializing expiry times, version them against retention policy and recheck the current policy immediately before deletion; extending retention must not cause early deletion. Maintain a cheap next-due lookup and leaf-first eligibility without rescanning all unexpired trash. Inspect computed next-due expressions in the other maintenance queues for the same issue.

**Acceptance test.** Populate mostly unexpired trash with heterogeneous retention policies. Compare buffers/rows examined for empty expiry passes and next-due reads. Change policies in both directions during cleanup and confirm no premature deletion, no lost work, and no busy loop caused by an expired non-leaf folder.

<a id="perf-018"></a>

### PERF-018 — P2 — Multipart reconciliation pins a maintenance connection across an entire provider sweep

**Area:** Backend / maintenance database capacity  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/storage.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/storage.rs) — reconcile_orphaned_multipart_uploads.
- [backend/src/storage.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/storage.rs) — sweep_orphaned_multipart_uploads.

**What the code does.** The reconciliation worker obtains a maintenance-pool client and a session-level advisory lock, then passes that client through the complete multipart listing/recheck/abort sweep. It releases the advisory lock only after the whole provider sweep finishes.

**Why it hurts.** A slow or large provider scan occupies one of the default two maintenance connections across many network waits. Other finalization, expiry, or cleanup workers have less capacity, increasing background completion latency. The separate request pool limits direct request-pool damage, but delayed cleanup and finalization are still user-visible.

**Recommended fix.** Use a fenced durable lease and persistent sweep cursor so work can acquire a DB connection only for short state phases, or isolate the leadership lock on a deliberately budgeted dedicated connection. Bound each sweep segment by time and pages. Keep crash-window adoption and active-upload protection intact. Never return a session-advisory-lock connection to the general pool while assuming that lock continues to provide safe ownership for detached work.

**Acceptance test.** Delay provider listing/abort calls while finalization and expiry jobs run. Maintenance checkout latency and job age should remain bounded. Kill the leader mid-page and verify a replacement continues safely without duplicate destructive aborts or abandoned leadership.

<a id="perf-019"></a>

### PERF-019 — P2 — Maintenance concurrency limits are per worker, with nested provider fanout

**Area:** Backend / aggregate storage admission  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/storage.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/storage.rs) — run_maintenance_worker; MaintenanceWorker::run.
- [backend/src/storage.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/storage.rs) — expire_abandoned_vault_uploads.
- [backend/src/storage.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/storage.rs) — abort_multipart_uploads_for_key.
- [backend/src/storage.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/storage.rs) — run_bounded_storage_tasks.

**What the code does.** Several workers independently receive the same numeric storage concurrency. Within an expired-upload task, exact-key multipart discovery can itself issue up to eight concurrent aborts. These bounds are not one shared semaphore covering every underlying maintenance provider request. Bucket-usage refresh is another separate source.

**Why it hurts.** The configured number is not a global provider-I/O ceiling. Overlapping workers and nested aborts can multiply outbound concurrency, provider throttling, connection use, and retries. Actual concurrency depends on how many incomplete multipart sessions exist per key and which workers overlap.

**Recommended fix.** Introduce a shared maintenance provider budget at the lowest I/O boundary, with separate reserved capacity for interactive operations and bounded fairness among cleanup classes. Avoid holding an outer permit while waiting to acquire nested permits from the same semaphore; acquire per actual provider operation or use one non-nesting scheduler. Retain per-job bounds as an additional memory/fairness control, and record actual in-flight provider calls.

**Acceptance test.** Overlap reconciliation, expired vault uploads, deletion jobs, and overview refresh with a provider stub counting in-flight requests. Assert the intended aggregate cap under nested discovery/abort work and ensure interactive metadata/finalization latency remains stable.

<a id="perf-020"></a>

### PERF-020 — P2 — Multipart orphan reconciliation still performs serial per-candidate database rechecks

**Area:** Backend / reconciliation round trips  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/storage.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/storage.rs) — sweep_orphaned_multipart_uploads.

**What the code does.** The sweep initially fetches upload intents for a whole listing page, but then awaits a `protected_after_race` query separately for each candidate before adding it to the abort list. Candidates needing adoption also execute per-item state updates. Provider abort concurrency begins after this serial preparation loop.

**Why it hurts.** For a page containing many orphan candidates, database round-trip latency accumulates before aborts can start. The initial set-based lookup therefore does not make the entire page preparation set-based. This is chiefly a cleanup-throughput issue, amplified by the pinned connection in PERF-018.

**Recommended fix.** Batch fresh eligibility checks and conditional adoption/claim transitions in bounded short transactions, returning explicit per-item decisions. Pipeline small prepared groups to the bounded abort scheduler instead of waiting for the entire page. Preserve the race recheck's safety purpose: do not simply delete it because a prior listing-page snapshot exists. Revalidate active/protected upload ownership at the final safe transition.

**Acceptance test.** Use a page with many true orphans, active uploads, and concurrently initialized intents. Measure queries and preparation latency per page. Verify protected uploads survive and the query count approaches the number of bounded groups rather than the number of orphan candidates.

<a id="perf-021"></a>

### PERF-021 — P2 — The supported presign batch can overrun its own per-user storage admission budget

**Area:** Backend / presign batching  
**Confidence/conditions:** High for the batch/admission mismatch under contention; not reproduced against a running deployment.

**Where:**

- [backend/src/routes/vault.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/vault.rs) — presign_parts.
- [backend/src/state.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/state.rs) — storage operation admission.
- [README.md](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/README.md) — storage concurrency and queue defaults.

**What the code does.** The API accepts up to 32 presign parts and dispatches their operations through `try_join_all`. Each enters the same per-user storage admission service. The default per-user concurrency and waiting budget are smaller than an unconstrained 32-operation burst when that budget is already occupied. The ordinary frontend sends four-part batches, so this is not an assertion that normal four-part uploads always fail.

**Why it hurts.** Under concurrent storage work, one valid large batch can reject some of its own siblings and cancel the surrounding aggregate. Clients then retry control work, increasing latency and overload. Presigning itself is local in the configured setup, making contention with network-bound provider operations particularly unnecessary.

**Recommended fix.** Process API batches with bounded rolling concurrency derived from a deliberate batch budget, or give local signing a separate small CPU/admission class. Validate/admit a batch coherently rather than discovering insufficient capacity halfway through its fanout. Preserve limits, URL expiry, checksums, content lengths, and current upload authorization. Releasing DB resources before admission is also required by PERF-002.

**Acceptance test.** Test a valid 32-part request while the user's storage gate is partly occupied. It should either be rejected predictably before partial work or complete under bounded scheduling, without self-induced retry storms. Keep the four-part browser path fast.

<a id="perf-022"></a>

### PERF-022 — P2 — The reviewed local-file download route always streams the complete object

**Area:** Backend / local downloads  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/routes/files.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/files.rs) — download.

**What the code does.** After authorization, the S3 path redirects to a signed object URL. The local path opens the file and returns a 200 response with the full length and stream; the reviewed route does not process a Range request or return a partial-content response.

**Why it hurts.** Local-storage clients cannot obtain an efficient prefix or resume through this route. A small preview or interrupted download can therefore require the entire object again. This finding is conditional on local/legacy storage; it does not claim the S3 provider lacks byte ranges.

**Recommended fix.** Implement authenticated single-range downloads or use a file-serving abstraction that correctly supports Range, Content-Range, 206/416, and validators. Recheck access before serving any range and bind resume to an immutable content version. Preserve private cache policy and safe filenames. Avoid multipart-range complexity until a real client requires it.

**Acceptance test.** Test prefix, suffix, unsatisfiable, full, and resumed requests against local storage. Measure transferred bytes and verify changed content cannot be appended to an old download. Confirm identical authorization for full and partial responses.

<a id="perf-023"></a>

### PERF-023 — P3 — ETags are checked only after database work and full JSON serialization

**Area:** Backend / conditional responses  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/routes/conditional.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/conditional.rs) — private_json.
- [backend/src/routes/repositories.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/repositories.rs) — detail.
- [src/lib/api.tsx](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/lib/api.tsx) — no-store server fetch wrappers.

**What the code does.** `private_json` serializes the complete response, hashes it, and then compares If-None-Match. Callers have already performed their queries and assembled their data. The server-rendering wrappers also do not supply stored validators for their no-store requests.

**Why it hurts.** A 304 can save response bytes but not the main SQL/serialization cost. This is an optimization opportunity for repeated unchanged reads, not a reason to globally cache authenticated plaintext or a claim that the current ETags are incorrect.

**Recommended fix.** Where a trustworthy representation revision exists, authorize first and compare a revision-derived validator before loading expensive data. Include all relevant versions, permission state, folder, filter, sort, and pagination scope. Introduce private version-keyed response caching only with explicit invalidation rules and memory bounds. Do not add cross-request session caching that delays revocation merely to make conditional reads cheaper.

**Acceptance test.** Repeat an unchanged authenticated request with a validator and compare SQL/encode work with a changed response. Every mutation that affects bytes or access must invalidate the validator, including counters, sharing changes, and ordering changes.

<a id="perf-024"></a>

### PERF-024 — P3 — Verified connection recycling adds a validation query to warm checkouts

**Area:** Backend / connection recycling  
**Confidence/conditions:** Profile-gated tuning experiment; no recommendation to switch blindly.

**Where:**

- [backend/src/db.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/db.rs) — Database::create; RecyclingMethod::Verified.

**What the code does.** Both pool roles use `RecyclingMethod::Verified`. The crate documents that this validates with a test query, unlike the lighter `Fast` method. It is a deliberate reliability choice, not an implementation bug.

**Why it hurts.** Where application-to-Postgres RTT is significant and requests are short, the extra checkout round trip can be material. It compounds frequent SSE replay checkouts. On a local low-latency database the benefit of changing it may be small, and stale connections can make a faster policy worse at the tail.

**Recommended fix.** Benchmark the current policy against Fast only after fixing resource lifetime and excess query volume. Use robust reconnect handling and retry only operations known to be safe to retry; never automatically replay ambiguous commits. Keep connection lifetime/jitter and failure detection. Adopt a lighter policy only if fault-injection and p99 results justify the reliability tradeoff.

**Acceptance test.** Measure checkout and end-to-end p95/p99 on warm healthy connections, then kill idle database connections and interrupt the network. Compare failure rate, recovery time, and ambiguous-write behavior, not just mean checkout speed.

**Runtime reference:** [deadpool-postgres — RecyclingMethod](https://docs.rs/deadpool-postgres/latest/deadpool_postgres/enum.RecyclingMethod.html).

## Frontend and transfer findings

<a id="perf-025"></a>

### PERF-025 — P2 — Deterministic reconnects plus fixed polling amplify a shared outage

**Area:** Frontend / realtime recovery  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [src/features/realtime/connection.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/realtime/connection.ts) — failed; catchUp; connection watchdogs.

**What the code does.** SSE retries start at 250 ms and double to a five-second cap without jitter. While recovering, the client also performs short sync polling on a fixed one-second schedule. The first-frame watchdog is two seconds; subsequent checkpoints use eight seconds.

**Why it hurts.** Clients that fail together can reconnect and poll together. Under server queue pressure the short first-frame deadline can classify a slow stream as failed and add more recovery traffic. Single-flight polling prevents overlap within one connection, but does not desynchronize users or coordinate the two recovery mechanisms globally.

**Recommended fix.** Use capped full-jitter backoff, a coordinated recovery budget, and adaptive fallback polling. Honor Retry-After on fetch responses and distinguish session expiry from transient capacity/network failures. Make watchdogs consistent with the declared service latency and heartbeat contract, with a maximum recovery bound. Keep cursor validation and stale-response protection intact.

**Acceptance test.** Drop SSE for a large synchronized client cohort, slow the first frame, and restore service gradually. Count combined sync/reconnect requests, recovery delay, and missed changes. Verify traffic spreads out and session revocation still takes effect within the security requirement.

<a id="perf-026"></a>

### PERF-026 — P2 — Unrelated file changes trigger full current-route refreshes

**Area:** Frontend / invalidation  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [src/features/realtime/changes.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/realtime/changes.ts) — affectsRoute; RefreshCoordinator.
- [src/features/realtime/realtime-provider.tsx](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/realtime/realtime-provider.tsx) — refresh.
- [src/lib/api.tsx](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/lib/api.tsx) — server-side no-store reads.
- [src/features/vault/vault-file-list.tsx](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/vault/vault-file-list.tsx) — metadata resolution effect.

**What the code does.** `affectsRoute` treats file-related changes as relevant to many entire sections regardless of folder IDs, because account counters are coupled to those pages. The provider calls `router.refresh()`. Coalescing is already implemented, but each resulting refresh still requests the route again and can rerun server reads and client metadata effects.

**Why it hurts.** A background upload into an unrelated folder can make the current page refetch its listing and summaries. During sustained activity this spends DB, Node, network, and browser work on data that mostly did not change. It can also interfere with perceived navigation responsiveness.

**Recommended fix.** Decouple account-wide counter updates from folder-list refreshes. Apply versioned patches or narrowly refetch the affected list/counter resource, using folder IDs and route scope. Keep broad resets for real replay gaps and security/account changes. Preserve optimistic overlays, ordering, pagination membership, and the existing refresh backpressure; do not replace one full refresh with an unbounded set of item requests.

**Acceptance test.** Stay in one folder while changing another and record RSC requests, database calls, decrypted-name resolution, and React commits. Unrelated content should not refetch the current list, while counters and authorization remain current. Test active uploads and mutations during refresh completion.

**Runtime reference:** [Next.js — router.refresh behavior](https://nextjs.org/docs/app/api-reference/functions/use-router).

<a id="perf-027"></a>

### PERF-027 — P2 — Mount, resume, and unlock can force full resets even when replay can prove freshness

**Area:** Frontend / startup and resume  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [src/features/realtime/realtime-provider.tsx](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/realtime/realtime-provider.tsx) — resume; initial effect; unlocked-state effect.
- [src/features/realtime/changes.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/realtime/changes.ts) — reset scheduling.

**What the code does.** The provider unconditionally requests a reset when becoming active, including its initial mount, visibility/page restoration, and online transitions. Unlock also requests a reset. These reset requests can be coalesced, so they are not necessarily separate network requests every time, but they still cause broad refresh/invalidation when scheduled.

**Why it hurts.** Initial SSR may be immediately followed by another server render, and returning to a tab may throw away useful metadata before the existing cursor/replay mechanism determines whether anything changed. This is a redundant-work opportunity only where freshness can be proven; the current reset protects a real SSR-to-stream race.

**Recommended fix.** Carry a version/cursor fence with the server-rendered snapshot and reconcile from that point. Skip broad reset only when the server confirms coverage and unchanged relevant versions. Reuse valid record-hash-keyed metadata across visibility changes, while keeping explicit reset on expired cursors, identity changes, or vault security transitions. Do not remove the initial reset without replacing its race protection.

**Acceptance test.** Measure cold entry, unlock, unchanged tab resume, changed tab resume, and a replay-gap resume. The unchanged cases should avoid unnecessary full reloads; all changed/gap cases must become correct without missing events between SSR and SSE establishment.

<a id="perf-028"></a>

### PERF-028 — P2 — A fatal crypto-worker error can leave later requests waiting indefinitely

**Area:** Frontend / worker failure latency  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [src/features/vault/vault-client.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/vault/vault-client.ts) — worker error listener; failPending; send.

**What the code does.** The worker error listener rejects currently pending calls, but the reviewed client does not mark itself terminal or replace the failed worker. Later `send` calls can still enqueue pending work. There is no general request-completion watchdog on that path.

**Why it hurts.** After a fatal worker load/runtime failure, subsequent UI actions can appear to run forever rather than fail quickly or recover. Whether the outer provider happens to recreate the client in a particular flow requires integration testing; the client itself does not guarantee it.

**Recommended fix.** Make worker failure an explicit terminal state, reject future calls immediately, handle message-deserialization failures, and notify the owner/provider to tear down dependent operations. Recreate a worker only through a controlled vault-state recovery path, requiring re-unlock when key material is lost. Use operation-appropriate watchdogs and cancellation acknowledgments; do not apply a short blanket timeout to intentionally expensive KDF work.

**Acceptance test.** Force a missing worker asset, worker exception, and malformed response. Existing and subsequent calls must reject deterministically with actionable state, not remain pending. Verify recovery neither retains stale sessions nor silently downgrades encryption checks.

<a id="perf-029"></a>

### PERF-029 — P2 — Multipart encryption waits for four prepared parts and advances in slowest-part waves

**Area:** Frontend / upload throughput  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [src/features/vault/encrypted-upload.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/vault/encrypted-upload.ts) — createMultipartUploadPipeline; encryptAndUploadFile; uploadMultipartParts.
- [src/features/vault/bounded-async.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/vault/bounded-async.ts) — BoundedBatchPipeline.
- [backend/src/e2ee.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/e2ee.rs) — UPLOAD_PART_BYTES.

**What the code does.** The encrypted uploader uses a four-part presign/process batch and one-part lookahead. `BoundedBatchPipeline` starts a full batch only after four inputs exist, keeps one batch in flight, and waits for that batch to settle before advancing. The part uploader uses Promise.all over its PUTs. With 32 MiB parts, the first full batch requires 128 MiB of prepared ciphertext.

**Why it hurts.** Large uploads delay first-byte transmission while preparing the batch. Files that produce fewer than four multipart inputs may finish preparation before `finish()` flushes them. A slow part or retry holds back the next wave and eventually blocks encryption despite free network slots. Memory is bounded already; removing the bound would be a regression.

**Recommended fix.** Replace the whole-batch barrier with a rolling pipeline governed by a shared byte budget. Start the first ready part promptly, microbatch only ready checksum/presign requests with a short flush deadline, and refill individual upload slots as each part completes. Bound outstanding encryption buffers, ready parts, and active PUT bodies together. Preserve part order in completion metadata, checksums, retry identity, URL refresh, and cancellation cleanup.

**Acceptance test.** Test files around the multipart threshold, 64/128 MiB, and the maximum supported size under heterogeneous per-part latency. Measure selection-to-first-PUT, sustained throughput, idle network slots, and peak RSS. Inject one slow/retried part; other available slots should continue within the same memory ceiling.

<a id="perf-030"></a>

### PERF-030 — P2 — All folder preparation is completed before any selected file upload starts

**Area:** Frontend / folder upload preparation  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [src/features/vault/encrypted-upload.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/vault/encrypted-upload.ts) — uploadEncryptedSelections; publishEncryptedFolderTree.

**What the code does.** The selection uploader awaits the complete encrypted folder tree before starting file uploads. Folder key/record preparation is serial: start one folder, finalize it, and eventually publish a 100-record batch. Parent-before-child preparation is intentional, but independent sibling folders are also serialized.

**Why it hurts.** A deep/wide selection can spend noticeable time in folder crypto and control requests before transferring the first file, even when that file's own parent is already ready. Many tiny files and empty-folder-heavy selections magnify setup latency.

**Recommended fix.** Build a dependency-aware schedule: process independent siblings with bounded concurrency or batched worker messages, publish only parent-valid batches, and release files as soon as their own parent has been durably published. Keep parent-key ordering and bounded record memory. Integrate share-directory synchronization and abort cleanup with the dependency graph rather than removing those barriers indiscriminately.

**Acceptance test.** Upload wide, deep, mixed, and empty-folder-heavy selections. Record first-file start and total duration while verifying correct parent keys, parent IDs, publication ordering, and cleanup when a folder batch fails midway.

<a id="perf-031"></a>

### PERF-031 — P2 — Application-level decryption and sink writes are awaited serially per chunk

**Area:** Frontend / download pipeline  
**Confidence/conditions:** Code-verified serial stages; performance gain from pipelining is profile-gated.

**Where:**

- [src/features/vault/encrypted-download.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/vault/encrypted-download.ts) — decryptEncryptedFile.
- [src/features/vault/encrypted-upload.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/vault/encrypted-upload.ts) — encryptAndUploadFile.

**What the code does.** Encrypted download setup already overlaps the plan/worker start and fetch. The chunk loop then awaits an exact ciphertext read, worker decryption, and sink write in order. Upload file reading and encryption similarly use a serial per-chunk producer. Browser networking may buffer ahead, so this is not a claim of zero network/CPU overlap.

**Why it hurts.** On fast links or slower disk/worker boundaries, application-stage gaps can reduce sustained throughput. The gain is hardware/browser dependent; a slow network or single saturated crypto engine may make additional pipelining useless.

**Recommended fix.** Introduce a small bounded stage pipeline, initially one chunk of lookahead, with sequence numbers and ordered consumption. Overlap safe reads and disk writes without concurrently mutating an order-sensitive crypto session unless that protocol is explicitly redesigned and verified. Account for transferable-buffer ownership and wipe/cancel abandoned buffers. Tune using end-to-end throughput and memory, not CPU core count alone.

**Acceptance test.** Compare network-limited, CPU-limited, and disk-limited cases across supported browsers. Measure stage idle time, throughput, peak memory, cancellation, and final integrity. Reject the change if it increases memory or complexity without a measurable benefit.

<a id="perf-032"></a>

### PERF-032 — P2 — Encrypted downloads lack bounded range-based resume after a transient failure

**Area:** Frontend / interrupted transfers  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [src/features/vault/encrypted-download.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/vault/encrypted-download.ts) — fetch and decryption loop.
- [backend/src/routes/vault.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/vault.rs) — download_plan; immutable generation information.

**What the code does.** The reviewed encrypted download performs one content fetch using the operation signal and processes that stream. It does not implement a retry/resume loop at authenticated chunk boundaries or a progress-stall recovery policy. Uploads do have a retry helper, so this finding is specific to downloads.

**Why it hurts.** A failure near the end of a large download can force a restart from zero, wasting transferred bytes and decryption time. A stalled response can also leave the operation waiting until the network/browser fails it or the user cancels.

**Recommended fix.** Implement a bounded download recovery policy using immutable generation identity, AEAD-aligned ciphertext ranges, and safe URL renewal. Validate 206/Content-Range, object/version consistency, per-chunk authentication, and the final required integrity check. Resume the sink and hash/session state only from a verified checkpoint; otherwise restart safely. Add progress-based stall detection with capped jittered retries, not a total-duration timeout that breaks slow but healthy large downloads. Confirm the actual S3-compatible provider supports the needed range semantics.

**Acceptance test.** Interrupt downloads at early, middle, and final chunk boundaries; expire URLs; return wrong ranges; mutate an object/version. Successful recovery should retransmit only the necessary verified range, while all integrity mismatches fail closed and partial output is handled explicitly.

**Runtime reference:** [Amazon S3 — range and retry performance guidance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance-guidelines.html).

<a id="perf-033"></a>

### PERF-033 — P2 — A small text preview can download and decrypt an entire much larger file

**Area:** Frontend / repository preview  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [src/features/repositories/repository-file-loader.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/repositories/repository-file-loader.ts) — loadRepositoryFile; prepareRepositoryFile; readResponseBlob.

**What the code does.** The loader accepts files up to a 100 MiB safety limit and first obtains the complete Blob, including full encrypted-file decryption. Only afterward does preview preparation slice a roughly 2 MiB text/binary prefix or a smaller prefix for other types, with an additional character display cap.

**Why it hurts.** Opening a preview may transfer and decrypt tens of megabytes that the preview never displays, delaying first useful content. The existing 100 MiB cap prevents unlimited preview buffering; the problem is overfetch within that valid range.

**Recommended fix.** Classify preview needs from trusted metadata, then request only a bounded prefix or a purpose-built thumbnail/text derivative. For encrypted content, fetch and authenticate the necessary complete crypto chunks and label partial verification accurately; do not claim the entire file's Merkle root was verified when only a prefix was read. Defer the remaining full object until explicit download or a viewer that requires it. Coordinate with local Range support in PERF-022.

**Acceptance test.** Open a large text file and measure bytes transferred, first text paint, and decryption work. They should scale with the preview budget, not full file size. Test malformed content, split multibyte characters, encrypted corruption, and viewers that genuinely require complete media data.

<a id="perf-034"></a>

### PERF-034 — P3 — Legacy preview buffering makes an explicit extra copy of each network chunk

**Area:** Frontend / preview allocations  
**Confidence/conditions:** High for the explicit copy; benefit depends on browser implementation and preview size.

**Where:**

- [src/features/repositories/repository-file-loader.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/repositories/repository-file-loader.ts) — readResponseBlob.

**What the code does.** The preview response collector copies each received Uint8Array using `Uint8Array.from` before storing it for Blob construction. This is an explicit copy in the application regardless of how a browser implements later Blob storage.

**Why it hurts.** At the 100 MiB preview ceiling, the collector performs substantial avoidable memory copying in addition to retained data and later preview processing. This is a secondary optimization after eliminating full-file preview overfetch.

**Recommended fix.** Retain immutable response chunks directly when their ownership/lifetime guarantees permit it, or use a bounded stream-to-preview decoder. Do not reuse or wipe buffers still referenced by the consumer. Profile actual browser allocation behavior rather than assuming Blob construction is universally zero-copy.

**Acceptance test.** Compare allocation profiles and copied bytes for maximum-size legacy previews. Verify chunk contents remain stable and cancellation releases retained buffers. Prefer the prefix-only design from PERF-033 where applicable.

<a id="perf-035"></a>

### PERF-035 — P3 — Every file larger than 8 MiB reserves the entire selection-level file budget

**Area:** Frontend / file scheduling  
**Confidence/conditions:** Profile-gated scheduling opportunity; keep the current conservative policy unless measurements justify a change.

**Where:**

- [src/features/vault/encrypted-upload.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/vault/encrypted-upload.ts) — VAULT_CONCURRENT_FILE_MAX_BYTES; WeightedSemaphore acquisition.
- [src/features/vault/bounded-async.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/vault/bounded-async.ts) — WeightedSemaphore; detectedCryptoConcurrency.

**What the code does.** Small-file concurrency is capped at three and based on reported hardware concurrency. A selected file larger than 8 MiB requests the whole weighted semaphore capacity, covering its complete encryption/init/upload/publication lifecycle.

**Why it hurts.** This protects memory, but may serialize files even while the current file is only waiting for a small control request or finalization. It is a conservative scheduling choice, not a proven production bottleneck, and large multipart uploads already have internal PUT concurrency.

**Recommended fix.** After implementing a rolling byte-budgeted pipeline, evaluate reserving memory and stage-specific permits instead of making one file exclusive for its full lifetime. Let a small amount of independent control work progress while a large file waits, but retain fair service and a hard aggregate ciphertext-buffer ceiling. Use observed throughput and pressure signals before adapting concurrency upward.

**Acceptance test.** Benchmark mixed tiny/large selections and slow finalization on low-memory devices. Require lower total completion/first-small-file latency without exceeding current memory limits or starving a large file behind many small ones.

<a id="perf-036"></a>

### PERF-036 — P3 — Each dashboard session bootstrap uses separate authenticated user and CSRF reads

**Area:** Frontend / session bootstrap  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [src/features/dashboard/dashboard-session.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/dashboard/dashboard-session.ts) — getDashboardSession.
- [src/lib/api.tsx](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/lib/api.tsx) — getAuthState; getCsrfState.

**What the code does.** `getDashboardSession` correctly uses React request-scoped cache and launches auth/CSRF calls in parallel. The remaining duplication is the two separate backend HTTP requests, each with its own authentication context, not duplicate layout/page execution of an uncached helper.

**Why it hurts.** For a very fast local API the overhead may be small. It still adds request processing and database work to each server-rendered bootstrap/refresh, which is multiplied by broad realtime route refreshes.

**Recommended fix.** Return the authenticated user representation and CSRF token from one private session-bootstrap endpoint backed by one authorization read. Keep request-scoped memoization and fail closed on unavailable/expired sessions. Do not turn the result into a long-lived cross-request authorization cache without a revocation design.

**Acceptance test.** Inspect one complete dashboard render and confirm a single bootstrap request/read, correct CSRF token binding, and unchanged redirects/error behavior. Measure the benefit separately from eliminating redundant route refreshes.

## Deployment and build findings

<a id="perf-037"></a>

### PERF-037 — P2 — Migration 015 revalidates the complete hierarchy on ordinary production redeploys

**Area:** Deployment / database migration  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [database/init/015_collection_hierarchy_performance.sql](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/database/init/015_collection_hierarchy_performance.sql) — unconditional hierarchy validation and ledger insert.
- [scripts/migrate-production.sh](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/scripts/migrate-production.sh) — loop over every init migration.
- [railway.json](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/railway.json) — preDeployCommand.

**What the code does.** The production migration script invokes every numbered SQL file on each deployment. Migration 015 creates/records a ledger entry but does not guard its full body with the already-applied check used by later migrations. Its replay includes `assert_file_hierarchy_valid(array_agg(id ORDER BY id))` over all files and related DDL/function/trigger work.

**Why it hurts.** An otherwise small application deploy can perform an account-independent whole-database hierarchy walk and allocate the complete ID array. Runtime and lock pressure grow with file count/depth. This is not a claim that every migration lacks a ledger; several expensive earlier/later migrations are already guarded.

**Recommended fix.** Add a correctly synchronized, one-time application guard for the immutable migration body, with a separate new migration for future changes. Move any intentionally repeated integrity audit into a bounded operational check that reports progress and does not gate every deployment on a full scan. Keep production safety preflight checks, but make their cost explicit and separately review their query plans.

**Acceptance test.** Replay migrations twice on a large fixture and trace statement execution, locks, and elapsed time. The second ordinary replay must skip the full hierarchy assertion while a fresh installation still validates and installs all constraints. Test concurrent deploy runners.

<a id="perf-038"></a>

### PERF-038 — P2 — A deployment removes old hashed worker URLs still referenced by open clients

**Area:** Deployment / worker assets  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [scripts/write-worker-assets.mjs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/scripts/write-worker-assets.mjs) — oldFiles deletion; generated asset manifest.
- [Dockerfile](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/Dockerfile) — copy current public assets into runtime.
- [src/features/vault/vault-client.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/vault/vault-client.ts) — lazy worker construction.
- [deployment/Caddyfile](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/deployment/Caddyfile) — immutable worker cache headers.

**What the code does.** Worker assets are content-hashed and correctly marked immutable. The generator deletes older hashes, and the image contains only the current public directory. An already open frontend can still hold an older generated worker URL and request it for the first time after a deployment.

**Why it hurts.** A cache miss for that older hash can produce a 404 and prevent crypto/upload/archive work until recovery or reload. Long cache lifetimes only help clients/intermediaries that actually cached the old file; they do not guarantee that every old lazy URL remains available.

**Recommended fix.** Publish immutable worker assets to a shared version-retaining asset store or retain a defined compatibility window of prior build assets. Pair asset version retention with controlled client/version recovery and the terminal-worker fix in PERF-028. Do not change an existing hashed file's contents. Test rolling deploy behavior rather than only verifying the newest asset.

**Acceptance test.** Open build A without loading a particular worker, deploy build B, then invoke that worker from A with an empty worker cache. It should load the matching immutable asset or fail into an explicit safe recovery flow, never hang indefinitely or run incompatible protocol code.

<a id="perf-039"></a>

### PERF-039 — P3 — Production worker bundles are bundled but not explicitly minified

**Area:** Build / browser worker delivery  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [package.json](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/package.json) — worker build esbuild commands.
- [scripts/write-worker-assets.mjs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/scripts/write-worker-assets.mjs) — hash/copy pipeline.
- [deployment/Caddyfile](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/deployment/Caddyfile) — existing worker compression.

**What the code does.** The reviewed esbuild worker commands bundle for the browser but do not enable minification. The following script fingerprints and copies those bytes; it does not minify them. Compression is already enabled by Caddy, so this is not a missing-compression finding.

**Why it hurts.** Cold worker downloads and parse/compile work can include avoidable bytes. The largest expected benefit is on the vault/dependency-heavy worker and slow/mobile clients, but actual compressed size and startup differences were not measured.

**Recommended fix.** Enable tested production minification before fingerprinting, emit an esbuild metafile for inspection, and retain appropriate license notices and private/debug source maps. Benchmark the actual generated compressed assets and worker startup. Verify crypto, dynamic imports, and worker-message protocols against the minified build; do not assume a successful bundle proves runtime compatibility.

**Acceptance test.** Compare raw/gzip/zstd sizes and cold preflight/startup time for all worker types. Run existing worker/crypto tests against the exact generated production bytes and update the tracked asset manifest deterministically.

**Runtime reference:** [esbuild — minification](https://esbuild.github.io/api/#minify).

## Observability and validation findings

<a id="perf-040"></a>

### PERF-040 — P2 — HTTP metrics stop before streamed bodies finish and infer bytes from headers

**Area:** Observability / latency measurement  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/main.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/main.rs) — request observation middleware.
- [backend/src/observability.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/observability.rs) — RequestObservation; HTTP metrics.

**What the code does.** The middleware records duration after the handler returns its response object, before a streaming response body is fully consumed. Request/response byte totals are derived from Content-Length, with absent lengths treated as zero, rather than counting actual payload bytes.

**Why it hurts.** Reported latency can look healthy while a download stalls, an SSE stream fails, or the client consumes only part of a response. Missing/chunked lengths distort throughput/accounting. For signed S3 redirects, the backend never sees most content bytes at all, so backend metrics alone cannot establish download speed.

**Recommended fix.** Keep handler/header latency as a separate metric and instrument stream completion, body bytes, errors, and cancellations with a body wrapper. For SSE track active streams, event age/delivery lag, reconnects, and termination reasons rather than treating a 25-minute connection as an ordinary slow request. Add browser transfer/crypto/sink timings and provider metrics for the direct S3 data plane. Keep metric label cardinality bounded.

**Acceptance test.** Serve a delayed/chunked local stream, disconnect midway, and complete a signed-S3 encrypted download. Confirm header and completion latency differ appropriately, actual bytes are correct, cancellations are counted, and client-side timing covers traffic invisible to Actix.

<a id="perf-041"></a>

### PERF-041 — P2 — Synchronous logging can amplify latency during error or slow-request bursts

**Area:** Observability / request-path I/O  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [backend/src/observability.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/observability.rs) — init_logging; log_request.
- [backend/src/observability.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/observability.rs) — default fmt writer setup.

**What the code does.** Logging initializes the default tracing formatting writer without an off-thread non-blocking appender. Successful requests are sampled, but all rejected requests, server errors, and slow requests are logged. An outage therefore increases log volume exactly when the service is under pressure.

**Why it hurts.** A slow stdout/container log drain can block the thread performing logging and worsen request latency. This is a conditional amplification mechanism; the current output sink's actual blocking behavior was not measured.

**Recommended fix.** Move operational log writes to a bounded off-thread sink, retain its shutdown guard, and expose queue depth/dropped-log counts. Aggregate or rate-limit repetitive operational warnings while preserving representative diagnostics. Keep security/audit records on a separately designed reliable path; do not silently discard required audit events under the guise of performance. Avoid an unbounded logging channel.

**Acceptance test.** Throttle the log consumer and generate repeated 4xx/5xx/slow responses in staging. Measure request-tail latency, log queue behavior, memory, and shutdown flush. Verify important incident/audit evidence is retained according to an explicit policy.

**Runtime reference:** [tracing-appender — bounded non-blocking writer](https://docs.rs/tracing-appender/latest/tracing_appender/non_blocking/index.html).

<a id="perf-042"></a>

### PERF-042 — P3 — Metrics exposition formats output while holding hot shared mutexes

**Area:** Observability / metrics contention  
**Confidence/conditions:** High for the lock lifetime; importance and further sharding are profile-gated.

**Where:**

- [backend/src/observability.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/observability.rs) — record_request; Metrics::render.

**What the code does.** Every request updates a shared HTTP BTreeMap under a mutex. Metrics rendering passes live lock guards into formatting helpers, keeping those mutexes held while building the Prometheus text representation. It also allocates method/route key strings during updates.

**Why it hurts.** A scrape can briefly serialize request observations across workers, especially as the number of metric series grows. At small cardinality this may be negligible; it should not outrank database/transfer fixes.

**Recommended fix.** Snapshot the bounded metric state under short locks, then format outside the critical section. If profiling still shows contention, use pre-registered route IDs and atomic/sharded metric storage rather than allocating labels on every request. Preserve bounded labels and accurate histogram semantics; do not introduce per-file/user metric labels.

**Acceptance test.** Measure hot-path mutex wait and request p99 with normal and frequent metrics scrapes at representative cardinality. Require a measurable reduction without inconsistent counters or unbounded state growth.

<a id="perf-043"></a>

### PERF-043 — P2 — The generic HTTP gate cannot establish mixed-load production capacity

**Area:** Validation / workload model  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [performance/http-load.mjs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/performance/http-load.mjs) — runRequests; successful-only percentile calculation.
- [.github/workflows/performance.yml](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/.github/workflows/performance.yml) — perf:http invocation and other existing gates.

**What the code does.** The generic harness defaults to `/health` and a fixed pool of sequential workers. It correctly consumes response bodies and fails on errors by default, but latency percentiles are computed for successful responses only, and it does not hold a fixed arrival rate as responses slow. CI also includes many useful database, auth-isolation, and realtime checks; those are not being dismissed as absent.

**Why it hurts.** A closed-loop health test can reduce its offered load when the service slows and does not exercise the expensive mixed workload identified in this audit. It cannot by itself demonstrate p99 browsing latency during encrypted publication, many SSE streams, maintenance, or long transfers.

**Recommended fix.** Retain this fast smoke test and add an arrival-rate-controlled mixed scenario with authenticated browsing, metadata, upload/publication, SSE, and maintenance. Report offered/started/completed work, dropped arrivals, error rate, success and failure latency, pool/gate waits, and client-visible completion. Use representative large/deep/shared datasets and repeatable provider latency/fault injection. Run destructive/load scenarios only in an isolated authorized environment.

**Acceptance test.** Demonstrate that the new gate fails when an injected DB/gate stall causes dropped arrivals or tail-latency regression even if mean successful latency looks acceptable. Include sustained runs long enough to observe retention/cleanup convergence and memory growth.

**Runtime reference:** [Grafana k6 — open and closed workload models](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/).

<a id="perf-044"></a>

### PERF-044 — P2 — The live backend latency job runs a debug build rather than the production release binary

**Area:** Validation / production equivalence  
**Confidence/conditions:** High: the mechanism is visible in the reviewed code; production impact is unmeasured.

**Where:**

- [.github/workflows/performance.yml](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/.github/workflows/performance.yml) — backend-and-database: Start API; production-image smoke.
- [Dockerfile](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/Dockerfile) — cargo build --release --locked.
- [backend/Cargo.toml](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/Cargo.toml) — release profile.

**What the code does.** The backend/database job starts `cargo run --locked` without `--release` before HTTP/auth/realtime live checks. The production image builds a release binary with thin LTO and one codegen unit, but its separate smoke job is not the same sustained latency workload.

**Why it hurts.** Latency gates and tuning decisions can be driven by debug-build CPU/allocation characteristics that differ from production. This does not mean production itself is running debug code; its Docker build is already optimized.

**Recommended fix.** Keep debug/unit workflows where useful, but run performance acceptance against the built production image or the exact release binary and configuration. Include the real Caddy-to-Actix/Next routing path, representative CPU/memory limits, and the direct-provider transfer path. Record artifact/commit identity alongside results so before/after comparisons refer to equivalent builds.

**Acceptance test.** Run the same workload against debug, release, and the production container once to establish the difference. Make future latency thresholds apply to the release artifact while correctness tests continue to cover their intended configurations.

## Implementation order and architecture

### 1. Remove avoidable waiting before increasing capacity

Start with PERF-001 and PERF-002. A client must return to the pool at the end of its database phase, not at the end of a long HTTP workflow. Add regressions that use deliberately small pools; these expose lifetime defects that a larger development pool hides.

A useful control-request shape is:

```text
bounded request admission
  -> authenticate / inexpensive authorization
  -> release DB client
  -> collect bounded control body with body-specific deadlines
  -> validate in bounded CPU class, when needed
  -> perform provider phase without a DB client
  -> acquire short DB transaction
  -> revalidate session / permissions / versions and commit durable state
  -> release DB client
  -> encode bounded response
```

This is a conceptual phase model, not permission to reorder a particular transaction blindly. Some operations must first commit an upload intent, then make a provider call, then finalize in another transaction. Preserve those durable state machines and distinguish a retryable failure from an ambiguous commit. Request cancellation must not abandon committed object/cleanup work.

In parallel, add the measurements in PERF-040 and PERF-044. Otherwise a change may merely improve the measured header time while actual transfer or queueing latency worsens.

### 2. Isolate latency classes without creating unbounded parallelism

Fix PERF-003 and PERF-005 together. Create bounded classes for interactive metadata/navigation, CPU validation, publication control, bulk tree/archive work, and maintenance. Reserve measured headroom for interactive operations, rather than putting everything behind the same two-slot recursive queue.

Use one explicit aggregate budget per scarce resource. Per-user/per-operation bounds are additional fairness controls, not substitutes for aggregate accounting. Track admission wait separately from service time. No operation should hold resource A while indefinitely waiting for resource B; document any required acquisition order. In particular, nested provider operations must not reacquire the same semaphore while holding all its outer permits.

Do not turn the default request DB pool of eight into hundreds of connections merely to disguise retention. Choose the pool size after measuring query service time and DB headroom. Across replicas, count request pools, maintenance pools, dedicated LISTEN/leadership connections, migrations, and operational connections against the database connection budget. Request and maintenance pool sizes are repository defaults, not verified production settings.

### 3. Make metadata and tree cost proportional to useful output

Address PERF-004, PERF-006, and PERF-007 as one metadata workstream: bounded authorized identity expansion, payload paging, stable continuation, and one-pass capped serialization. Shared ancestors should be resolved once, while key/permission dependencies remain explicit.

Address PERF-010 through PERF-013 as a write/read amplification workstream: coalesce ancestor changes, invalidate only affected repositories, avoid rebuilding totals on a navigation critical path, and prepare archive manifests once. Prefer bounded set-based SQL and explainable version fences over adding an unbounded cache.

For large tree changes, durable jobs need a product-level visibility contract. Returning 202 is not sufficient unless readers, counters, authorization, and later mutations agree on what an in-progress operation means. A root-level state fence plus resumable physical batches is one design to validate, not an automatic replacement for transaction atomicity.

### 4. Reduce realtime work at every layer

Backend user-level fanout/replay coalescing (PERF-014) and targeted browser invalidation (PERF-026) reinforce each other. Retain durable event ordering and a bounded replay-gap reset protocol. Separate session revocation from ordinary cosmetic/list updates so reducing idle SQL cannot weaken authorization.

Fix retry synchronization and unconditional reset work with PERF-025 and PERF-027. A saved cursor alone does not prove the initially rendered snapshot is current: use a snapshot/replay fence. Add backlog-aware pruning and retention-lag alerts before claiming that realtime storage is bounded under sustained traffic.

### 5. Optimize transfer critical paths while retaining encryption and byte budgets

Replace multipart batch barriers first (PERF-029); then evaluate per-file scheduling and small stage lookahead. Use measured bytes, ready work, and observed bottlenecks rather than simply increasing worker count.

Preserve the protocol's authentication, signed metadata, generation identity, checksum, and final-integrity requirements. Keep the current 256 MiB Argon2 configuration unless a separate security-reviewed protocol change justifies otherwise; reducing KDF strength is not a performance fix. Do not disable chunk authentication or Merkle validation to make preview/download graphs look faster.

For previews, reduce the amount of work before optimizing copying: PERF-033 before PERF-034. For downloads, distinguish first useful byte, sustained bytes/second, successful final verification, and time until a durable/save-ready result. A progress bar reaching 100% for encryption is not the same as the upload becoming durably published.

### 6. Bound background work and make deploys predictable

Apply PERF-016 through PERF-020 to create leader/fenced, resumable, fair maintenance work. Limit actual provider calls across workers. Report backlog age and convergence, not merely that a background task ran successfully.

Fix the migration replay and asset-version issues before relying on smooth rolling deployments. Then apply minification, bootstrap consolidation, conditional-read improvements, and metric-lock optimizations only where measurements justify them. Change connection recycling last and test stale-connection/network failures, not just the healthy path.

### Suggested repair batches

| Batch | Findings | Intended result | Required guardrail |
|---|---|---|---|
| A | 001, 002, 003, 040, 044 | Reliable short read/control latency and trustworthy timing | Small-pool tests, no unsafe mutation cancellation |
| B | 004–009, 021 | Bounded metadata and vault control work | Exact byte limits, valid permissions and continuation |
| C | 005, 010–015 | Scalable hierarchy/repository/realtime work | Atomic logical tree state, durable cursor/revocation semantics |
| D | 016–020, 037 | Predictable maintenance and deploy costs | Fenced workers, no premature cleanup/deletion |
| E | 025–030, 038, 039 | Faster startup/navigation/upload and deterministic worker recovery | No missed changes, protocol-compatible immutable assets |
| F | 022, 031–036 | Faster previews/downloads and less redundant client work | Authenticated ranges, bounded memory, final integrity |
| G | 023, 024, 041–043 | Lower overhead and sustained regression protection | Fault testing, bounded metrics/logs, production-equivalent load |

The table is a dependency-oriented execution proposal, not a claim that each batch should be one large unreviewable commit. Use small reviewable changes with separate correctness and performance evidence.

## Validation matrix

All scenarios below are proposed tests. **None was executed as part of this static audit.** Use isolated staging data and provider resources; do not generate disruptive production load.

### Reproducible baseline

Record the exact commit, release/container artifact, runtime versions, CPU and memory limits, replica count, database version/size/region, storage backend/region, effective queue/pool settings, browser/device, and network profile. Capture cold and warm cases separately. Keep the dataset and offered workload identical for before/after comparisons.

Use the existing repository correctness and security tests first. Then add representative latency/scale workloads rather than replacing those tests with a single benchmark. A failed correctness/integrity test rejects the performance change regardless of speed.

| Scenario | Dimensions to vary | Required evidence |
|---|---|---|
| Auth and control-body isolation | Pool 1/2/default; slow valid bodies; storage admission saturation | DB checkout/hold time, successful unrelated browse/auth, no leaked client |
| Folder navigation | Empty/50/100-entry page; warm/cold metadata; depth up to supported maximum | Click-to-visible-name p50/p95/p99, server requests, rows/buffers, UI long tasks |
| Metadata admission | Shared ancestors vs disjoint deep paths; maximum-valid records; multiple byte-limited pages | Peak API RSS, payload/SQL bytes, rows fetched before rejection, deterministic continuation |
| Bulk tree mutation | 10k/100k/1M nodes; simultaneous sibling operations; crash between batches | Logical atomicity, job recovery, DB transaction age, lock wait, WAL and memory |
| Repository detail/archive | Many unrelated repositories; 1k/10k/50k entries; early/middle/late pages | Recounts per mutation, total archive work, query plans and version-conflict correctness |
| Idle/active realtime | 1/100/2,048 streams; multi-tab/session users; replay gaps | SQL QPS, session-revocation delay, event-delivery lag, active streams, catch-up correctness |
| Realtime outage/recovery | Simultaneous disconnect; slow first frame; partial recovery | Combined poll/reconnect offered rate, jitter distribution, bounded recovery and no missed updates |
| Retention and maintenance | Empty queues; large unexpired trash; sustained event generation; slow S3 | Empty-pass query cost, backlog age, leader behavior, actual provider concurrency, convergence |
| Encrypted upload | Tiny-file sets; wide/deep folders; threshold/64/128 MiB/maximum files; one slow part | First-PUT delay, plaintext vs uploaded vs published progress, throughput, in-flight bytes, retry correctness |
| Encrypted/local download | Fast/slow network, CPU and disk; interruption and URL expiry | First byte, final verification/save-ready time, retransmitted bytes, sink/worker memory and cancellation |
| Repository preview | 2 MiB prefix in 100 MiB object; text/media/binary; corrupted chunks | Transfer bytes, first useful preview, long tasks, correct partial/full integrity status |
| Deployment | Large existing DB; replay; build-A tab through build-B deploy | Skipped one-time work, lock time, cold old-worker URL behavior, valid recovery |
| Observability | Slow log drain; frequent scrapes; chunked/canceled streams | Hot-path mutex/writer stalls, dropped-log visibility, correct byte and completion measurements |
| Mixed sustained load | Fixed offered browse/publication/realtime arrival rate plus maintenance | p95/p99 by journey, started/completed/dropped work, errors, throughput, memory and backlog trends |

### Essential measurements

**Backend:** request admission wait, DB checkout wait and hold duration, query count/time/rows, recursive/CPU/provider queue wait, handler/header latency, body-completion latency, SQL lock/transaction age, rows and WAL per mutation, process RSS/CPU, event-loop blocking, and actual provider requests/retries/in-flight count. Use bounded route/query-operation labels rather than user IDs, file IDs, or raw SQL strings.

**Browser:** route start to useful list, time to decrypted filenames, cold worker initialization, crypto/session queue wait, selected-to-first-PUT, durable publish completion, preview first paint, download verification/save-ready time, long tasks, transferred bytes, and retained-buffer memory where the browser supports observing it. Never include keys, plaintext names/content, or signed URLs in exported telemetry.

**Background:** oldest runnable job, oldest event awaiting prune, completed jobs/second, retries/dead letters, leader/lease age, scan checkpoint progress, physical-usage sample age, and fairness between worker classes. A successful loop invocation is not proof that its queue is keeping up.

### Query-plan procedure

Run EXPLAIN (ANALYZE, BUFFERS) only on safe read queries or isolated fixtures; ANALYZE actually executes a statement. Capture plans for realistic data skew and early/late pages, including warm/cold caches when relevant. A LIMIT in SQL or a “bounded” unit-test name is not proof that the expensive work below it is bounded. Check actual rows, loops, sorts/spills, temporary I/O, and buffers. Preserve query-contract and mutation-contract tests after rewriting SQL.

### Acceptance policy

Agree on target journey-specific p95/p99 budgets and supported concurrency before tuning. This report intentionally does not invent a universal 50 ms/100 ms threshold or promise a percentage improvement without hardware, region, or workload measurements. A change is accepted when it improves its target metric at equivalent offered load, does not move the bottleneck into another resource class, and passes integrity/recovery tests. Evaluate peak memory, errors, fairness, and backlog convergence alongside latency.

## Existing optimizations not reported as missing

The following are visible in the inspected implementation and should generally be retained:

- **Direct S3 upload/download data paths and bounded provider request policies.** Sources: [backend/src/storage.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/storage.rs); [backend/src/routes/vault.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/vault.rs); [src/features/vault/encrypted-upload.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/vault/encrypted-upload.ts).
- **Caddy routes API requests directly to Actix and already compresses appropriate text/worker formats.** Sources: [deployment/Caddyfile](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/deployment/Caddyfile).
- **Request-scoped principal/connection reuse, a separate maintenance pool, bounded admission, and DB statement/lock timeouts.** Sources: [backend/src/auth.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/auth.rs); [backend/src/db.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/db.rs); [backend/src/state.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/state.rs).
- **Password work releases DB resources and uses bounded CPU work; do not restore DB-held bcrypt waits.** Sources: [backend/src/auth.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/auth.rs).
- **Dashboard session reads already use React request-scoped cache and parallel auth/CSRF fetching.** Sources: [src/features/dashboard/dashboard-session.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/dashboard/dashboard-session.ts).
- **Crypto messages transfer ArrayBuffers; a worker already isolates client cryptography.** Sources: [src/features/vault/vault-client.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/vault/vault-client.ts); [src/features/vault/vault.worker.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/vault/vault.worker.ts).
- **Encrypted downloads already support file-system/OPFS output and a bounded in-memory fallback.** Sources: [src/features/vault/encrypted-download.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/vault/encrypted-download.ts).
- **Encrypted uploads already retry provider PUTs and refresh signed URLs; the reported missing recovery is on downloads.** Sources: [src/features/vault/encrypted-upload.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/vault/encrypted-upload.ts).
- **Folder/list pagination, metadata batching, denormalized counters, bounded tree-query batches, and realtime coalescing already exist; several findings concern where their bounds are applied.** Sources: [backend/src/routes/files.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/files.rs); [backend/src/routes/tree_walk.rs](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/src/routes/tree_walk.rs); [database/init/014_navigation_hot_paths.sql](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/database/init/014_navigation_hot_paths.sql); [src/features/realtime/changes.ts](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/src/features/realtime/changes.ts).
- **Production Rust already uses a release build, thin LTO, and one codegen unit.** Sources: [Dockerfile](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/Dockerfile); [backend/Cargo.toml](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/backend/Cargo.toml).
- **CI already contains frontend, SQL/migration, auth-isolation, realtime, and production-image smoke checks.** Sources: [.github/workflows/performance.yml](https://github.com/AdminGodZ/Aeralyth/blob/fe9556cf9f011297e16500f18cdf04b991b35635/.github/workflows/performance.yml).

The existing repository audit was used as a lead, not as proof of the current state. Completed historical findings were not simply copied back into this report. Conversely, a “completed” note does not establish that a newly introduced path has the same optimization.

## Coverage and remaining verification

### What was inspected

The review pinned one commit and traced representative high-impact end-to-end paths: authenticated folder reads, encrypted metadata, vault setup/migration and upload control, encrypted upload/download, repository preview/detail/archive, realtime dispatch/replay/browser refresh, hierarchy/counter migrations, selected storage maintenance workers, production startup/routing/migrations, worker builds, metrics/logging, and CI/load gates.

This is **not a line-by-line review of every repository file**. In particular, the very large vault, files, repositories, and storage modules were read in targeted ranges. Tree/source search helped discover callers but is not a guarantee that all call sites were returned by the connector index. No hidden/unreturned code was treated as if it had been inspected.

| Scope | Inspection boundary |
|---|---|
| Backend core | Runtime portions of auth, DB, state/admission, main middleware, bucket usage, realtime, collection timestamps, and observability; E2EE protocol constants checked |
| `routes/vault.rs` | Targeted constants/query, status/migration, account setup/rewrap, upload-init/presign/publication, metadata/download/share-plan ranges; not the entire large module |
| `routes/files.rs` | Initial/list/upload-init, folder-manifest, archive/download, tree restore/delete, and folder-context ranges plus caller search; not every sharing/mutation branch |
| `routes/repositories.rs` | Query definitions and index/detail/count/archive ranges; not every endpoint/test |
| `storage.rs` | Constants/queries, selected S3 methods, scheduler/next-due, deletion phases, expired-vault cleanup, multipart reconciliation and helpers; not every maintenance/test branch |
| Other backend routes | Tree-walk runtime and conditional responses directly reviewed; admin, profile, invitations, avatar, share-links, and other helpers were not comprehensively line-reviewed |
| Frontend | Vault client/transfers/bounded-async, repository file loader, realtime connection/provider/changes, server API/session wrappers, worker entry/selected file-list code, build scripts |
| Frontend coverage limits | No complete UI/browser bundle audit, browser run, full worker/provider/resolver review, or line-by-line audit of large upload, sharing, profile, and admin components |
| Database | Migrations 014, 015, 026, 027 directly reviewed; migration/deployment inventory and existing test coverage inspected, not every migration/query plan |
| Build/deployment/tests | Docker, Caddy, Railway/start/migration scripts, package/worker build pipeline, HTTP harness, CI workflow read; no builds, CI execution, deployment inspection, or benchmark runs |

### Not promoted to confirmed findings

The following require further evidence rather than confident claims of a defect:

| Question | Evidence needed before a change |
|---|---|
| Are pool sizes or Actix worker counts too small/large in production? | Effective configuration, CPU quota, DB wait/service times, connection budget, and an arrival-rate load test |
| Would a different PostgreSQL index help a particular listing/admin/search query? | Full current DDL plus representative EXPLAIN plans and write/storage cost; do not add speculative indexes everywhere |
| Are all metadata caches bounded, correctly evicted, and cheap on invalidation? | Complete provider/resolver/worker/cache review and long browser memory traces |
| Are dependencies or route chunks unnecessarily shipped to common pages? | Production bundle/metafile analysis and browser network traces, not source file size alone |
| Does the preview always do avoidable hex/highlighting work? | Renderer/type-helper call paths and measured CPU; the loader alone does not establish the formatter's internal bounds |
| Are shared-plan helper waves or crypto operations the dominant serialization bottleneck? | Complete helper/session implementation and timing across IPC, crypto, SQL, and provider stages |
| Are object-storage/DB regions, DNS/TLS, or CDN behavior causing most latency? | Actual deployment topology and measured RTTs; they cannot be established from repository code alone |
| Would HTTP/3, PGO, a different allocator, more replicas, or a language rewrite improve speed? | A demonstrated relevant bottleneck and controlled production-equivalent measurements, not a generic recommendation |

These boundaries are why “every single P0–P3 issue” cannot be certified by this source pass. The report provides a concrete prioritized repair backlog, not a claim that fixing 44 entries automatically reaches a hardware-independent maximum.

### Source and evidence conventions

All repository links point to the audited commit, not moving `master`. External runtime references are primary documentation checked during the audit; they explain semantics and recommendations, not Aeralyth-specific production measurements. Arithmetic examples are intentionally limited to visible constants and query structure. Suggested fixes and acceptance tests are proposed engineering work, not changes already made or tests already passed.

**Bottom line:** Fix the connection lifetimes and interactive/bulk coupling first, then make metadata/tree/realtime work proportional to useful output, then improve transfer staging and background convergence. Measure browser-visible completion on the release deployment path throughout.
