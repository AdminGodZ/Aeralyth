
# Aeralyth Performance and Latency Audit

**Repository:** `AdminGodZ/Aeralyth`  
**Audited branch:** `master`  
**Audited commit:** `8d6991bafd7161d33742b719fc0057f6cf85348c`  
**Audit date:** 2026-08-10  
**Primary focus:** Rust/Actix backend, PostgreSQL schema, S3 upload lifecycle, encrypted vault protocol, and browser upload/download pipelines

## Scope and confidence

This is a static, end-to-end code and schema audit. I reviewed every Rust source module under `backend/src`, every SQL initialization/migration file under `database/init`, all route registrations, the storage maintenance worker, and the browser code that drives legacy uploads, encrypted uploads, encrypted downloads, vault cryptography, folder ZIP creation, and repository ZIP downloads.

The audit establishes call counts, locking behavior, allocation/copy behavior, query shape, asymptotic complexity, and concrete correctness hazards from the source. It does **not** include production traces, `EXPLAIN (ANALYZE, BUFFERS)` output, real table cardinalities, S3 provider latency, browser heap profiles, or a load test against the deployed environment. Exact millisecond improvements therefore need measurement. The architectural and algorithmic findings below do not depend on those measurements.

Severity:

- **Critical:** Can destroy or leak uploaded data, or is a protocol-level scaling blocker.
- **P0:** Dominant bottleneck that should be fixed before serious scale testing.
- **P1:** High-impact latency, throughput, memory, or contention problem.
- **P2:** Material issue at moderate or large scale.
- **P3:** Tuning or micro-optimization. Implement only after metrics confirm it.

Confidence:

- **Confirmed:** Directly demonstrated by the current control flow, SQL, or allocation pattern.
- **Plan-dependent:** Impact depends on production cardinality or provider behavior, but the risk is concrete.
- **Tuning:** Requires measurement before changing defaults.

## Executive verdict

Aeralyth already has several good architectural choices: file bytes normally move directly between the browser and S3, encrypted data remains client-side encrypted, upload state is persisted, cleanup is durable, and many listing queries use purpose-built indexes. The dominant performance problem is not Rust itself. It is **multiplication of work across boundaries**:

1. One logical operation often becomes many browser-to-Next-to-Rust requests.
2. Each request often performs authentication twice and checks out several different PostgreSQL connections.
3. Bulk vault operations are implemented as one awaited SQL statement per row.
4. Browser encryption and download assembly repeatedly copy large buffers.
5. Recursive tree summaries and authorization are recomputed from the entire subtree on ordinary navigation.
6. Share metadata grows with both recipient count and subtree size.

The highest-return redesign is to make each logical operation set-based and pipeline-oriented:

- Authenticate once per request.
- Reserve quota with one atomic ledger update.
- Presign parts in batches.
- Keep at most a small bounded number of preallocated part buffers.
- Insert wrappers/envelopes with `COPY` or set-based batches.
- Replace repeated wrapper-hash arrays with a Merkle-root commitment.
- Keep maintenance outside the request pool and process object work concurrently in bounded batches.
- Maintain tree and usage summaries incrementally instead of rescanning.

## Static cost model

These numbers are derived from the current source and illustrate why the top findings dominate:

| Operation | Current static cost |
|---|---:|
| 2 GiB encrypted upload, 32 MiB parts | 64 part-control HTTP requests |
| Minimum SQL lookups per encrypted part control request | Approximately 3: user/session, CSRF/session, upload row |
| Minimum part-control SQL work for that 2 GiB upload | Approximately 192 SQL operations, excluding initialization and completion |
| 2 GiB legacy upload, 64 MiB default parts | 32 part-control requests and approximately 96 SQL operations |
| Construct one 32 MiB encrypted part from eight 4 MiB chunks | Roughly 144 MiB of accumulator copying, 112 MiB of zeroing, and about 96 MiB of additional full-part copies before or during checksum/upload |
| Assemble one 4 MiB download chunk from 64 KiB network chunks | Roughly 130 MiB of cumulative copying plus 126 MiB of zeroing before later copies |
| 4,096 wrapper hashes in one envelope | 128 KiB raw, roughly 171 KiB after base64, per recipient, before the rest of the envelope |
| 50 recipients with that hash list | More than 8 MiB for hashes alone, exceeding the global JSON body limit before wrappers and signatures |

Browser network chunk sizes vary, so the download-copy figure is an example rather than a constant. The quadratic accumulator pattern itself is confirmed.

---

# Findings

## PERF-001 [Critical] Multipart orphan reconciliation can abort active encrypted vault uploads

**Status:** Complete — implemented and verified on 2026-08-10.

**Confidence:** Confirmed

**Evidence:** `backend/src/storage.rs`, in the multipart reconciliation path, matches live S3 multipart uploads against `file_uploads`. Encrypted uploads are tracked in `vault_uploads` and use the same general user/object namespace. The default orphan grace is one hour while vault upload intents can remain valid for 24 hours.

**Impact:** A long-running encrypted upload can be classified as an orphan and aborted by maintenance even though its database intent is valid. This is both a data-integrity defect and a severe performance failure because the client must restart encryption and transfer.

**Best solution:** Immediately make reconciliation query a union of `file_uploads` and `vault_uploads`, matching both `object_key` and `multipart_upload_id`. Prefer separate object prefixes such as `users/{id}/legacy-uploads/` and `users/{id}/vault-uploads/` so each reconciler has an unambiguous ownership domain. Add a database lease or intent generation and never abort an unknown multipart upload until both the provider age and the appropriate intent TTL have elapsed. Also configure an S3 lifecycle rule as a final safety net, not as the primary live-intent check.

**Validation:** Create a multipart vault upload, hold it open for longer than the orphan grace, run reconciliation repeatedly from two backend replicas, and prove that the upload remains present and can publish successfully.

## PERF-002 [Critical] Share envelopes duplicate the complete wrapper-hash set for every recipient

**Status:** Complete — implemented and verified on 2026-08-10.

**Confidence:** Confirmed

**Evidence:** `src/features/vault/vault.worker.ts` builds all subtree wrappers, hashes every wrapper, and places the complete `wrapperHashes` array in each HPKE envelope. `backend/src/e2ee.rs` decodes that array, while vault routes validate and store each recipient envelope.

**Impact:** Time, memory, request size, response size, signature work, database storage, and verification scale approximately as recipients multiplied by subtree wrappers. The 8 MiB JSON limit makes the nominal large-recipient/large-subtree limits impossible in practice. Shared downloads also carry and process a large envelope for each node.

**Best solution:** Define a protocol-v2 share epoch that commits to the wrapper set once. Store `wrapper_set_root`, `wrapper_count`, and a domain-separated Merkle root or canonical aggregate hash in the signed epoch/envelope. Each recipient envelope should contain only that 32-byte commitment. A node download should return its one or two wrappers plus Merkle proofs, reducing verification from O(all subtree wrappers) to O(log wrappers). Keep the full wrapper rows server-side and validate the set root once during publication.

**Validation:** Benchmark 1, 10, 100, 1,000, and 4,096 wrappers with 1, 10, and 100 recipients. Request size and recipient-envelope size should become effectively constant, and per-node download metadata should grow only logarithmically.

## PERF-003 [Critical] User deletion is synchronous, unbounded, and omits active vault-upload cleanup

**Status:** Complete — implemented and verified on 2026-08-10.

**Confidence:** Confirmed

**Evidence:** `backend/src/routes/admin.rs::delete_user` expands object deletion jobs, cascades user metadata, and commits the entire deletion in the request. Its upload cleanup covers `file_uploads` but not active `vault_uploads`. Large cascades also fire row-level counter triggers.

**Impact:** Deleting a large account can hold locks and a pool connection until the 10-second statement timeout, generate large WAL bursts, block unrelated mutations, and leave encrypted upload objects or multipart sessions behind.

**Best solution:** Change deletion into a state machine. Mark the user `deleting` in a short transaction, revoke sessions, then let a dedicated worker enumerate `files`, `file_uploads`, `vault_uploads`, `vault_object_generations`, migration keys, and share material in bounded batches. Persist a cursor/checkpoint and make each phase idempotent. Delete the user row only after all object jobs are durable. Use `COPY` or set-based `INSERT ... SELECT` for deletion jobs.

**Validation:** Delete synthetic accounts with 10, 10,000, and 1,000,000 metadata rows while normal uploads run. The API response should remain bounded, no request should hold a large transaction, and all S3 multipart/object keys must be accounted for.

## PERF-004 [P0] Node publication cost grows with every overlapping active share

**Status:** Complete — implemented and verified on 2026-08-10.

**Verification:** Real encrypted owner and recipient browser flows kept owner bootstraps at 207 bytes with exactly one owner wrapper both without shares and beneath an active share. The shared child was published first, then its durable background job produced a signed 134-byte directory and two proof-bearing wrappers; the recipient successfully decrypted it and the job cleared. A rollback-only `EXPLAIN (ANALYZE, BUFFERS)` probe at 0, 1, 10, 100, and 1,000 overlapping shares kept the indexed overlap check between 0.025 ms and 0.065 ms.

**Confidence:** Confirmed

**Evidence:** The encrypted uploader fetches active share contexts for a parent and creates share wrappers for every active context. The node bootstrap commits all wrapper IDs and hashes. Therefore ordinary file publication becomes proportional to the number of shares covering that node.

**Impact:** A frequently updated file inside many overlapping shares pays repeated key derivation, encryption, base64, JSON, signature, verification, and row insertion for every share. This makes ordinary writes progressively slower as sharing grows.

**Best solution:** Decouple owner node records from share-specific wrappers in protocol v2. The owner record should commit only owner key material and a versioned share-wrapper directory root. Each share epoch should own its wrapper set and per-node proofs. Updating a node should update only affected share sidecars, preferably asynchronously or in a bounded batch, without rewriting a monolithic owner bootstrap.

**Validation:** Create one node under 0, 1, 10, 100, and 1,000 overlapping shares. Owner-record size and base publication latency should remain close to constant.

## PERF-005 [P1] An exact 32 MiB encrypted object is forced through a one-part multipart upload

**Status:** Complete — implemented and verified on 2026-08-14.

**Verification:** Encrypted upload planning and S3 preparation now share one `uses_vault_multipart_upload` predicate whose boundary is strictly greater than 32 MiB. The regression test covers ciphertext lengths one byte below, exactly at, and one byte above the fixed part size; only the last selects multipart. Both backend decision sites call that predicate, preventing their thresholds from drifting apart.

**Confidence:** Confirmed

**Evidence:** The encrypted upload mode uses a `>= UPLOAD_PART_BYTES` threshold, with `UPLOAD_PART_BYTES` equal to 32 MiB.

**Impact:** A 32 MiB object pays create-multipart, part presigning, one part PUT, complete-multipart, reconciliation complexity, and metadata verification instead of one presigned PUT.

**Best solution:** Use multipart only when ciphertext length is strictly greater than the fixed part size, or enforce a threshold of at least two parts. Keep the legacy threshold independently configurable.

**Validation:** Upload payloads producing ciphertext lengths one byte below, exactly at, and one byte above 32 MiB. Only the last case should use multipart.

## PERF-006 [P1] Idempotent migration scripts perform global backfills and counter rebuilds

**Status:** Complete — implemented and verified on 2026-08-14.

**Verification:** The base auth and E2EE migrations are now immutable, transactionally serialized with migration-specific PostgreSQL advisory locks, and recorded in `schema_migrations` only after success. An isolated PostgreSQL replay test applied both files twice while statement-level audit triggers watched application tables; the second pass retained both ledger versions and produced zero user, file, share, upload, invitation, or counter writes. The fresh performance-ledger migration suite also passed after replaying the guarded base migrations. A source contract test and migration policy prevent future global data work from being appended to routine replay paths.

**Confidence:** Confirmed

**Evidence:** `database/init/001_auth.sql` updates every `file_shares` row, expires invitations, deduplicates pending invitations, rebuilds every user counter from `users`, `files`, and `file_shares`, and rebuilds global admin counters. `002_e2ee.sql` explicitly states that it is intended to run on every deploy.

**Impact:** Deployment/migration time and lock pressure grow with total data. A routine schema deployment can become a production-wide scan and rewrite.

**Best solution:** Adopt versioned, one-time migrations with a schema history table. Separate DDL from online backfills. Run large backfills in keyset batches with progress checkpoints, and validate drift without rewriting unchanged rows. Never use a full counter reconstruction as a normal deployment step.

**Validation:** Run each migration twice against a large fixture. The second run should be nearly constant-time and should not update application rows.

## PERF-007 [P0] Authentication and CSRF are separate database queries on nearly every mutation

**Status:** Complete — implemented and verified on 2026-08-10.

**Verification:** Upload control routes now use a slim request-local `SessionPrincipal`, and CSRF validation reuses that principal without querying PostgreSQL again. The `session_principal_is_loaded_once_per_request` regression test calls authentication twice on one request and proves that the loader runs exactly once.

**Confidence:** Confirmed

**Evidence:** `backend/src/auth.rs` loads the current user from the session, and `require_csrf` performs another session query. Multipart part-presign endpoints call both.

**Impact:** Every small control request pays two session-table round trips before its own upload query. A 64-part upload amplifies this into a large fraction of all database traffic.

**Best solution:** Introduce an Actix middleware or custom extractor that validates the session once and attaches a slim `SessionPrincipal` containing user ID, role, status, session ID, CSRF token/version, and only the flags required by the route. Validate header CSRF against that principal without another SQL query. Fetch the full profile only for `/me` and profile pages.

**Validation:** Instrument SQL calls per route. Authenticated mutation endpoints should use one session lookup total, and part-presign batches should not repeat session work per part.

## PERF-008 [P1] Every ordinary authenticated request fetches full profile fields and a vault-existence subquery

**Status:** Complete — implemented and verified on 2026-08-14.

**Verification:** Files, repositories, share links, vault operations, profile mutations, and ordinary admin authorization now use the request-local `SessionPrincipal`, whose SQL selects only session ID, CSRF token, user ID, role, and status. Full profile and vault configuration loading is confined to login and explicit session-profile responses. Query-shape and route-source regression tests reject profile columns, `user_vaults`, or full-profile authentication in ordinary route modules. In a matched isolated PostgreSQL benchmark with 10,000 warm samples per query, the returned row fell from 168 to 109 bytes and p95 database time fell from 7 µs to 4 µs; these are local comparative measurements, not a production-wide latency claim.

**Confidence:** Confirmed

**Evidence:** `current_user` selects display preferences, profile-image metadata, and `EXISTS` against `user_vaults`, even for upload part signing and other routes that need only a user ID.

**Impact:** This increases row decoding, query planning/execution work, and response-object allocation on the hottest path.

**Best solution:** Split `SessionPrincipal` from `AuthUserProfile`. The principal query should select only stable authorization fields. Keep vault configuration in the endpoint query or a versioned session flag if required. Load display/profile settings lazily.

**Validation:** Compare query width, returned bytes, and p95 auth latency before and after. Part signing should not touch profile columns.

## PERF-009 [P0] Multipart presigning is one authenticated API request per part

**Status:** Complete — implemented and verified on 2026-08-10.

**Verification:** Legacy and encrypted upload clients presign bounded batches of eight parts, with server endpoints accepting at most 32. A live local S3-compatible multipart upload returned eight ordered 32 MiB part URLs from one authenticated request, and a duplicate-part batch was rejected with HTTP 400.

**Confidence:** Confirmed

**Evidence:** Both legacy and vault clients request a URL for every part. Each request traverses Next.js, Actix, session validation, CSRF validation, upload-row validation, and AWS presigning.

**Impact:** For a 2 GiB encrypted file at 32 MiB parts, this is 64 control requests before completion. High-bandwidth users become control-plane bound rather than network bound.

**Best solution:** Add a batch endpoint such as `POST /uploads/{id}/parts:presign` accepting 8 to 32 `{partNumber, checksum}` entries. Validate the upload once and return all signed URLs. An alternative is a short-lived HMAC upload capability that permits lightweight stateless checks, but batching is simpler and easier to audit. Keep batches small enough that URLs do not expire before use.

**Validation:** Measure control requests and SQL statements per GiB. Target no more than one batch request per 8 to 32 parts.

## PERF-010 [P1] All API control traffic takes an extra Next.js proxy hop

**Status:** Complete — implemented and verified on 2026-08-14.

**Verification:** Production browser URLs remain same-origin `/api/*`, but Vercel now routes that namespace from its ingress layer straight to the configured Actix origin; the production Next configuration returns no API rewrite unless the standalone-server compatibility escape hatch is explicitly enabled. `next dev` retains the local proxy automatically. In matched 500-request, 20-concurrency local samples, direct Actix routing measured `2.11 ms` p50 and `3.04 ms` p95 versus `7.78 ms` p50 and `11.90 ms` p95 through the Next development proxy, with zero errors in both samples. Routing contract tests cover the real Next and Vercel configurations, run in the performance workflow, and the isolated production build passed.

**Confidence:** Confirmed

**Evidence:** `next.config.ts` rewrites every `/api/:path*` request to the Rust origin.

**Impact:** The extra process hop adds scheduling, parsing, headers, buffering risk, connection-pool behavior, and tail latency. It is especially visible when one upload emits dozens of small control calls.

**Best solution:** At the ingress/load balancer, route `/api/*` directly to the Rust service and route page/static traffic to Next.js. Preserve one public origin for cookies and CSP. Batch presigning remains necessary because removing one hop does not remove request amplification.

**Validation:** Compare p50/p95 latency for a no-op authenticated API endpoint through the rewrite and through direct ingress routing.

## PERF-011 [P0] Database helpers acquire a new pooled connection for every query

**Status:** Complete — implemented and verified on 2026-08-12.

**Verification:** All request-side database helpers now share one lazily checked-out, prepared-statement-caching connection per Actix request, and an explicit transaction can take ownership of that same connection. Slow storage, request-body, download, and cryptographic phases explicitly release the request connection. Live login, `/api/auth/me`, and multi-query file-list requests each logged exactly one pool checkout; upload initialization deliberately used a second checkout only after releasing the reservation phase before provider preparation. A regression test proves one initialization and safe transaction handoff.

**Confidence:** Confirmed

**Evidence:** `backend/src/db.rs` calls `pool.get()` inside every `query`, `query_one`, `query_opt`, and `execute`. Multi-step handlers therefore check out and release different connections repeatedly unless they manually open a transaction.

**Impact:** This adds pool synchronization and wait opportunities, prevents easy pipelining, and lets logically related reads observe different snapshots. Under bursts, a small pool becomes a latency queue.

**Best solution:** Refactor data-access functions to accept `&(impl GenericClient)` or explicit `Client`/`Transaction`. Acquire one request-scoped connection for multi-query handlers, or combine queries. Keep transactions short, but do not reacquire the pool for every statement.

**Validation:** Record pool checkouts per request. Multi-step read handlers should normally perform one checkout.

## PERF-012 [P0] Upload initialization scans reservations redundantly

**Status:** Complete — implemented and verified on 2026-08-12.

**Verification:** Legacy and encrypted initialization now reserve against a dedicated `user_storage_usage` ledger with one conditional primary-key update in the same transaction as intent insertion; no upload-table `SUM` remains on either initialization path. Signed net-growth credits are locked for replacements/migrations, the pending limit covers both upload types, and statement-level terminal/delete triggers release bytes and intent counts exactly once. Forty simultaneous PostgreSQL clients competing for ten quota slots admitted exactly ten, left `100` reserved bytes and `10` intents, and released both to zero on one terminal transition. The real API lifecycle moved `0/0/0` to `0/1024/1` on init and `1024/0/0` on publish (`used/reserved/pending`); a final live init/abort check independently returned the ledger to `0/0/0`.

**Confidence:** Confirmed

**Evidence:** Legacy initialization calculates reserved bytes before entering the transaction, then locks the per-user counter and recomputes pending bytes/count. Vault initialization also sums pending legacy and vault uploads while holding the counter lock.

**Impact:** Initialization latency grows with a user's upload-intent history. It performs duplicate work and extends the critical section that serializes upload starts.

**Best solution:** Maintain `reserved_bytes` and `pending_uploads` in a storage-usage ledger. Reserve capacity with one atomic conditional update inside the same transaction as intent insertion: `UPDATE ... SET reserved_bytes = reserved_bytes + $n, pending_uploads = pending_uploads + 1 WHERE used_bytes + reserved_bytes + $n - replacement_credit <= quota AND pending_uploads < limit RETURNING ...`. Release the reservation exactly once on publish or abort.

**Validation:** Use concurrent upload-init tests and prove that quota cannot be exceeded, no full `SUM(file_uploads)` appears in the plan, and init latency remains flat as historical intents grow.

## PERF-013 [P1] One per-user counter row serializes upload starts and many file mutations

**Status:** Complete — implemented and verified on 2026-08-14.

**Verification:** Upload admission now serializes only one short conditional update on the dedicated `user_storage_usage` quota ledger; favorite, trash, share, and UI count changes remain on the separate statement-aggregated `user_file_counters` row. A 40-client PostgreSQL burst admitted exactly ten quota-limited uploads, recorded zero writes to `user_file_counters`, and measured the reservation statement at `8.104 ms` mean and `12.757 ms` maximum across all 40 contending calls before releasing the ledger back to zero. The concurrency test now fails on any UI-counter write, missing measurement, incorrect admission/release result, or network-scale SQL regression, and runs in CI.

**Confidence:** Confirmed

**Evidence:** Upload initialization locks `user_file_counters`; file and share triggers also update the same row. Bulk trash/restore and concurrent upload starts target one hot tuple.

**Impact:** A single active user can self-contend even when PostgreSQL and S3 have spare capacity. The row becomes a WAL and lock hotspot.

**Best solution:** Separate storage reservation/accounting from UI counters. Keep one atomic storage ledger if strict quota requires it, but do not route favorite, trash, and unrelated metadata through the same tuple. If one user must start many uploads concurrently, reserve in small sharded buckets and reconcile against a strict aggregate, or serialize only the short conditional ledger update.

**Validation:** Track row-lock wait time by relation and tuple-heavy query. Concurrent starts should spend microseconds, not network-scale time, in the quota critical section.

## PERF-014 [P1] Folder creation opens one transaction per path component

**Status:** Complete — implemented and verified on 2026-08-14.

**Verification:** Legacy folder uploads now send one normalized folder manifest before file transfer. The backend deduplicates shared prefixes, resolves the entire tree in one transaction, and calls a set-based PostgreSQL primitive once per unique depth; a partial unique active-sibling index plus `ON CONFLICT` makes retries and concurrent creation idempotent. Each subsequent upload sends the already-resolved parent and basename, while the old per-file path contract remains as a compatibility fallback. A live 1,000-file tree with one shared three-level prefix returned all 1,000 parent mappings with exactly three SQL calls (`2.061 ms` mean, `3.984 ms` maximum), rather than 3,000 transactions. SQL guards prove one UI-counter write per inserted depth and zero writes/duplicates on replay, including case variants; fresh migration, HTTP idempotency, client contract, and Rust prefix-planning tests all pass in CI.

**Confidence:** Confirmed

**Evidence:** `backend/src/routes/files.rs::ensure_folder` takes an advisory lock, queries a child, optionally inserts it, and commits for each segment.

**Impact:** Uploading deep directory trees scales with total path depth, not only file count. Repeated shared prefixes are looked up and locked again for every file.

**Best solution:** Create the selected folder hierarchy once. Normalize all paths client-side, send a batch tree manifest, and insert missing nodes in one transaction using a staging table plus recursive/set-based SQL. At minimum, cache resolved `(parent, normalizedName) -> id` entries for the current upload batch and rely on a unique active-sibling index with `INSERT ... ON CONFLICT ... RETURNING` rather than advisory locking.

**Validation:** Upload 1,000 files under shared paths of depth 10. Folder SQL statements should be close to the number of unique folders, not 10,000.

## PERF-015 [P1] Successful multipart completion always performs an additional S3 HEAD

**Status:** Complete — implemented and verified on 2026-08-14.

**Verification:** `complete_multipart` now returns the provider's ETag and checksum together with the already-validated expected length. Both legacy-file and encrypted-vault completion paths consume that response directly, so normal successful multipart completion contains no HEAD request; metadata lookup remains only for direct single-object uploads and ambiguous completion-error reconciliation. Rust regression guards inspect both completion call paths and fail if a normal multipart HEAD is reintroduced, and the full backend suite plus strict Clippy passed.

**Confidence:** Confirmed

**Evidence:** The storage completion helper discards useful `CompleteMultipartUpload` response metadata, and upload routes then call `object_metadata` to verify the completed object.

**Impact:** Every successful multipart upload adds another provider round trip at the most latency-sensitive point.

**Best solution:** Return ETag/checksum/version information from the completion call. The server already knows expected length and validated part layout. Use HEAD only when completion returned an ambiguous transport error, during reconciliation, or when a provider does not return required metadata.

**Validation:** Provider-call traces should show no HEAD on the normal successful completion path.

## PERF-016 [P1] Completion polling can turn into repeated S3 verification

**Status:** Complete — implemented and verified on 2026-08-14.

**Verification:** Upload status is now a database-only endpoint and cannot access object storage. Ambiguous completion is owned by a dedicated one-second maintenance worker that atomically claims rows with `FOR UPDATE SKIP LOCKED`, leases one claimant, persists attempt count, next retry, last error, verified checksum/ETag, and applies bounded exponential backoff with stable jitter. Route and worker share one replacement-aware finalization transaction, while expired pending cleanup no longer races completing uploads. Migration `009-upload-completion` passed a clean-schema apply and replay, and regression tests fail if polling regains metadata/finalization calls or claimant/error persistence is removed.

**Confidence:** Confirmed

**Evidence:** The browser polls upload status while completion is in progress. Backend completion/status paths can reconcile object metadata, causing repeated provider calls when finalization is slow or retried.

**Impact:** Many clients waiting on completion can create a HEAD storm and hold database resources.

**Best solution:** Use a single background finalizer claimant per upload. The status endpoint should read database state only. Persist the finalizer's result and error. Use exponential backoff with jitter, server-sent events, or a job status channel if lower notification latency matters.

**Validation:** While artificially delaying S3 completion, repeated status GETs must not increase S3 request count.

## PERF-017 [P1] Global JSON extraction occurs before handler-level authentication and CSRF

**Status:** Complete — implemented and verified on 2026-08-14.

**Verification:** All 23 protected JSON routes now extract only the unread payload handle, authenticate the session or editor grant, validate mutation CSRF, and only then decode through explicit per-route limits ranging from 16 KiB to 8 MiB. Expensive vault setup/publish/share mutations are additionally capped at eight globally and three per user, with queued requests still unread. A raw localhost request declaring an 8 MiB body but sending only its 129-byte headers received `401 Unauthorized` in `0.47 ms`, proving the authenticated file-upload handler responded without waiting for or reading the body. The durable 32-request concurrent check measured `20.03 ms` rejection p95 while simultaneous health requests stayed at `40.78 ms` p95; it now runs in performance CI. Parser limit/content-type tests, route-coverage guards, limiter tests, 85 frontend tests, 18 performance tests, 50 backend tests, strict Clippy, TypeScript, lint, and a webpack production build passed.

**Confidence:** Confirmed

**Evidence:** `main.rs` permits JSON bodies up to 8 MiB. Vault and share handlers receive `web::Json` and only then call `require_user` and `require_csrf` inside the handler.

**Impact:** An unauthenticated or unauthorized request can force body buffering and deserialization of large cryptographic payloads. This is a memory/CPU denial-of-service surface and increases tail latency for legitimate work.

**Best solution:** Move authentication to scope middleware or a custom extractor that runs before expensive body parsing. Apply route-specific body limits. For large cryptographic payloads, authenticate headers first, then read a bounded `Bytes` stream and parse binary CBOR. Add per-user and global concurrency limits for publish/share operations.

**Validation:** Send concurrent unauthenticated 8 MiB bodies. They should be rejected before body allocation/deserialization and should not perturb authenticated p99 latency.

## PERF-018 [P1] Pool defaults and workload mixing magnify burst latency

**Status:** Complete — implemented and verified on 2026-08-14.

**Verification:** Request traffic and all eight maintenance workers now use independently created, independently sized PostgreSQL pools with bounded checkout queues; maintenance can no longer borrow a request connection through request-local caching. Both pools expose labeled size, available, waiting, checkout-latency, checkout-failure, connection-creation, and lifetime-recycle metrics. A real-PostgreSQL regression test held the only maintenance connection until that pool timed out while the one-connection request pool still completed its ping inside 250 ms. The warmed 20-login contention check measured authenticated file-control p95 at 8.45 ms, request checkout p99 within the 5 ms bucket, and zero request-pool checkout failures. The bulkhead test and contention check now run in performance CI.

**Confidence:** Confirmed

**Evidence:** The pool defaults to 8 connections, is capped at 32, and has a one-second wait timeout. Request traffic, health checks, and maintenance all use the same pool.

**Impact:** Uploads can consume the pool with repeated auth/control queries while cleanup or a recursive endpoint occupies other connections. Requests then fail or queue despite low Rust CPU usage.

**Best solution:** First reduce query/check-out count. Then separate request and maintenance pools or use explicit bulkheads. Size each pool from measured database capacity and instance count, not from CPU count alone. Export checkout wait histograms and queue depth. Apply endpoint backpressure before PostgreSQL overload.

**Validation:** At target concurrency, pool wait p99 should remain a small fraction of endpoint latency and maintenance should not starve requests.

## PERF-019 [P2] Idle-connection recycling creates avoidable cold-request connection churn

**Status:** Complete — implemented and verified on 2026-08-14.

**Verification:** Healthy connections are no longer rejected based on idle time. `RecyclingMethod::Verified` remains enabled, TCP keepalive is configured, the request and maintenance pools prewarm small configurable minimums, and the 30-minute maximum lifetime is staggered by up to ten minutes per connection instead of recycling a cohort together. Creation and lifetime-recycle counters make reconnect behavior directly observable. Regression tests simulate a connection idle for ten minutes, fail if an idle-age check returns, and verify each connection receives a stable bounded lifetime jitter. Live metrics confirmed both pools prewarmed without checkout failures.

**Confidence:** Confirmed

**Evidence:** `backend/src/db.rs` rejects pooled connections older than 30 minutes or unused for more than five minutes. Low-traffic periods can therefore leave the next request creating a new PostgreSQL connection.

**Impact:** Intermittent workloads see avoidable cold latency and simultaneous reconnect bursts.

**Best solution:** Use measured max lifetime plus randomized jitter, enable TCP keepalive, and consider a small prewarmed minimum if the hosting platform permits it. Do not recycle solely because a healthy connection was idle for five minutes. Verify the behavior of `RecyclingMethod::Verified` with metrics before changing it.

**Validation:** After ten idle minutes, the first request should not need to establish every pool connection.

## PERF-020 [P1] Password verification and hashing run inside PostgreSQL

**Status:** Complete — implemented and verified on 2026-08-14.

**Verification:** Login now fetches the stored bcrypt hash, maps the user, explicitly releases the request-scoped PostgreSQL connection, and only then verifies in a bounded Rust `spawn_blocking` worker queue. Missing users perform the same dummy-hash work to avoid a fast username oracle. Admin creation and invitation acceptance hash before their short insert statements, and invalid invitations are rejected before consuming a password worker. Per-address and per-account login limits are independent of the worker bound, while an exhausted worker queue returns `429` rather than growing without limit. PostgreSQL-compatible `$2a$` verification, queue bounds, rate limits, and a source guard forbidding runtime `crypt`/`gen_salt` SQL are covered by tests. In the live 20-login burst, authenticated file-control p95 was 8.45 ms, request checkout p99 stayed in the 5 ms bucket, and database checkout failures stayed at zero.

**Confidence:** Confirmed

**Evidence:** Login uses PostgreSQL `crypt`, and invitation/user creation uses `crypt(... gen_salt('bf'))` in SQL.

**Impact:** CPU-bound bcrypt occupies a scarce database connection and makes authentication bursts compete directly with upload metadata.

**Best solution:** Fetch the stored password hash, release the connection, and verify in a bounded `spawn_blocking` pool using a Rust password-hash crate. Hash new passwords the same way before the short insert transaction. Rate-limit login separately.

**Validation:** During a login burst, database connection occupancy should remain low and upload-control latency should stay stable.

## PERF-021 [P2] Every successful login synchronously deletes all expired sessions

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** Successful login now performs only password authentication and its own session insert; expired-session deletion runs in an independently supervised maintenance worker on the maintenance database pool. Each run is capped at four 1,000-row keyset batches using `FOR UPDATE SKIP LOCKED` and the `(expires_at, id)` cleanup index. A rollback-only regression seeded 1,000,000 expired sessions, confirmed the cleanup plan used that index, deleted exactly 1,000 rows, and left the active session plus the other 999,000 expired rows intact. A source guard fails if session deletion is added back to the login handler.

**Confidence:** Confirmed

**Evidence:** `backend/src/routes/auth.rs::login` inserts a session and then executes `DELETE FROM sessions WHERE expires_at <= now()` before responding.

**Impact:** Login latency includes unrelated cleanup and can spike when many sessions have expired.

**Best solution:** Move expiry cleanup to a maintenance task and delete by indexed keyset batches. Optionally partition sessions by expiry for very large deployments.

**Validation:** Seed millions of expired sessions and confirm login latency is independent of the backlog.

## PERF-022 [P2] Session tokens are hashed repeatedly inside SQL

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** Session tokens are now SHA-256 hashed once in Rust and stored and queried as fixed-width, length-constrained 32-byte `BYTEA`. Authentication, full-profile lookup, CSRF retrieval/update, logout, and locked admin-session revalidation no longer hash tokens in PostgreSQL; already-resolved session IDs are reused where possible. The idempotent migration decodes existing hexadecimal text hashes without invalidating sessions, and the fresh-migration regression proves that compatibility path. Across 100,001 legacy sessions, the token index decreased from 12,394,496 to 5,931,008 bytes, while 20,000 warm indexed lookups decreased from 28,855 to 20,767 microseconds in the matched disposable-database run. Fixed-width hashing and source guards prevent PostgreSQL session hashing from being reintroduced. The migrated live API passed login, authenticated `/me`, CSRF retrieval, logout, and post-logout `401` verification.

**Confidence:** Confirmed

**Evidence:** Session and CSRF queries call `digest($1, 'sha256')` in PostgreSQL for every request.

**Impact:** This is smaller than network latency but sits on every authenticated hot path and consumes database CPU.

**Best solution:** Hash the presented token once in Rust into a fixed 32-byte value and store/query `BYTEA`. Keep a migration compatibility path for existing hexadecimal hashes.

**Validation:** Compare database CPU per authenticated request and index size after conversion.

## PERF-023 [P0] The `files` counter trigger rewrites a hot counter row for every update, even when contributions do not change

**Status:** Complete — implemented and verified on 2026-08-12.

**Verification:** The row-level trigger was replaced by INSERT/UPDATE/DELETE statement triggers using transition tables and per-owner aggregate deltas. A rollback-only 10,000-file regression test proved one counter write for the bulk insert, trash, restore/resize, and delete statements; an `updated_at`-only update produced zero counter or storage-ledger writes, and trash changed the UI counter without touching the separated storage ledger. A disposable-database test replays the complete migration chain, asserts that the legacy row trigger is absent and exactly three statement triggers remain, then reruns the accounting regression. These checks are committed under `database/tests/` and exposed through package scripts.

**Confidence:** Confirmed

**Evidence:** `database/init/001_auth.sql::update_file_counters` runs after every insert, update, or delete. It performs an upsert into `user_file_counters` even for changes such as `updated_at`, checksum, ETag, or encrypted record publication where file counts and bytes are unchanged.

**Impact:** Every file metadata update creates extra tuple versions, WAL, index work, and row-lock contention. Recursive trash/restore operations repeat it once per descendant.

**Best solution:** Split triggers by relevant columns and use `WHEN` clauses. Better, use statement-level triggers with transition tables that aggregate one delta per owner/recipient for the whole statement. For controlled bulk operations, apply explicit deltas in the same transaction and retain a periodic drift verifier.

**Validation:** An `updated_at`-only update should not touch `user_file_counters`. Trashing 10,000 nodes should update each affected user's counter once, not 10,000 times.

## PERF-024 [P1] The global admin-user counter trigger fires on every user update

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** The catch-all user trigger is replaced by separate INSERT, DELETE, and `UPDATE OF role, status` triggers. The update trigger compares the actual total/active/admin contribution tuple, so even role changes on disabled users avoid the singleton row; the trigger function also returns before writing when deltas are zero. Invitation triggers use the same split and fire on updates only when pending membership changes. A write-capture regression proved profile/preference updates, unchanged role/status writes, disabled-user role changes, pending-to-pending invitation updates, and nonpending-to-nonpending transitions cause zero `admin_directory_counters` writes, while real contribution changes write exactly once and preserve source-of-truth counts. Fresh legacy migration and replay checks prove each table retains exactly the three scoped triggers and never restores the catch-all trigger.

**Confidence:** Confirmed

**Evidence:** The `users_admin_counter_change` trigger runs after any user update. A profile preference or avatar update rewrites the singleton `admin_directory_counters` row even though role/status counts did not change.

**Impact:** All profile updates across all users contend on one global row and generate unnecessary WAL.

**Best solution:** Use separate INSERT/DELETE triggers and `AFTER UPDATE OF role, status ... WHEN (OLD.role, OLD.status) IS DISTINCT FROM (NEW.role, NEW.status)`. Apply the same principle to invitation counters so pending-to-pending updates do not rewrite the singleton.

**Validation:** Profile updates must produce zero writes to `admin_directory_counters`.

## PERF-025 [P1] Share envelope and wrapper epoch guards query and lock the same share once per row

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** The row-level guards were replaced by INSERT/UPDATE statement triggers with transition tables. Each statement now deduplicates its `(share_id, epoch)` pairs, orders distinct shares before locking, and acquires one shared lock per affected share while preserving active, pending, fenced, revoked, and invalid-epoch rejection semantics. A rollback-only scale regression proved a 10,000-wrapper insert and a 100,000-envelope insert each invoke the guard once, rather than once per row. A fresh legacy-to-current migration test also asserts that both old row triggers remain absent, exactly four statement triggers remain, and migration replay is idempotent.

**Confidence:** Confirmed

**Evidence:** `database/init/002_e2ee.sql` installs row-level `BEFORE INSERT OR UPDATE` triggers. Every wrapper and every envelope selects `vault_shares ... FOR SHARE`.

**Impact:** A bulk share publication with thousands of wrappers performs thousands of repeated share lookups and lock operations even if application inserts are batched.

**Best solution:** Replace row triggers with statement-level validation using transition tables and distinct `(share_id, epoch)` pairs, or load rows into a staging table, validate all pairs once, then insert set-wise. Keep a constraint trigger only if cross-table serialization truly requires it.

**Validation:** Publishing N wrappers should execute O(1) share-state lookups per distinct share/epoch, not O(N).

## PERF-026 [P0] Vault wrappers and envelopes are inserted one row per awaited SQL call

**Status:** Complete — implemented and verified on 2026-08-12.

**Verification:** Wrapper and envelope helpers now materialize typed PostgreSQL arrays and issue exactly one `INSERT ... SELECT FROM unnest(...)` statement for each non-empty collection, with a zero-statement fast path for empty input. A real encrypted-share publication returned HTTP 201 in 16.860 ms with one request database-pool checkout and persisted two wrappers plus one envelope under the same transaction. PostgreSQL reported protocol v2, a two-wrapper commitment, a 32-byte root, and one active recipient. The independent per-row epoch-guard cost remains tracked by PERF-025.

**Confidence:** Confirmed

**Evidence:** Vault route helpers loop over wrappers and envelopes and await an insert for each row.

**Impact:** Network round trips and trigger executions dominate cryptographic work for large shares or rotations.

**Best solution:** Use PostgreSQL binary `COPY` into a temporary/staging table, then one validated `INSERT ... SELECT`, or use chunked `UNNEST`/multi-row inserts when COPY is inconvenient. Pair this with the statement-level epoch guard. Return duplicate/conflict diagnostics set-wise.

**Validation:** SQL statement count should remain nearly constant as wrapper count grows from 10 to 10,000.

## PERF-027 [P1] Expiry workers lack indexes that match their global claim queries

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** Exact partial global indexes now cover `(expires_at, id)` for the file- and vault-upload states claimed by their respective expiry workers, and both workers use deterministic `ORDER BY expires_at, id` ordering before `FOR UPDATE SKIP LOCKED`. The file index deliberately excludes `completing`, which is owned by the separate completion worker. An `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` regression with 100,000 file intents and 100,000 vault intents requires each production-shaped claim to use its named partial index without a Sort node. Rust source guards keep the claim predicates, ordering, and base-schema index definitions aligned, while the concurrent migration self-repairs missing or invalid indexes on replay.

**Confidence:** Confirmed

**Evidence:** `file_uploads` and `vault_uploads` have indexes beginning with `owner_id`, while maintenance searches globally by `status` and `expires_at`.

**Impact:** As intent tables grow, a task that runs every ten seconds can degrade toward repeated table scans.

**Best solution:** Add partial global indexes, for example `ON file_uploads (expires_at, id) WHERE status IN ('initializing','pending','completing','aborting')` and the equivalent for `vault_uploads`. Match the exact claim predicate and ordering.

**Validation:** Use `EXPLAIN (ANALYZE, BUFFERS)` on a large fixture and require an index scan with bounded buffers.

## PERF-028 [P1] Shared-envelope lookup lacks its natural composite index

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** Shared download now uses deterministic newest-first ordering by `created_at DESC, envelope_id DESC`, backed by `vault_share_envelopes_recipient_latest_idx` on `(share_id, epoch, recipient_id, created_at DESC, envelope_id DESC)`. A 100,000-envelope `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` regression requires a one-row scan through that exact index and rejects any Sort node. A Rust source guard ties the production query to the index definition, and fresh migration plus replay tests verify that the concurrent migration leaves the index present and valid.

**Confidence:** Confirmed

**Evidence:** Shared download looks up the newest envelope by `share_id`, `epoch`, and `recipient_id`, ordered by `created_at DESC`. The E2EE schema does not define that composite index.

**Impact:** Large envelope history makes every shared download search and sort more data than necessary.

**Best solution:** Add `vault_share_envelopes (share_id, epoch, recipient_id, created_at DESC)` and include columns needed by the plan if index-only scans are practical.

**Validation:** Shared download plans should use a one-row index scan without sorting.

## PERF-029 [P2] Migration cleanup and claim paths are missing targeted partial indexes

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** Exact partial indexes now cover ordered legacy/staged file claims, per-owner incomplete migration summaries, and cleanup acknowledgements by non-null legacy object key. Production SQL is held in shared constants with source tests that keep each predicate and ordering aligned to its base-schema index. A rollback-only scale regression with 100,000 files and 100,000 migration rows requires the claim to use `files_e2ee_migration_claim_idx` without a Sort node, the summary to use both narrow partial indexes, and cleanup acknowledgement to use `vault_migrations_cleanup_object_idx`. Migration 013 builds missing indexes concurrently, rechecks them on replay, and passed fresh legacy-to-current plus base-migration replay tests.

**Confidence:** Confirmed

**Evidence:** `vault_migrations` is indexed by `(owner_id, state, updated_at)`, but cleanup can identify rows by legacy object key, and required/migration work scans file E2EE state.

**Impact:** Cleanup and migration claim latency grows with migration history.

**Best solution:** Add a partial unique/index on `legacy_object_key` where non-null, and partial indexes for pending migration states and legacy/staged files using the exact claim ordering. Remove them after migration only if no operational path still uses them.

**Validation:** Migration claims and deletion acknowledgements should use narrow index scans.

## PERF-030 [P2] Case-insensitive username lookups lack a matching unique index

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** `users_username_ci_idx` now uniquely enforces the application's `lower(username)` equality rule, and password authentication was aligned with the already case-insensitive admin, invitation, sharing, and vault-identity lookups. A 100,000-user plan regression requires a case-insensitive lookup to use the unique expression index and proves that a differently-cased duplicate is rejected. A live preflight found zero non-lowercase or case-colliding usernames, the concurrent migration is active and valid, and a real login using `AdminGod` for the stored `admingod` account returned HTTP 303 successfully. Source guards prevent any identity lookup family from drifting away from the indexed rule.

**Confidence:** Confirmed

**Evidence:** Many routes use `lower(username) = lower($1)`, while the base table has a case-sensitive unique constraint on `username`.

**Impact:** Lookups can require scans, and the database does not enforce the same equality semantics used by the application.

**Best solution:** Normalize usernames once and query exact lowercase values, or use `CITEXT`. Add a unique expression index on `lower(username)` during migration.

**Validation:** Identity, invitation, admin, and share-recipient lookups should all use the same indexed equality rule.

## PERF-031 [P1] File listings perform multiple independent queries serially

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** Owned and shared folder validation now returns the authorized breadcrumb chain in the same recursive query, removing one serialized database round trip. Entry pagination and counter-summary retrieval are then polled concurrently through the existing request-scoped shared PostgreSQL connection, retaining one pool checkout while pipelining the independent work. Regression tests lock in both combined context queries and the concurrent join. On the same active folder and local API, matched 40-request samples improved from 3.141 ms median / 3.929 ms p95 to 2.211 ms median / 3.403 ms p95; the verified response retained the same folder ID, breadcrumb, 10 entries, seven summary fields, and pagination state. No UI or response-contract files changed.

**Confidence:** Confirmed

**Evidence:** The main files route validates the current folder, constructs breadcrumbs, fetches entries, and fetches summary/counter data in sequence.

**Impact:** Each round trip adds latency and separate pool checkout opportunities.

**Best solution:** Combine authorization and folder metadata, then run independent entry and summary queries concurrently on one checked-out client, or return them from one SQL statement with separate JSON aggregates only if plans remain efficient. Avoid recomputing data already present in authenticated/request context.

**Validation:** Measure SQL count and p95 folder-open latency. Ordinary listing should need one checkout and at most two database round trips.

## PERF-032 [P2] File rows execute several correlated share-existence checks

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** File rows now carry transactionally maintained legacy-share, vault-share, permanent-link, and latest-expiring-link metadata, populated by a replay-safe migration and kept current by statement-level triggers for insert, update, delete, revocation, status, recipient, and expiry transitions. Owned listings read those columns directly, with a null-safe active-link expression, instead of executing share-table probes per result row. Rollback-only plan regressions at both 50,000 and 1,000,000 repository nodes measured 9 shared-buffer hits for 50 rows and 28 for 500 rows, with no share relation or correlated `SubPlan` in either listing plan. Fresh-schema backfill, zero-row trigger safety, migration replay, exact production-query preparation, and a real authenticated listing returning concrete false flags all passed.

**Confidence:** Confirmed

**Evidence:** Listing SQL computes share flags using separate `EXISTS` checks against legacy shares, vault shares, and share links for each result row.

**Impact:** Even indexed probes multiply with page size and can dominate a 500-row page.

**Best solution:** Pre-aggregate share state once for the page using lateral joins or a `UNION ALL` relation grouped by file ID. For very hot listings, maintain a small denormalized share-state bit/count updated by statement-level triggers.

**Validation:** Compare buffer hits and execution time at page sizes 50 and 500. Share-state work should not scale as three random probes per row.

## PERF-033 [P1] Repository detail recomputes full-tree membership and counts on every navigation

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** Repository detail now resolves authorization, requested-folder metadata, and breadcrumbs in one upward ancestor walk, then performs only the bounded child listing during stable navigation. Repository file/folder totals are cached behind a trigger-maintained tree version; stale totals refresh once per structural version, publish only if that version remains current, and retry after a concurrent tree change rather than exposing stale counts. At both 50,000 and 1,000,000 nodes, the ancestor plan remained 13 rows and 54 shared-buffer hits; the one-time full refresh measured about 80 ms at 50,000 nodes and 1.94 seconds at 1,000,000 nodes instead of recurring on every folder click. A real repository request returned byte-identical first and cached responses in 8.965 ms and 5.059 ms respectively, while source and database regressions enforce the upward-query and version-gate design.

**Confidence:** Confirmed

**Evidence:** `backend/src/routes/repositories.rs::detail` recursively scans downward from the root to authorize the requested folder, runs another recursive breadcrumb query, lists children, and recursively counts the entire repository.

**Impact:** Clicking between folders becomes proportional to repository size. A 50,000-node repository pays a full count repeatedly.

**Best solution:** Authorize by walking ancestors upward from the requested node to the root, which is O(depth). Maintain repository file/folder totals incrementally, or cache them with a tree version. Fetch breadcrumbs and child entries without a second full-tree walk. For stable hierarchies, consider a materialized path or closure table.

**Validation:** At 50,000 and 1,000,000 nodes, folder-navigation latency should depend on depth and page size, not total tree size.

## PERF-034 [P1] Share-link browsing repeats recursive authorization and metadata queries

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** Public share browsing now resolves the active grant, recipient rule, root, requested node, upward root membership, and breadcrumbs in one authorization query, followed only by the bounded child query. Share downloads return authorization and file metadata from one database statement. At both 50,000 and 1,000,000 nodes, shared navigation remained 13 rows and 60 shared-buffer hits, while download authorization returned exactly two recursive rows for the tested child. Exact production SQL prepares against a fresh database, source guards prevent the retired serial helper chain from returning, and real runtime checks returned HTTP 200 for the unchanged folder response and for a 94-byte file download through a temporary link that was revoked and removed afterward.

**Confidence:** Confirmed

**Evidence:** Share access resolves the grant, fetches the root, proves subtree membership, builds breadcrumbs, and lists children serially. Download resolves the grant, proves membership, then fetches the file.

**Impact:** Public/shared browsing pays four to five database round trips per view and recursive work per file download.

**Best solution:** Create authorization-aware SQL functions/queries that return the grant plus requested node and root membership in one statement. Walk upward from the requested node. Run breadcrumbs and child listing concurrently or combine them. For download, return file metadata from the authorization query itself.

**Validation:** Shared folder views should require one checkout and at most two round trips; downloads should use one authorization/file query.

## PERF-035 [P2] Several collections are capped or unbounded without real pagination

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** Repository lists, repository children, owned share links, shared children, and owned vault shares now use opaque, scope-bound keyset cursors over stable sort keys plus IDs. Every response is bounded and exposes `hasMore`/`nextCursor`; normal-size views are unchanged, while an existing-style continuation control appears only beyond the boundary. A fresh 100,000-row database test reached all 205 repositories, more than 100,000 repository/shared children, 105 links, and 205 vault shares over multiple pages without duplicates or omissions. Exact production queries prepared successfully. In the running application, a temporary 101-repository account rendered 100 items and one continuation, then exactly one final item and no continuation; both server-rendered pages returned HTTP 200 without framework error markers, after which the fixture was removed.

**Confidence:** Confirmed

**Evidence:** Repository list and vault share list are unbounded. Share-link listing is capped at 50 without a cursor. Shared children are capped at 500. Repository detail reports truncation at 500 but exposes no keyset continuation in the route.

**Impact:** Large collections either allocate too much memory or silently become inaccessible beyond the cap.

**Best solution:** Implement keyset pagination using stable `(sort_key, id)` cursors for every collection. Never use high offsets. Include `hasMore` and `nextCursor`, and make repository ZIP/tree traversal a separate streaming/batched operation.

**Validation:** Populate collections above each current limit and prove every item remains reachable with bounded response size.

## PERF-036 [P2] Recursive CTEs do not consistently defend against cycles or excessive depth

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** The database now enforces one documented maximum of 100 parent edges with statement-level transition-table guards. It rejects cycles, cross-owner parents, non-folder parents, and excessive depth with SQLSTATE `23514`; owner-scoped advisory locks serialize concurrent structural changes. Every recursive route query also tracks visited IDs and stops at depth 100, with a source regression test covering all four hierarchy route modules. Fresh-database injections proved cycle, cross-owner, and depth-101 mutations fail deterministically, while a valid depth-100 tree succeeds. Migration replay preserves exactly two hierarchy guards.

**Confidence:** Confirmed

**Evidence:** Some hierarchy queries use `UNION ALL` with no depth limit; others cap depth at 100. The schema has a self-referencing parent foreign key but no general cycle constraint.

**Impact:** A corrupted or adversarial cycle can run until the statement timeout, consume CPU, and block operations. Deep trees also have unpredictable costs.

**Best solution:** Enforce acyclicity when parent relationships change. On PostgreSQL versions that support it, use the `CYCLE` clause, or track a visited path and depth in recursive queries. Standardize a documented maximum depth. A materialized path can make this validation cheaper.

**Validation:** Inject a cycle in a test database and require every tree endpoint to terminate quickly with a deterministic error.

## PERF-037 [P2] The `files` table maintains many overlapping indexes

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** Representative `pg_stat_user_indexes`, `pg_stat_statements`, and listing plans were inspected before changing the schema; HypoPG was unavailable. Only the measured redundant `files_updated_at_idx`, `files_favorite_idx`, and `files_recent_owner_idx` were removed (approximately 11.6 MiB in the sampled database), while parent, state, migration, active browse, favorites, trash, and every sort-direction index were retained. Cursor-specific share-link and vault-share indexes were added. On a 100,000-row fresh database, all retained listing plans stayed on ordered partial indexes without a sort. For the same 1,000-row favorite/updated-at write sample, WAL fell from 3,896,808 to 2,715,086 bytes and runtime from 47.753 ms to 36.461 ms. The regression suite asserts both removed and required index sets and replays the migration.

**Confidence:** Plan-dependent

**Evidence:** The schema defines low-selectivity standalone indexes plus numerous ascending/descending browse indexes over similar owner/parent/sort prefixes.

**Impact:** Every upload publication, favorite toggle, trash/restore, and record update pays index-maintenance and WAL costs. Some indexes are likely redundant.

**Best solution:** Collect `pg_stat_user_indexes`, `pg_stat_statements`, and production plans for a representative period. Use HypoPG to test removals. Drop unused low-selectivity and prefix-redundant indexes, while retaining the exact partial indexes that serve active browse, favorites, trash, recent, and hierarchy joins.

**Validation:** After each removal, compare write TPS, WAL bytes, and all listing plans. Never drop indexes solely from static inspection.

## PERF-038 [P3] Timestamp formatting is pushed into PostgreSQL across many hot queries

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** All 49 PostgreSQL `to_char` calls were removed from the hot auth, admin, file, invitation, repository, share-link, and vault route queries. `tokio-postgres` now decodes native `TIMESTAMPTZ` values through its `time` integration, and one Rust formatter preserves the existing seconds, cursor-microseconds, and avatar-version wire formats. At 1,000,000 rows, the same full-column timestamp query fell from 288.606 ms with database formatting to 67.949 ms with typed timestamps. Unit tests lock the exact wire formats, a source regression test rejects any reintroduced route-level `to_char`, fresh-database query contracts passed, and the running admin API returned the expected unchanged RFC 3339 strings for timestamps containing fractional seconds.

**Confidence:** Confirmed

**Evidence:** Routes repeatedly call `to_char(... AT TIME ZONE 'UTC', ...)`.

**Impact:** This consumes database CPU and returns larger text values instead of compact typed timestamps.

**Best solution:** Enable `time` or `chrono` support in `tokio-postgres`, retrieve typed timestamps, and serialize RFC 3339 in Rust. Alternatively return epoch milliseconds for internal APIs.

**Validation:** Profile database CPU on listing-heavy workloads before and after.

## PERF-039 [P3] Text identifiers enlarge indexes and joins

**Status:** Complete — measured policy implemented and verified on 2026-08-15.

**Verification:** New high-volume tables are now required to use native `UUID` or another compact internal identifier and expose prefixed strings only at the API boundary. The migration records a frozen allowlist of the existing legacy `TEXT` primary/foreign keys, and the database regression test proves that any newly introduced `TEXT` identifier is detected; the storage policy and migration criteria are documented in `database/IDENTIFIER_STORAGE_POLICY.md`. A matched 250,000-row primary-key plus parent-index benchmark measured 63,610,880 bytes for `TEXT` versus 34,971,648 bytes for native `UUID` (45.0% smaller). Existing identifiers were deliberately not rewritten because the audit classifies that whole-schema operation as a long-term, evidence-gated migration; this resolves the forward-looking recommendation without imposing a high-risk data/API rewrite prematurely.

**Confidence:** Plan-dependent

**Evidence:** Most primary and foreign keys are `TEXT`, including UUID-like file/user IDs and prefixed IDs.

**Impact:** Text B-trees consume more memory and cache than native UUID or fixed binary keys, increasing join and index costs at very large scale.

**Best solution:** For new high-volume tables, use native `UUID`, `BYTEA(16)` semantics, or a compact sortable ID type internally and expose prefixed strings only at the API boundary. Treat conversion of existing tables as a long-term migration, not an early optimization.

**Validation:** Use `pg_relation_size` and representative join benchmarks to justify migration.

## PERF-040 [P2] Admin search uses leading-wildcard `ILIKE` across several columns

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** Role and status searches are normalized into exact comparisons, literal substring terms escape `%`, `_`, and `\\`, and only username/display-name fields retain substring matching. Concurrently built partial `pg_trgm` GIN indexes cover those text fields. Invitation search first builds a bounded materialized candidate set from individually indexable username, creator, exact-role, and exact-status branches, while users, invitations, and the summary are pipelined concurrently over the request-scoped database connection. At 1,000,000 users plus 1,000,000 invitations, user search improved from 406.098 ms and 77,278 measured buffer references to 1.052 ms and 730; invitation search improved from 418.205 ms and 5,125,832 to 37.185 ms and 251,340. Fresh-database plan tests require the trigram indexes and migration replay contract. Live API checks proved substring search, exact `user`/`pending` filters, and literal `%` behavior, and the unchanged `/users` UI server-rendered the expected results.

**Confidence:** Confirmed

**Evidence:** Admin user and invitation queries build `%term%` patterns over username, display name, role, status, and creator.

**Impact:** B-tree indexes cannot serve arbitrary substring search; the page degrades into scans as the directory grows.

**Best solution:** Normalize exact filters for role/status. Add `pg_trgm` GIN indexes only to fields requiring substring search, or use prefix search where acceptable. Run users, invitations, and summary queries concurrently on one client.

**Validation:** Use representative search terms at 100,000 and 1,000,000 rows and inspect buffers.

## PERF-041 [P2] Admin and profile handlers perform avoidable serial round trips

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** The admin directory's three independent reads now pipeline concurrently over its one request-scoped PostgreSQL connection. Profile patching no longer reloads current settings: explicit keep/remove/replace fields feed one `UPDATE ... RETURNING`, preserving omitted values. The four protected admin role, status, full-update, and deletion paths now each combine authorization revalidation, CSRF validation, target locking, last-admin protection, and mutation in one atomic CTE statement after the cached principal lookup. A live isolated role update retained its `303` contract, changed the target, and `pg_stat_statements` recorded exactly one principal query plus one mutation query and zero explicit `BEGIN`/`COMMIT` commands; the profile and all four admin flows also passed live checks. Prepare, fixture, invariant, collision, and deletion-handoff tests prevent the removed round trips from returning.

**Confidence:** Confirmed

**Evidence:** Admin directory fetches users, invitations, and summary sequentially. Profile update performs auth, CSRF, current-settings SELECT, and UPDATE. Several create/update routes validate then insert then reload the same row.

**Impact:** Small administrative actions incur unnecessary network latency and pool churn.

**Best solution:** Use the request principal, `tokio::try_join!` for independent reads on an acquired client where protocol support permits, and SQL `UPDATE ... RETURNING`/`INSERT ... SELECT ... RETURNING` to combine validation and response data. For profile patches, use explicit nullable patch fields and one update.

**Validation:** Record SQL count per endpoint and eliminate reload queries where `RETURNING` can produce the response.

## PERF-042 [P1] Shared download transactions keep locks while assembling the response

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** Shared-download planning now obtains the authorization, recipient, share-epoch, envelope, wrapper, and encrypted-file material as one consistent locked snapshot, commits immediately, and only then performs row extraction, CBOR decoding, hashing, base64 work, and storage URL presigning. The database fixture test proved a concurrent share mutation waits while the snapshot transaction is open, succeeds immediately after commit, and cannot invalidate the already-owned snapshot values. Exact query prepare/execution tests and a source-order regression guard require the commit to remain ahead of response assembly.

**Confidence:** Confirmed

**Evidence:** Encrypted shared download planning holds a transaction and `FOR SHARE` locks while running several queries, encoding base64, and generating the presigned URL.

**Impact:** This lengthens lock duration, occupies a pool connection, and increases contention with share rotation/revocation.

**Best solution:** Fetch a consistent authorization/material snapshot in one query, copy the small required values, commit immediately, then perform base64 encoding and presigning outside the transaction. If strict instant revocation is required, use very short URL TTLs or a download gate; the current lock cannot protect access after the response anyway.

**Validation:** Trace transaction duration and lock waits during concurrent downloads and rotations. The transaction should end before response serialization.

## PERF-043 [P2] Large recursive mutations run under a global 10-second statement timeout

**Status:** Complete — implemented and verified on 2026-08-15.

**Verification:** Unbounded recursive subtree mutations were replaced with a repeatable-read, keyset-paginated walker capped at 1,000,000 nodes, using 16,384-row read pages and 5,000-row mutation, deletion, and metadata batches. Trash, restore, exact cleanup-queue deletion, share removal, encrypted snapshots, and repository manifests use the bounded path; a replay-safe migration adds the `(owner_id, parent_id, id)` walk index. With the global 10-second timeout unchanged, a 1,000,001-node fixture walked in 6.647 seconds, completed trash plus restore through 400 bounded statements in 91.505 seconds total, and kept its slowest mutation statement to 372.41 ms; the 100,001-node fixture also passed, with a 439.39 ms slowest mutation. Fresh-database migration replay, prepare/execution suites, a live nested trash/restore/delete flow, and source guards against recursive subtree SQL all passed.

**Confidence:** Confirmed

**Evidence:** The database connection options set `statement_timeout=10000`. Recursive trash, restore, deletion, archive manifests, and large share operations can scale with subtree size.

**Impact:** At scale, these operations fail abruptly rather than degrading gracefully, potentially leaving cleanup work for retries.

**Best solution:** Keep the timeout for ordinary requests, but redesign large operations as bounded asynchronous jobs or keyset batches. Do not simply raise the global timeout. Use route/job-specific transactions and progress state.

**Validation:** Run maximum supported tree operations and ensure each SQL statement remains bounded well below the timeout.

## PERF-044 [P0] Share material generation launches unbounded browser crypto work

**Status:** Complete — implemented and verified on 2026-08-12.

**Verification:** Subtree wrapper derivation, wrapper hashing, Merkle hashing, wrapper verification, and recipient-envelope HPKE now run through one order-preserving bounded queue. Wrapper/hash work is capped at 16 logical lanes, while HPKE is capped at eight and scales to half the detected hardware concurrency; unknown devices fall back to four. Regression tests process 40 tasks while proving a peak of exactly four in flight, stable result ordering, hardware caps, and fail-stop scheduling. The production worker bundle and a real browser share-to-recipient decrypt flow both passed without console warnings or errors.

**Confidence:** Confirmed

**Evidence:** `createSubtreeShareWrappers` uses `Promise.all` across every node, and envelope creation uses `Promise.all` across every recipient.

**Impact:** Thousands of WebCrypto operations, buffers, and promises can be live simultaneously, causing memory spikes, long event-loop stalls inside the worker, and poor cancellation.

**Best solution:** Use a bounded async work queue. Keep a small number of wrapper derivations in flight, for example 4 to 16 based on device capability, and a separate lower HPKE-recipient concurrency. Stream completed canonical wrappers/hashes to a staging buffer or upload stream rather than retaining every intermediate object.

**Validation:** Measure worker peak heap and completion time across low-end and high-end devices. Peak memory should be bounded independently of subtree size.

## PERF-045 [P0] Envelope validation repeatedly sorts and clones the same wrapper-hash set

**Status:** Complete — implemented and verified on 2026-08-12.

**Verification:** Protocol v2 envelopes carry one wrapper root and count, and server publication computes one `WrapperSetCommitment` for the request before validating every envelope against it. A 128-envelope regression test proves reuse of that single commitment and rejects the legacy per-envelope hash-array representation. Share-record hashing now consumes the commitment's already canonical proof order instead of cloning and sorting wrapper hashes again; a compatibility test proves the resulting record hash is unchanged. The live browser publication persisted protocol v2 with a 32-byte root and the expected wrapper count, and the recipient successfully decrypted the shared metadata.

**Confidence:** Confirmed

**Evidence:** Vault server validation builds/sorts wrapper hashes for recipient envelopes, even though every envelope is expected to commit to the same set.

**Impact:** CPU becomes superlinear or repeated-linear in recipients and wrappers, compounding the protocol's duplicated payload.

**Best solution:** Protocol v2 should compare one root commitment. For protocol v1 compatibility, sort and canonicalize the wrapper hashes once, compute one digest, and compare each envelope against that precomputed representation without cloning/sorting the full set again.

**Validation:** CPU profiles for v1 compatibility should show one wrapper-set sort per request, not one per recipient.

## PERF-046 [P1] Canonical wrappers are decoded multiple times during one publication

**Status:** Complete — implemented and verified on 2026-08-16.

**Verification:** Node and share publications now decode every canonical wrapper exactly once into `DecodedWrapper { canonical: Bytes, record, hash }`, then pass borrowed decoded records through owner/share validation, commitment checks, and database insertion. `DecodedWrapper` is intentionally not cloneable, source guards reject a return to deep wrapper clones or insertion-time decoding, and a route-pipeline regression executes through the production `VaultValidationService::run` boundary and asserts exactly one decode per wrapper.

**Confidence:** Confirmed

**Evidence:** Node/share validation decodes wrappers for record verification, owner/share validation, committed-set checks, and database insertion helpers.

**Impact:** Repeated CBOR parsing and allocation waste CPU and memory on already validated bytes.

**Best solution:** Decode once into a typed intermediate such as `DecodedWrapper { canonical: Bytes, record, hash }`. Pass borrowed records/slices through all validators and insertion code.

**Validation:** Add counters around decode calls. Each canonical wrapper should be parsed once per request.

## PERF-047 [P1] Large signature/CBOR validation runs synchronously on Actix async workers

**Status:** Complete — implemented and verified on 2026-08-16.

**Verification:** A bounded vault validation service now moves binary and legacy-JSON publication parsing, base64 conversion, CBOR decoding, Ed25519 verification, hashes, canonical sorts, and large JSON response encoding onto `spawn_blocking`, with separate global and per-user admission and worker limits. Authentication, CSRF validation, content-type checks, and bounded body reads remain ahead of CPU admission. Read transactions are committed and request-scoped leases are released before validation, object-store signing, or response work; mutations reopen a short write transaction and optimistically revalidate the exact snapshot before commit. Subtree order is produced deterministically by PostgreSQL with `WITH ORDINALITY`, avoiding a handler-side million-node sort while a transaction is held. Concurrent fairness, async-heartbeat, decode-boundary, lease-release, response-path, and source-contract regressions protect these properties.

**Confidence:** Confirmed

**Evidence:** Vault routes perform many Ed25519 verifications, CBOR parses, hash computations, sorts, and base64 transformations directly in async handlers.

**Impact:** CPU-heavy requests block the worker's executor thread and inflate latency for unrelated lightweight requests.

**Best solution:** After cheap size/auth checks, move large validation batches to a bounded `spawn_blocking` pool or dedicated CPU executor. Use per-user/global semaphores. Evaluate Ed25519 batch verification only if failure isolation and the threat model remain acceptable.

**Validation:** Under concurrent large share publication, `/health/live` and small metadata routes should retain stable latency.

## PERF-048 [P1] Base64 JSON adds wire bloat and allocation layers to binary cryptographic data

**Status:** Complete — implemented and verified on 2026-08-16.

**Verification:** First-party node, share-directory, create-share, and epoch-publication requests now use the versioned `AVLT` length-delimited binary wire format with strict kind, count, field-length, total-size, and trailing-byte rejection. The browser writes one exact `Uint8Array` and transfers its buffer; Actix retains the request as `Bytes` and exposes binary fields as zero-copy slices. Legacy JSON remains an authenticated compatibility fallback and is decoded in bounded CPU work. Cross-language fixtures lock browser/server parity. Seven-sample representative regressions measured node publication at 1,581,404 binary bytes versus 2,108,466 legacy-JSON bytes, and share publication at 4,273,314 versus 5,699,487 bytes; frontend binary encoding medians were 0.106 ms and 0.290 ms versus 0.581 ms and 2.043 ms for legacy JSON. Backend parsing medians were 20 us versus 14,368 us for the node fixture and 289 us versus 39,666 us for the share fixture, with zero copied binary field bytes asserted from actual slice ownership.

**Confidence:** Confirmed

**Evidence:** Bootstrap CBOR, wrappers, signatures, manifests, envelopes, hashes, and account state are represented as base64 strings in JSON.

**Impact:** Binary data expands by roughly one third before transport and is repeatedly allocated/decoded in browser and server. Large request bodies also hit the 8 MiB cap early.

**Best solution:** Add authenticated `application/cbor` or a simple length-delimited binary protocol using raw byte strings. In Actix, receive `Bytes`; in the browser, send `ArrayBuffer`/`Uint8Array`. Keep JSON only as a temporary compatibility API. Selective HTTP compression can reduce base64 overhead during transition, but binary is the durable fix.

**Validation:** Compare request bytes, allocation profiles, and CPU for representative node/share publications.

## PERF-049 [P2] Hash construction repeatedly concatenates temporary buffers

**Confidence:** Confirmed

**Evidence:** Rust verification and browser worker code concatenate canonical bytes with signatures or prefixes before hashing. Share snapshot hashes also build aggregate vectors.

**Impact:** Large operations allocate and copy data that SHA-256 can consume incrementally.

**Best solution:** Feed the hasher in domain-separated `update` calls. On the browser, use an incremental SHA-256 implementation in audited WASM/JS where WebCrypto's one-shot API forces large copies. Preserve test vectors.

**Validation:** Allocation profiles should no longer show aggregate hash buffers proportional to the whole request.

## PERF-050 [P2] The Rust CBOR reader owns byte strings and identifiers unnecessarily

**Confidence:** Confirmed

**Evidence:** `backend/src/e2ee.rs` copies identifiers and variable byte strings into owned `String`/`Vec` values during validation.

**Impact:** Large wrapper/envelope batches allocate heavily even though most data is inspected and then inserted from the original canonical bytes.

**Best solution:** Implement a borrowed parser with lifetimes for identifiers and ciphertext slices, or use a zero-copy CBOR library configured for canonical validation. Materialize only fields that must outlive the request buffer.

**Validation:** Track allocations per wrapper and total request RSS.

## PERF-051 [P1] Client node-key and share-key caches grow without a bound until vault lock

**Confidence:** Confirmed

**Evidence:** The vault worker stores opened `CryptoKey` objects in maps. Repository/share preparation can open thousands of nodes. Keys are cleared mainly when the whole vault locks.

**Impact:** Long sessions and large repository operations retain growing cryptographic state and associated metadata.

**Best solution:** Implement a bounded LRU with pinning for active ancestors and active encryption/decryption sessions. Add explicit subtree/session release messages. Cache share epoch keys by immutable `(shareId, epoch, envelopeHash)` with a limit. Remember that CryptoKey material cannot be manually zeroed, so eviction and worker termination are the available controls.

**Validation:** Open tens of thousands of nodes and verify worker heap reaches a stable plateau.

## PERF-052 [P1] Failed or canceled crypto sessions are not reliably removed

**Confidence:** Confirmed

**Evidence:** Upload/download error paths abort network/server state but do not always send a worker command to delete encryption/decryption sessions.

**Impact:** Abandoned sessions retain keys, leaf hashes, counters, and buffers until vault lock or worker destruction.

**Best solution:** Add `abortEncryption(sessionId)` and `abortDecryption(sessionId)` commands that wipe mutable byte arrays and remove map entries. Call them from `finally` blocks on every upload/download path.

**Validation:** Repeatedly cancel large transfers and confirm session-map size and worker heap return to baseline.

## PERF-053 [P2] Shared plan verification re-decodes and re-hashes material

**Confidence:** Confirmed

**Evidence:** The worker decodes bootstrap/wrappers in the main plan-opening path, then shared-key opening decodes bootstrap again and converts committed hashes into base64 strings and sets.

**Impact:** Shared downloads pay avoidable parsing, hashing, and string allocation.

**Best solution:** Create one verified-plan object containing decoded bootstrap, wrapper records, binary hashes, generation bytes, and sender identity. Pass it to owner/shared key opening. Compare fixed-size hashes as bytes, not base64 strings.

**Validation:** One plan should decode each record once and avoid base64 set construction.

## PERF-054 [P2] Large subtree sharing requires opening every node individually before wrapper generation

**Confidence:** Confirmed

**Evidence:** The worker requires each node key in `nodeKeys`; share preparation resolves encrypted node metadata/keys in parent order.

**Impact:** Sharing a large folder creates O(nodes) API calls and sequential crypto steps before publication even begins.

**Best solution:** Add a batch download-plan endpoint and a parent-aware client scheduler. Fetch plans in pages, open nodes level-by-level with bounded concurrency, and stream resulting wrapper material. A protocol-v2 tree-key design could reduce per-node opening further, but must be evaluated carefully against revocation and key-isolation requirements.

**Validation:** Share a 50,000-node tree and measure API calls, heap, and time-to-first-publication progress.

## PERF-055 [P2] Unlock material can return a multi-megabyte account-state blob

**Confidence:** Confirmed

**Evidence:** The schema and route permit encrypted account state up to 4 MiB and return it during unlock.

**Impact:** Every unlock can pay large database, base64, JSON, and browser allocation costs even for a small change.

**Best solution:** Store account state as versioned encrypted chunks or a compact snapshot plus deltas. Fetch the latest manifest first and lazy-load chunks. Use raw binary transport.

**Validation:** Unlock latency and bytes should be bounded by small key material rather than total account-state history.

## PERF-056 [P0] All maintenance work is serialized in one loop

**Status:** Complete — implemented and verified on 2026-08-12.

**Verification:** Maintenance now runs as seven independently scheduled and supervised workers with staggered start times, per-worker restart isolation, skipped missed ticks, and one shared graceful-shutdown signal. A regression test permanently stalls one periodic operation while a sibling still completes three runs inside 250 ms, then proves both stop promptly on shutdown. In the live S3-backed verification, the user-deletion worker advanced a disposable account through every phase while the separate storage-deletion worker removed its published encrypted object; the user, job, queued object cleanup, and MinIO object were all gone on the next observed maintenance cycle.

**Confidence:** Confirmed

**Evidence:** `backend/src/storage.rs::run_maintenance` executes deletion jobs, legacy expiry, vault expiry, invitation expiry, orphan reconciliation, and counter reconciliation in sequence.

**Impact:** A slow S3 call or large cleanup class delays every other maintenance responsibility.

**Best solution:** Run independent supervised tasks with separate intervals and bounded concurrency. Give deletion, upload expiry, orphan reconciliation, session/invitation expiry, and counter verification separate bulkheads and metrics. Use a shutdown token and restart failed tasks.

**Validation:** Artificially stall one S3 operation; other maintenance classes must continue meeting their service-level objectives.

## PERF-057 [P2] Every replica polls multiple mostly empty queues every ten seconds

**Confidence:** Confirmed

**Evidence:** The maintenance loop issues several claim/expiry queries on each tick even when there is no work.

**Impact:** At steady state this creates continuous database noise that scales with replica count.

**Best solution:** Use adaptive backoff after empty polls, reset immediately when work appears, and optionally `LISTEN/NOTIFY` as a wake-up hint with periodic polling for safety. Elect one reconciler for global scans while allowing multiple deletion workers.

**Validation:** Measure no-work queries per day per replica and reduce them by at least an order of magnitude without increasing queue age.

## PERF-058 [P1] S3 deletion, abort, and orphan actions are largely sequential

**Confidence:** Confirmed

**Evidence:** Maintenance awaits provider operations one at a time.

**Impact:** Throughput is bounded by provider round-trip latency and cleanup backlogs grow unnecessarily.

**Best solution:** Claim a bounded batch, then use `buffer_unordered`/`FuturesUnordered` with a configurable concurrency limit. Use S3 `DeleteObjects` for object-only jobs in batches up to the provider limit. Keep multipart aborts separate and idempotent.

**Validation:** With 10,000 queued objects, throughput should increase with configured concurrency until provider or bandwidth limits are reached, without unbounded memory.

## PERF-059 [P2] Leases and retries are not aligned with operation duration or poll cadence

**Confidence:** Confirmed

**Evidence:** Jobs use fixed lock windows; retry delays can be shorter than the ten-second loop and lack full jitter.

**Impact:** A slow provider attempt can outlive its lease and be duplicated by another worker. Identical retries synchronize across replicas.

**Best solution:** Use a unique lease owner/token and heartbeat long operations, or choose a lease based on maximum configured SDK attempt time. Apply exponential backoff with full jitter and a delay floor compatible with the poll loop. Add a dead-letter state after a high attempt threshold.

**Validation:** Inject slow/time-out responses and prove no concurrent worker processes the same non-idempotent phase.

## PERF-060 [P1] Global multipart reconciliation occupies an application-pool connection across a provider sweep

**Confidence:** Confirmed

**Evidence:** The reconciler takes a database advisory lock and performs paginated S3 listing/abort work while coordinating through the same pool used by requests.

**Impact:** A long bucket scan can consume a scarce connection and extend leadership lock duration.

**Best solution:** Use a dedicated maintenance pool/connection. Acquire a short database leadership lease, release the transaction, then run the sweep with a renewable lease token. Stage provider page keys and compare against all live intents set-wise.

**Validation:** During a large reconciliation, request-pool availability and p99 latency should remain unchanged.

## PERF-061 [P2] Orphan reconciliation stops too much work on individual provider failures

**Confidence:** Confirmed

**Evidence:** The sweep's serial error propagation can prevent later multipart uploads in a page from being examined.

**Impact:** One bad provider response leaves unrelated orphans until the next global sweep.

**Best solution:** Handle each multipart item independently, aggregate errors, continue the page, and persist metrics/error samples. Use bounded concurrency and idempotent aborts.

**Validation:** Inject failures for selected keys and confirm the rest of the page is still reconciled.

## PERF-062 [P2] Bucket lifecycle policy is not used as a cleanup backstop

**Confidence:** Confirmed

**Evidence:** The application performs its own global incomplete-multipart sweep.

**Impact:** Application scans cost provider list calls and are vulnerable to process outages.

**Best solution:** Configure the bucket's `AbortIncompleteMultipartUpload` lifecycle rule with a safely longer age than any valid upload. Keep application reconciliation for prompt cleanup and state repair, but run full sweeps less frequently. Validate provider-specific behavior for the Railway-compatible S3 service.

**Validation:** Disable the application temporarily and verify stale incomplete multipart uploads are eventually removed without affecting valid ones.

## PERF-063 [P2] Hourly counter reconciliation scans and rewrites broad data

**Confidence:** Confirmed

**Evidence:** The maintenance worker periodically reconstructs user file counters from large tables, and the migration SQL contains a similar global rebuild.

**Impact:** Even with incremental triggers, hourly full scans consume I/O and can rewrite counters that are already correct.

**Best solution:** Make reconciliation a drift detector first: aggregate in owner-ID partitions, compare, and update only mismatches. Run it less frequently or off-peak. Pre-aggregate shared counts once rather than a correlated count per user.

**Validation:** Track rows scanned/updated and require that a no-drift run performs no application-row updates.

## PERF-064 [P2] AWS SDK timeout and retry behavior is not explicitly bounded

**Confidence:** Plan-dependent

**Evidence:** Storage creation relies mainly on SDK defaults; route-level request timeouts are not configured.

**Impact:** Provider stalls can occupy tasks, leases, and request slots longer than expected. Defaults may not match a custom S3 endpoint.

**Best solution:** Configure connect, read, per-attempt, and total operation timeouts; choose retry mode and max attempts explicitly; add retry-attempt metrics. Use different policies for user-facing presign/completion and background cleanup.

**Validation:** Fault-inject DNS, connect, slow-read, 429, and 5xx responses and verify bounded tail latency.

## PERF-065 [P1] Upload abort performs provider cleanup synchronously in the request

**Confidence:** Confirmed

**Evidence:** Vault/legacy abort paths can call multipart abort or object delete before returning.

**Impact:** Canceling a transfer waits on S3 and consumes a request task even though cleanup is naturally asynchronous.

**Best solution:** Atomically mark the intent `aborting`, enqueue a deletion/abort job, release quota reservation, and return `202 Accepted`. Let the worker advance to `aborted`.

**Validation:** Cancellation response latency should remain bounded during provider slowness.

## PERF-066 [P2] Local file streaming allocates a new 64 KiB vector for every chunk

**Confidence:** Confirmed

**Evidence:** Legacy and share-link local downloads use `stream::unfold` and allocate/zero a fresh vector on each read.

**Impact:** Local development/self-hosted downloads create unnecessary allocation and zeroing pressure.

**Best solution:** Use `actix-files::NamedFile` where compatible, `tokio_util::io::ReaderStream`, or a reusable buffer stream. Ensure a read error terminates the stream.

**Validation:** Heap/allocation profiling for a multi-gigabyte local download should show bounded reusable buffers.

## PERF-067 [P0] Encrypted multipart construction repeatedly reallocates and copies the growing part

**Status:** Complete — implemented and verified on 2026-08-12.

**Verification:** Encrypted upload and migration paths now fill a preallocated fixed-size part buffer with a cursor, wipe each consumed source chunk, hand off completed buffers, and expose the final short range as a view without concatenating or slicing it into another allocation. Regression tests prove eight appended chunks complete one part with exactly one allocation, boundary-spanning input is copied once, final-range ownership is preserved, and fragmented migration streams produce exact transferable buffers. A real browser encrypted a 34 MiB file into nine crypto chunks and uploaded one 32 MiB part plus one final part through one batched presign request; MinIO persisted the exact 35,651,728-byte ciphertext with a two-part ETag.

**Confidence:** Confirmed

**Evidence:** `src/features/vault/encrypted-upload.ts::appendBytes` allocates a new array for every encrypted chunk, copies the previous accumulator and new chunk, then zeroes the old accumulator. Full parts are sliced again.

**Impact:** A 32 MiB part built from eight 4 MiB chunks performs hundreds of MiB of memory traffic before upload. CPU and memory bandwidth can become the bottleneck on fast networks.

**Best solution:** Preallocate two or three exact-size part buffers and fill them with an offset. When a buffer is complete, transfer ownership to checksum/upload work and immediately fill another buffer. Handle the final short part without concatenation. Recycle buffers only after upload completion.

**Validation:** Browser profiling should show no accumulator reallocations and peak transfer memory close to the configured number of part buffers.

## PERF-068 [P0] `toArrayBuffer` clones full typed arrays across hot crypto/network paths

**Status:** Complete — implemented and verified on 2026-08-12.

**Verification:** WebCrypto digest/encrypt/decrypt, HKDF/AES imports, HPKE inputs, upload checksums, and `fetch` bodies now receive exact `Uint8Array<ArrayBuffer>` views directly. `toArrayBuffer` returns an owned whole buffer by identity and copies only a partial range for APIs that truly require an exact `ArrayBuffer`; regression tests prove both cases and prove direct views retain their original offset and length. The rebuilt worker completed the real two-part encrypted browser upload through API publication and storage persistence with no browser console warnings or errors.

**Confidence:** Confirmed

**Evidence:** `src/features/vault/protocol.ts::toArrayBuffer` always copies. It is used before WebCrypto digest/encrypt/decrypt and before upload fetches.

**Impact:** Every part/chunk is copied multiple additional times, doubling or tripling memory bandwidth and peak allocation.

**Best solution:** Pass `Uint8Array` views directly where APIs accept `BufferSource` or `BodyInit`. Only create a sliced `ArrayBuffer` when an API requires an exact owned range. Use transferable whole buffers between main thread and worker.

**Validation:** Count transferred/allocated bytes in browser profiles. A full part should not be cloned for both checksum and `fetch`.

## PERF-069 [P1] The crypto worker copies plaintext/ciphertext repeatedly per 4 MiB chunk

**Confidence:** Confirmed

**Evidence:** Encryption pads/copies plaintext, converts to another ArrayBuffer for WebCrypto, concatenates prefixes for hashing, and copies again for digesting.

**Impact:** This creates sustained memory-bandwidth pressure and garbage collection during large uploads.

**Best solution:** For full-size non-final chunks, transfer and encrypt the owned input buffer directly. Allocate padding only for the final chunk. Use incremental hashing or hash prefix and ciphertext without concatenation. Return owned transferable ciphertext buffers.

**Validation:** Per-chunk allocation should be close to one output buffer plus unavoidable WebCrypto internals.

## PERF-070 [P0] Encrypted download assembly has a quadratic-copy accumulator

**Status:** Complete — implemented and verified on 2026-08-14.

**Verification:** Encrypted downloads now fill one exact owned ciphertext buffer per crypto chunk with `ExactStreamReader` and transfer that buffer directly to the crypto worker. The 4 MiB/64 KiB fragmentation regression allocates exactly one 4 MiB buffer, versus more than 30 times that amount in the modeled former growing accumulator, and a wired decryption test assembles two differently sized crypto chunks from fragmented network reads before successful finalization.

**Confidence:** Confirmed

**Evidence:** `src/features/vault/encrypted-download.ts` appends each network chunk by allocating `left.length + right.length`, copies both, zeroes the old buffer, slices a complete ciphertext chunk, then clones it before worker transfer.

**Impact:** Fetch often emits chunks much smaller than the 4 MiB crypto chunk. Copy cost can exceed actual download size by one or two orders of magnitude.

**Best solution:** Fill a fixed 4 MiB-plus-overhead buffer with a cursor, or keep a deque of received chunks and copy each byte exactly once into the final transferable chunk. Use a BYOB reader when supported. Pipeline one network read, a bounded number of decryptions, and ordered writes.

**Validation:** Profile a large download with 64 KiB network chunks. Total JS copy bytes should be near ciphertext size, not tens of times larger.

## PERF-071 [P1] Download fallback retains the full plaintext in memory

**Confidence:** Confirmed

**Evidence:** When the File System Access API is unavailable, decrypted chunks are accumulated as Blob parts and combined at the end.

**Impact:** Large files can approach the 2 GiB limit and exhaust browser memory or crash the tab.

**Best solution:** Prefer a streaming save path: File System Access API, OPFS temporary file followed by export, or a well-audited service-worker stream-to-disk strategy. Enforce a conservative fallback size limit and present a clear compatibility error rather than attempting an unsafe in-memory download.

**Validation:** Test browsers without File System Access at 100 MiB, 1 GiB, and maximum size. Heap must remain bounded or the operation must be rejected early.

## PERF-072 [P0] Encrypted files and multipart parts are processed serially

**Status:** Complete — implemented and verified on 2026-08-14.

**Verification:** Encrypted uploads now use a bounded four-part pipeline with one complete lookahead part, concurrent checksums, one batched presign call, four simultaneous PUTs, ordered completion, and a weighted global scheduler that permits up to three small files while making large files exclusive. Wired integration tests observed three concurrent small-file PUTs and four concurrent multipart PUTs, with presign batches `[1,2,3,4]` then `[5]` and ordered publication; deterministic performance budgets cap pipeline-owned 32 MiB part buffers at five parts (160 MiB) instead of allowing unbounded production.

**Confidence:** Confirmed

**Evidence:** The encrypted selection loop awaits each file, and each part is encrypted/checksummed/presigned/uploaded before the next part begins.

**Impact:** CPU encryption, control-plane latency, and network transfer do not overlap. High-bandwidth clients leave resources idle.

**Best solution:** Build a bounded pipeline: encryption produces complete preallocated parts; checksum and batched presigning prepare them; two to four PUTs run concurrently; completion preserves part order. Set a single global memory/network budget across all files. Allow limited file concurrency only for many small files.

**Validation:** Measure encryption, control, and network timelines. They should overlap while peak memory remains capped.

## PERF-073 [P1] Legacy file uploads are serialized at file level

**Confidence:** Confirmed

**Evidence:** The dashboard intentionally uploads selected files one after another, although multipart parts within one file use concurrency four.

**Impact:** Folders containing many small files are dominated by per-file init/auth/finalization latency.

**Best solution:** Use a global scheduler with bounded file concurrency and a global multipart-part semaphore. For example, allow several small files concurrently while ensuring total active PUTs and hashing buffers stay within a device-specific budget.

**Validation:** Upload 1,000 small files and compare elapsed time, API load, and peak memory. Throughput should improve without multiplying active parts per file.

## PERF-074 [P1] Part checksums require full Blob/ArrayBuffer materialization

**Confidence:** Confirmed

**Evidence:** Legacy checksum code calls `blob.arrayBuffer()` and one-shot WebCrypto SHA-256. Encrypted upload also hashes a complete assembled part and copies it.

**Impact:** At concurrency four and 64 MiB legacy parts, checksum buffers alone can consume hundreds of MiB before XHR/browser internals.

**Best solution:** Use an incremental SHA-256 worker/WASM implementation over `Blob.stream()` for legacy files. For encrypted parts, calculate the S3 checksum in the crypto worker as ciphertext chunks are produced, or hash the already-owned final part buffer without cloning.

**Validation:** Peak checksum memory should be independent of part size beyond the bounded part buffers.

## PERF-075 [P2] Upload retry logic retries errors indiscriminately and reuses potentially expired URLs

**Confidence:** Confirmed

**Evidence:** Client retry loops treat most failures similarly and retry the same signed URL.

**Impact:** Permanent 4xx errors waste time; an expired/signature 403 cannot succeed without a fresh URL; synchronized exponential delays create bursts.

**Best solution:** Classify failures: retry network errors, 408, 429, and selected 5xx with full jitter; refresh a presigned URL on expiry/signature errors; fail immediately on permanent validation errors. Respect `Retry-After`. Remove abort listeners when timers resolve.

**Validation:** Fault-inject each HTTP class and assert the expected retry/presign behavior.

## PERF-076 [P2] Progress reporting can trigger excessive React and worker-message updates

**Confidence:** Confirmed

**Evidence:** XHR progress handlers call React state setters directly, and ZIP progress is posted for every library callback.

**Impact:** High-frequency progress events cause rendering, serialization, and main-thread work unrelated to transfer speed.

**Best solution:** Coalesce progress to one animation frame or 100 to 250 ms, while always emitting start/final/error states. Aggregate per-part progress outside React and publish snapshots.

**Validation:** Record render count and main-thread time during a high-speed upload/ZIP.

## PERF-077 [P1] Repository ZIP download retains all source files and the final archive

**Confidence:** Confirmed

**Evidence:** The client downloads up to four complete files concurrently into `Blob`/`File` objects, retains every source, then `BlobWriter` creates the complete ZIP Blob. The server permits up to 2 GiB total source bytes and 50,000 entries.

**Impact:** Peak browser memory can exceed source size plus archive size, making the advertised maximum unrealistic and causing tab termination.

**Best solution:** Stream files directly into a streaming ZIP writer whose sink is File System Access or OPFS. Do not retain all source files. For legacy-only repositories, optionally offer a server-side streaming archive; for E2EE content, keep plaintext client-side and stream locally. Lower the in-memory fallback limit drastically.

**Validation:** Create repositories containing incompressible 100 MiB, 1 GiB, and 2 GiB data. Heap should remain bounded by a few chunks, not repository size.

## PERF-078 [P1] Repository archive processing opens encrypted files twice

**Confidence:** Confirmed

**Evidence:** The archive flow first calls `vault.openNode` for encrypted entries to resolve names/manifests. Later each encrypted file fetches another download plan and `readEncryptedFileBlob` verifies/opens it again.

**Impact:** This duplicates API calls, signatures, CBOR parsing, wrapper hashing, and manifest decryption for every encrypted file.

**Best solution:** Fetch each plan once and return a reusable verified/opened handle from the vault client. Use the same handle for name resolution and decryption session start. Cache by immutable `(nodeId, recordHash)` for the duration of the archive.

**Validation:** API and plan-verification counts should be one per encrypted node.

## PERF-079 [P2] Repository archive path construction repeatedly walks parents and uses `unshift`

**Confidence:** Confirmed

**Evidence:** For every entry, `buildArchivePath` walks the parent chain and prepends segments.

**Impact:** At 50,000 entries and depth up to 100, client CPU can perform millions of map operations and repeated array shifting.

**Best solution:** Process entries in parent-before-child order and memoize each full normalized path once. Build child paths by appending to the cached parent path. This is O(entries).

**Validation:** Benchmark path construction on broad and deep 50,000-entry trees.

## PERF-080 [P2] ZIP compression uses one fixed level for all content and emits unthrottled progress

**Confidence:** Confirmed

**Evidence:** The worker uses compression level 6 for every file, including already compressed archives, media, and encrypted-looking data.

**Impact:** CPU can be wasted with little size reduction, and progress traffic adds overhead.

**Best solution:** Use STORE or a low level for known incompressible formats and high-entropy samples; use a moderate configurable level for text. Throttle progress. For upload ZIPs, allow a speed-first option.

**Validation:** Compare CPU time and output size across text, source trees, media, and existing archives.

## PERF-081 [P2] Share contexts are fetched and decrypted repeatedly for files with the same parent

**Confidence:** Confirmed

**Evidence:** The encrypted uploader asks for active share contexts while preparing entries and reloads context keys rather than reusing a batch-scoped immutable result.

**Impact:** Folder uploads repeat database queries, envelope verification, and key import for identical share epochs.

**Best solution:** Cache contexts by `(parentId, shareId, epoch, envelopeHash)` for the upload batch and invalidate on rotation/fence errors. Add a batch context endpoint for multiple parent IDs when needed.

**Validation:** Uploading many siblings should fetch/decrypt each distinct share context once.

## PERF-082 [P1] Encrypted folder creation is a complete publication workflow per folder

**Confidence:** Confirmed

**Evidence:** Each encrypted folder is initialized and published individually before children can use its key.

**Impact:** Deep directory imports incur sequential API, database, signature, and wrapper work for every folder.

**Best solution:** Add a batch encrypted-node metadata endpoint that accepts parent-ordered folder records, validates all records set-wise, and inserts them with COPY/multi-row SQL in one bounded transaction. Return IDs/versions as a batch. Preserve parent-key dependencies client-side.

**Validation:** Import a deep 10,000-folder tree and require API/SQL calls to scale by batches, not folders.

## PERF-083 [P2] Encrypted multipart resume information is returned but the client cannot resume safely

**Confidence:** Confirmed

**Evidence:** The server lists existing parts, while the encrypted client rejects or cannot reconstruct an abandoned crypto session and key state.

**Impact:** Provider list calls and response data are wasted, and interrupted large uploads restart from zero.

**Best solution:** Choose one explicit policy. For secure resume, persist the minimal encrypted upload session state and node/generation key material in IndexedDB wrapped by the unlocked root key, plus chunk/part checkpoints. Otherwise abort stale encrypted multipart intents promptly and do not list parts to a client that cannot use them.

**Validation:** Interrupt and restart a large upload. Either it securely resumes verified parts, or cleanup is immediate and the API does not advertise unusable state.

## PERF-084 [P2] Worker dispatch has no per-session ordering guard for future pipelining

**Confidence:** Confirmed

**Evidence:** Worker messages dispatch asynchronous operations directly. Current same-session chunk calls are mostly awaited serially, but a new pipelined client could overlap counter-dependent encryption/decryption operations.

**Impact:** Naive concurrency can race session indices, corrupt ordering, and force serialization bugs that erase the intended throughput gain.

**Best solution:** Add a per-session promise queue or sequence-number state machine. Allow concurrency across sessions, but serialize state transitions within one session while network PUTs overlap outside the worker.

**Validation:** Send deliberately concurrent same-session chunk messages and prove deterministic ordered results.

## PERF-085 [P3] The vault worker bundle is manually emitted under a stable public filename

**Confidence:** Confirmed

**Evidence:** Build scripts bundle large crypto dependencies into `public/vault.worker.js` and reference a stable path.

**Impact:** Depending on hosting cache headers, clients may redownload a large bundle or receive stale code after protocol changes.

**Best solution:** Emit content-hashed worker filenames or a manifest version, serve them with immutable caching, and lazy-load the worker only when vault functionality is used. Consider dynamic chunking only if it does not complicate integrity and CSP.

**Validation:** Inspect transferred bytes and cache status across reloads and deployments.

## PERF-086 [P2] Health checks always consume a database connection

**Confidence:** Confirmed

**Evidence:** `backend/src/routes/health.rs` calls `db.ping()` and exposes pool state for every health request.

**Impact:** Frequent probes add steady pool traffic and can worsen a database incident by competing with recovery work.

**Best solution:** Split `/live` from `/ready`. Liveness should be dependency-free. Readiness may check PostgreSQL, but cache/throttle the result for a short interval and use a dedicated lightweight connection path if necessary.

**Validation:** High-frequency liveness probes should produce zero database queries.

## PERF-087 [P2] Profile avatars disable caching despite versioned URLs

**Confidence:** Confirmed

**Evidence:** Profile/admin avatar routes return `Cache-Control: private, no-store`, while callers include a version query parameter based on update time.

**Impact:** Every render repeats session validation, a database query, and up to 2 MiB of transfer.

**Best solution:** Return versioned avatars with `private, max-age=31536000, immutable`, plus ETag/conditional support. Move image bytes to object storage or a separate table so user-profile writes and backups do not carry large blobs through the hot user relation.

**Validation:** Repeated page loads with the same version should generate no avatar body transfer and ideally no backend hit.

## PERF-088 [P2] Profile multipart data is processed before CSRF validation

**Confidence:** Confirmed

**Evidence:** The profile handler authenticates, then reads and buffers multipart fields including an image, and validates the form CSRF token afterward.

**Impact:** An authenticated invalid request can force up to 2 MiB of body processing and allocation before rejection.

**Best solution:** Put CSRF in a header and validate it from the request principal before reading multipart content. Continue enforcing per-field and total limits.

**Validation:** Invalid-CSRF uploads should be rejected before reading the image stream.

## PERF-089 [P1] No route-level load shedding or expensive-operation concurrency limits are present

**Confidence:** Confirmed

**Evidence:** Actix is configured with logging and a global JSON limit, but no explicit semaphores/rate limits for share publication, recursive jobs, completion reconciliation, or login.

**Impact:** A few expensive requests can monopolize CPU workers, the database pool, or provider operations and inflate p99 latency.

**Best solution:** Add endpoint-class bulkheads: CPU validation semaphore, upload-control rate per user, login rate per IP/account, database-heavy recursive job queue, and S3-operation semaphore. Return 429/503 with retry hints before saturation.

**Validation:** Run mixed-load tests and verify lightweight routes retain their latency target while expensive queues saturate.

## PERF-090 [P2] No explicit HTTP/request timeout policy is defined

**Confidence:** Confirmed

**Evidence:** Actix server uses defaults, while handlers can await database and S3 operations. The AWS policy is also implicit.

**Impact:** Slow clients or dependencies can keep request tasks and resources alive too long.

**Best solution:** Configure header/read/keepalive/shutdown limits at the server or ingress and operation-specific deadlines inside handlers. Do not apply a timeout that can cancel a database mutation after commit without idempotency; use request IDs and state machines.

**Validation:** Fault tests must demonstrate bounded task lifetime and correct retry/idempotency behavior.

## PERF-091 [P2] Response compression is not enabled in the Rust application

**Confidence:** Confirmed

**Evidence:** `main.rs` installs `Logger` but not Actix `Compress`; large file lists, repository manifests, and base64 metadata therefore rely entirely on upstream behavior.

**Impact:** Text-heavy JSON and base64 metadata use more bandwidth and add user-visible latency on slower links.

**Best solution:** Enable selective Brotli/gzip at the ingress or Actix for compressible JSON. Avoid wasting CPU on ciphertext/object bodies. Binary CBOR remains the better long-term solution for cryptographic payloads.

**Validation:** Measure compressed bytes and CPU for listings, archive manifests, and vault plans.

## PERF-092 [P2] Required-E2EE mode performs a global distinct count at startup

**Confidence:** Confirmed

**Evidence:** `main.rs` counts distinct pending nodes from legacy files and incomplete migrations before accepting traffic.

**Impact:** Boot time grows with total file/migration rows and can delay recovery or autoscaling.

**Best solution:** Use indexed `EXISTS` checks if only readiness is required, or maintain a migration-summary counter. If the exact count is useful for diagnostics, calculate it asynchronously after startup.

**Validation:** Startup query time should remain flat as encrypted history grows.

## PERF-093 [P2] Request logging records high-frequency upload control calls

**Confidence:** Confirmed

**Evidence:** Default Actix logging is enabled and excludes only one share-access pattern.

**Impact:** Multipart presign/status traffic can generate large synchronous/formatting/log-ingestion overhead and obscure useful events.

**Best solution:** Use structured tracing with route templates, sample high-volume successful control calls, exclude liveness, and retain complete error/slow-request logs. Never log tokens or cryptographic payloads.

**Validation:** Measure log events and CPU per GiB upload before and after sampling.

## PERF-094 [P0] The repository has no performance observability or load-regression harness

**Status:** Complete — implemented and verified on 2026-08-14.

**Verification:** The backend now emits structured sampled request traces with request IDs, route-template latency/status/body/DB-checkout metrics, pool-checkout metrics, maintenance-worker metrics, `Server-Timing`, and a token-protected Prometheus endpoint. PostgreSQL preloads `pg_stat_statements`; the full migration chain enabled version 1.12 and the live statistics view contained normalized queries. Deterministic transfer budgets and a scheduled/PR CI workflow guard the fixed copy and concurrency invariants. The repeatable local HTTP check completed 250 of 250 requests at concurrency 20 with zero errors and 3.33 ms p95 against a 250 ms threshold, while also verifying the protected route metric.

**Confidence:** Confirmed

**Evidence:** No tracing/OpenTelemetry/Prometheus integration, Criterion benchmark, backend integration/load test, or SQL plan regression suite was found.

**Impact:** Optimization decisions cannot be validated, regressions remain invisible, and pool/S3/query bottlenecks are diagnosed only after user impact.

**Best solution:** Add `tracing` spans with request IDs and stage timings; Prometheus/OpenTelemetry metrics for request latency, pool checkout, SQL family, S3 operation/attempt, upload bytes/stages, queue age, lock waits, and worker CPU; enable `pg_stat_statements`; keep sampled slow-query plans in staging. Add repeatable k6/Vegeta and browser Playwright benchmarks to CI/nightly jobs.

**Validation:** Every top finding should have a before/after metric and a regression threshold.

## PERF-095 [P3] Release compilation is not tuned for maximum runtime performance

**Confidence:** Tuning

**Evidence:** `backend/Cargo.toml` has no custom release profile.

**Impact:** Rust's default release profile is already optimized, but thin/fat LTO and fewer codegen units can improve CPU-heavy validation at the cost of build time and binary characteristics.

**Best solution:** After algorithmic fixes, benchmark `[profile.release] lto = 'thin'`, `codegen-units = 1`, and an appropriate `panic` strategy. Do not expect compiler flags to compensate for network round trips or O(R×W) protocol work.

**Validation:** Use identical load tests and CPU profiles for default versus tuned builds.

## PERF-096 [P3] Hex encoding allocates repeatedly in share-link listing

**Confidence:** Confirmed

**Evidence:** `sha256_hex` formats each byte with `format!` while reconstructing link URLs.

**Impact:** This is minor but avoidable on list paths.

**Best solution:** Use a preallocated buffer and `write!`, or a small audited hex encoder. This should be done only with adjacent share-link fixes.

**Validation:** Microbenchmark only after higher-priority work.

## PERF-097 [P2] Repository and share metadata responses are broadly `no-store`

**Confidence:** Confirmed

**Evidence:** Several private/shared responses disable all caching even when records have immutable hashes or explicit versions.

**Impact:** Repeated navigation refetches and re-verifies unchanged metadata.

**Best solution:** Use ETags based on record/tree version and conditional GET for authenticated metadata. Keep truly sensitive or revocation-critical responses private and short-lived. Immutable cryptographic records addressed by hash can be cached safely after authorization, while access grants must be revalidated.

**Validation:** Repeated unchanged navigation should return 304 or use a local immutable cache without weakening revocation.

## PERF-098 [P2] Repository archive manifest materializes up to 50,001 rows into one JSON response

**Confidence:** Confirmed

**Evidence:** The backend recursive query collects the full tree into a `Vec<Row>`, then serializes every entry at once.

**Impact:** Large manifests consume backend memory, database result buffers, Next proxy memory, wire time, and browser parse memory before any file transfer begins.

**Best solution:** Stream or page the manifest in parent-before-child order. Use NDJSON/CBOR sequence or cursor pages and let the client begin path preparation/downloads immediately. Include a stable tree version so pages form one snapshot.

**Validation:** Backend RSS and time-to-first-file should remain bounded for 50,000-entry repositories.

## PERF-099 [P2] Repository summary/create/update reloads data after mutation

**Confidence:** Confirmed

**Evidence:** Repository create/update routes validate or mutate, then call `get_repository_summary` as another query.

**Impact:** Extra round trips add latency to a simple operation.

**Best solution:** Use `INSERT ... SELECT` for root validation and `RETURNING` joined data via a CTE, or return the mutation result and fetch details only when the client actually needs them.

**Validation:** Repository mutation SQL count should drop without changing conflict semantics.

## PERF-100 [P2] Invitation and admin creation paths use check-then-act round trips

**Confidence:** Confirmed

**Evidence:** Invitation/user creation performs existence checks, expiry updates, another pending check, and insertion as separate calls.

**Impact:** Latency is higher and races still require database constraints to resolve.

**Best solution:** Express the operation in one transaction/CTE and rely on the existing unique pending-username index and a case-insensitive user uniqueness constraint. Hash passwords outside the DB, then insert once.

**Validation:** Concurrent duplicate creation should resolve deterministically with one short transaction.

## PERF-101 [P2] Share-link token rotation is deterministic and does not actually rotate the URL token

**Confidence:** Confirmed

**Evidence:** `token_for_link(secret, link_id)` is deterministic. The rotate endpoint calls it with the same link ID and secret, so it regenerates the same token.

**Impact:** This is primarily a correctness/security defect, but it also makes rotation work and cache invalidation pointless.

**Best solution:** Store a random per-link token/version or nonce. On rotation, generate a new random token, store only its hash, and invalidate the old token atomically. If deterministic recovery is required, include a monotonically increasing token version in the MAC input and URL.

**Validation:** Create a link, rotate it, and assert that the new URL differs and the old URL is rejected.


---

# Recommended target architecture

## 1. Request path

1. Ingress routes `/api/*` directly to Rust and page/static traffic to Next.js.
2. Auth middleware hashes the cookie token once, performs one slim session query, and attaches `SessionPrincipal`.
3. CSRF is validated from that principal before body parsing.
4. Route-specific body limits and concurrency bulkheads reject work before saturation.
5. Multi-query handlers acquire one client and pass it through repository functions.
6. CPU-heavy cryptographic validation moves to a bounded CPU pool after cheap validation.

## 2. Upload control plane

The ideal multipart lifecycle is:

1. **Initialize:** one transaction atomically reserves quota and inserts the upload intent.
2. **Prepare:** client encrypts/hashes into a bounded buffer pipeline.
3. **Batch presign:** one request signs 8 to 32 checksummed parts after one authorization/upload validation.
4. **Transfer:** browser uploads two to four parts concurrently directly to S3.
5. **Complete:** one idempotent completion claimant calls S3, consumes completion metadata, and publishes in one short database transaction.
6. **Status:** database-only job status, no repeated S3 HEAD.
7. **Abort:** short state transition plus asynchronous cleanup.
8. **Reconcile:** dedicated maintenance pool, correct union of all live intent tables, bounded provider concurrency, and lifecycle-rule backstop.

A 2 GiB encrypted upload should use roughly 2 to 8 batch-presign requests rather than 64 individual presign requests, and it should keep only a few 32 MiB buffers live.

## 3. PostgreSQL write model

- Replace file/admin/share row-level counter triggers with statement-level aggregate deltas.
- Keep strict quota reservation in a small dedicated ledger.
- Bulk-load cryptographic rows with COPY/staging.
- Add exact partial indexes for global worker claims.
- Maintain repository/tree summaries incrementally.
- Use one-time versioned migrations and online backfills.
- Use a separate maintenance pool and monitor lock/checkout time.

## 4. Vault share protocol v2

A scalable share epoch should contain:

- `share_id`, `epoch`, sender/recipient identity scope
- one `wrapper_set_root` and `wrapper_count`
- the encrypted epoch key for the recipient
- a signature over those fields

The server stores wrappers once. A per-node download returns only the required metadata/generation wrappers and Merkle inclusion proofs. The owner node record no longer carries every share wrapper. This changes:

- Share publication from O(recipients × wrappers) metadata to O(recipients + wrappers)
- Per-recipient envelope size from O(wrappers) to O(1)
- Per-node shared download verification from O(all wrappers) to O(log wrappers)
- Ordinary node publication from O(overlapping shares) owner-record growth toward near-constant owner metadata

This is the largest long-term protocol improvement in the audit.

## 5. Browser data plane

- Preallocated part-buffer pool
- Zero-copy transferable buffers
- Incremental checksum in the crypto/hash worker
- Bounded encryption, presign, and PUT stages
- Fixed-buffer/deque download assembly
- Explicit session cancellation and bounded key caches
- Streaming ZIP output to File System Access or OPFS
- Global memory/network scheduler across all selected files
- Throttled progress snapshots

---

# Prioritized implementation plan

## Phase 0: correctness guards

1. Fix multipart reconciliation to include `vault_uploads` and separate namespaces.
2. Include all vault upload/generation state in asynchronous user deletion.
3. Fix deterministic share-link rotation.
4. Change the encrypted multipart threshold so a one-part multipart upload is impossible.
5. Add tests for multi-replica reconciliation, expiry, abort, and deletion.

## Phase 1: low-risk, high-return latency changes

1. Add slim request-scoped session/CSRF authentication.
2. Add global partial expiry indexes and the envelope lookup index.
3. Return completion metadata and remove normal-path HEAD.
4. Make upload status database-only.
5. Split liveness/readiness.
6. Move login bcrypt and session cleanup off the request database path.
7. Route `/api` directly to Rust where deployment permits.
8. Add tracing, pool metrics, S3 metrics, and `pg_stat_statements`.

## Phase 2: upload pipeline

1. Atomic reservation ledger.
2. Batch part-presign API.
3. Preallocated encrypted part buffers and zero-copy transfers.
4. Incremental checksums.
5. Bounded parallel PUTs and limited small-file concurrency.
6. Asynchronous abort/finalization jobs.
7. Correct retry classification and jitter.

## Phase 3: set-based PostgreSQL

1. Statement-level counter triggers or explicit bulk deltas.
2. COPY/staging for wrappers and envelopes.
3. Statement-level epoch validation.
4. Batch encrypted folder publication.
5. Repository summary counters/tree version.
6. Versioned migrations and online backfills.
7. Measure and prune overlapping indexes.

## Phase 4: share protocol v2

1. Wrapper-set root commitment.
2. Per-node inclusion proofs.
3. Decouple owner records from share wrapper sets.
4. Batch/stream subtree share preparation.
5. Compatibility reader for protocol v1 and a controlled re-publication migration.

## Phase 5: tree and archive scaling

1. Upward membership checks or materialized paths.
2. Keyset pagination everywhere.
3. Streaming repository manifests.
4. Streaming ZIP output.
5. Bounded key/path caches.

---

# Concrete database changes to start with

The exact migration names and `CONCURRENTLY` usage should follow your deployment process.

```sql
CREATE INDEX CONCURRENTLY file_uploads_global_expiry_idx
ON file_uploads (expires_at, id)
WHERE status IN ('initializing', 'pending', 'completing', 'aborting');

CREATE INDEX CONCURRENTLY vault_uploads_global_expiry_idx
ON vault_uploads (expires_at, id)
WHERE status IN ('initializing', 'pending', 'completing', 'aborting');

CREATE INDEX CONCURRENTLY vault_share_envelopes_lookup_idx
ON vault_share_envelopes
  (share_id, epoch, recipient_id, created_at DESC);

CREATE INDEX CONCURRENTLY vault_migrations_legacy_object_idx
ON vault_migrations (legacy_object_key)
WHERE legacy_object_key IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY users_username_lower_unique_idx
ON users (lower(username));
```

For a reservation ledger, the important property is one conditional write, not the exact table name:

```sql
UPDATE user_storage_usage
SET reserved_bytes = reserved_bytes + $2,
    pending_uploads = pending_uploads + 1,
    updated_at = now()
WHERE owner_id = $1
  AND used_bytes + reserved_bytes + $2 - $3 <= quota_bytes
  AND pending_uploads < $4
RETURNING used_bytes, reserved_bytes, pending_uploads;
```

The upload intent must be inserted in the same transaction. Publish/abort must release the reservation with an idempotent state transition so retries cannot double-decrement.

---

# Benchmark and profiling plan

## Required instrumentation

Backend:

- Route-template request count, p50/p95/p99, response bytes
- Request body bytes and body-parse time
- Session/auth time
- Pool checkout wait and checked-out duration
- SQL family count and duration, not raw sensitive SQL parameters
- Transaction duration and lock-wait time
- S3 operation, attempt count, duration, status, bytes
- Upload stage timings: init, presign, encrypt client metric, PUT, complete, publish
- Maintenance queue age, claim count, lease expiry, attempts, dead letters
- CPU-pool queue and task duration
- Worker/task panic/restart counter

PostgreSQL:

- `pg_stat_statements`
- `pg_stat_user_indexes`
- `pg_stat_user_tables`
- WAL bytes and dead tuples
- Row-lock and relation-lock waits
- Slow plans in staging with `auto_explain`
- `EXPLAIN (ANALYZE, BUFFERS, WAL)` for every query changed by this report

Browser:

- JS heap and worker heap
- ArrayBuffer allocation/copy volume
- Main-thread long tasks
- Worker message count
- Encryption/checksum/upload overlap
- Active PUT count and throughput
- React render count during progress
- Time to first byte/file for repository archives

## Scenario matrix

1. One 1 MiB file
2. One 100 MiB file around single/multipart threshold
3. One 2 GiB encrypted file
4. 1,000 small files in a flat folder
5. 1,000 files with shared depth-10 paths
6. Ten concurrent users uploading large files
7. One user starting many concurrent uploads
8. Share a 10, 1,000, and 50,000-node subtree
9. Rotate shares with 1, 10, and 100 recipients
10. Navigate a 50,000 and 1,000,000-node repository
11. Generate repository ZIPs with compressible and incompressible data
12. Process 100,000 deletion jobs and expired uploads
13. Run a mixed workload while S3 returns latency, 429, and 5xx faults
14. Run a mixed workload while PostgreSQL pool capacity is intentionally constrained

## Initial acceptance targets

Targets must be adjusted to deployment geography and hardware, but useful first gates are:

- No full-table or full-subtree scan in ordinary file/repository navigation.
- One session query per authenticated request, zero separate CSRF query.
- One database checkout for ordinary multi-query handlers.
- One batch-presign request per 8 to 32 parts.
- No S3 HEAD on normal successful completion.
- Database-only status polling.
- Browser peak transfer memory bounded by configured buffer count.
- No upload/download accumulator whose copy cost grows quadratically.
- Bulk share SQL statement count nearly constant with row count.
- Empty maintenance polling reduced by at least 10x.
- Lightweight endpoint p99 remains stable when expensive operations saturate their own bulkhead.
- No counter-row write for an update that changes no counted field.
- No active upload can be aborted by orphan reconciliation.
- Every cancellation releases client crypto-session state and server reservation state.

---

# What not to optimize first

Do not begin with Rust compiler flags, hand-written base64 loops, tiny string allocations, or a larger database pool. Those may help later, but they cannot compensate for:

- O(recipients × wrappers) share metadata
- one API/auth/database sequence per multipart part
- row-at-a-time SQL
- repeated whole-buffer copying
- full-tree recursive work on navigation
- a serial maintenance worker

Fix multiplication of work first. Then profile the remaining CPU hotspots.

---

# Final priority list

The five changes most likely to transform Aeralyth's real performance are:

1. **Correct and redesign upload control:** live-intent reconciliation, atomic reservations, batch presigning, no normal-path HEAD, async cleanup.
2. **Replace browser buffer concatenation with a bounded zero-copy pipeline.**
3. **Replace row-at-a-time vault SQL and row-level triggers with COPY/set-based validation and statement-level deltas.**
4. **Move share commitments to a single wrapper-set Merkle root and decouple share wrappers from owner node records.**
5. **Remove full-tree work from ordinary navigation and stream large repository/archive operations.**

After those, Aeralyth's throughput should be governed mainly by client cryptography and S3 bandwidth, which is the correct shape for an end-to-end encrypted storage system.
