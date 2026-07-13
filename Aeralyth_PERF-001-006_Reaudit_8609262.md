# Aeralyth critical performance re-audit: PERF-001 through PERF-006

**Audit date:** 2026-07-13  
**Repository:** `AdminGodZ/Aeralyth`  
**Reviewed head:** [`86092629c982c8ff36f6834d1df8443799ff2591`](https://github.com/AdminGodZ/Aeralyth/commit/86092629c982c8ff36f6834d1df8443799ff2591) (`master`)  
**Fix PR:** #25, `perf: resolve critical audit findings`  
**Original audit baseline:** `35b3278109c905ca1120a0c3cacf534e98d0cb1c`  
**Scope:** PERF-001 through PERF-006 only

## Decision

Not all six findings can be closed.

- **Critical implementation status:** 5 of 6 original critical defects are removed.
- **Still open:** **PERF-001**.
- **Correctly addressed in code:** **PERF-002, PERF-003, PERF-004, PERF-005, and PERF-006**.
- **Production release status:** **not ready to approve yet**. PERF-001 has a reproducible crash-boundary leak on Railway, and the infrastructure-dependent acceptance tests for the other findings have not been demonstrated in GitHub CI or a live Railway environment.

## Status matrix

| ID | Code verdict | Production acceptance | Close? |
|---|---|---|---|
| PERF-001 | Direct S3 architecture is largely correct, but multipart cleanup is not crash-safe | Not run; static review already finds failures | **No — reopen** |
| PERF-002 | Request-path scans and blocking production file work are removed | Live 100-to-100,000-object latency/event-loop test not run | **Yes in code; acceptance pending** |
| PERF-003 | Single connection is replaced by a bounded, recovering PostgreSQL pool | Saturation/restart/recovery test not run | **Yes in code; acceptance pending** |
| PERF-004 | Download controls are native anchors and the API redirects to signed S3 GETs | Authenticated browser network test not run | **Yes in code; acceptance pending** |
| PERF-005 | ZIP worker is bundled into executable browser JavaScript | Production build and worker ZIP smoke test passed | **Yes** |
| PERF-006 | File/admin collections and summaries are bounded and keyset-paginated | 100,000-file/equal-key/INP test not run | **Yes in code; acceptance pending** |

## PERF-001 — reopen: multipart uploads can leak permanently

The intended design is present: production fails closed without S3, bytes travel directly between the browser and S3, multipart uploads support checksums/resume, completion verifies object metadata, downloads use signed redirects, and deletion uses PostgreSQL jobs. The remaining defects are inside the critical failure boundaries of that design.

### 1. A hard crash can create an untracked multipart upload

`backend/src/storage.rs:176-195` calls `CreateMultipartUpload`. `backend/src/routes/files.rs:362-371` invokes that external operation before the durable `file_uploads` insert, which begins around `files.rs:446`.

A process kill after S3 creates the upload but before PostgreSQL records its ID leaves an incomplete multipart upload that no database-driven cleanup job can discover. `CreateMultipartUpload` is not idempotent, and the application has no `ListMultipartUploads` reconciliation for sessions absent from PostgreSQL.

This cannot be delegated to a Railway lifecycle rule: Railway currently supports multipart uploads but lists **bucket lifecycle configuration as not yet supported** in its [Storage Buckets documentation](https://docs.railway.com/storage-buckets).

**Required fix:**

1. Persist an `initializing` upload intent, including its unique object key, before calling S3.
2. Add a scheduled, singleton reconciliation pass using `ListMultipartUploads` for the application prefix.
3. Match listed sessions against durable intents/known upload IDs and abort unknown sessions older than a conservative grace period.
4. Use a PostgreSQL advisory lock or one dedicated Railway worker so replicas do not run the same bucket sweep concurrently.

A durable intent alone is insufficient because a crash can still occur after S3 creates the upload and before its upload ID is saved; provider-side listing/reconciliation is required when lifecycle cleanup is unavailable.

### 2. Abort errors are discarded, then cleanup state is falsely finalized

Two cleanup paths ignore `AbortMultipartUpload` failures:

- `backend/src/storage.rs:560-573` in `process_deletion_jobs`
- `backend/src/storage.rs:712-728` in abandoned-upload cleanup

Both continue to `DeleteObject`. Deleting an object key can succeed even though an incomplete multipart session still exists. The first path then deletes its durable cleanup job; the second marks the upload `aborted`. The leaked multipart parts no longer have a retry path.

**Required fix:**

- Propagate transient abort failures and retain/retry the deletion job or upload cleanup state.
- Treat a confirmed `NoSuchUpload` as idempotent success.
- Delete the job or mark the upload `aborted` only after the multipart abort, when applicable, and object deletion have both reached an idempotent success state.
- Record the abort failure in `last_error` and apply the existing retry backoff.

### 3. Presigned writes do not bind the reserved byte count

The presigning code at `backend/src/storage.rs:223-229` and `:252-259` signs the key/checksum/content type but not the exact `Content-Length`. An authenticated client can reserve a small quota amount and upload a larger single object or part. Finalization may reject it later, but the oversized storage has already been consumed and depends on the currently unsafe cleanup path.

**Required fix:**

- Bind the exact expected `Content-Length` in each signed single PUT.
- For multipart, calculate and bind the exact size of each part, including the smaller final part.
- Make the browser send the signed length and reject any mismatch before upload.

### 4. `202 completing` is treated as completed by the browser

`backend/src/routes/files.rs:711-716` returns `202 Accepted` when an upload is already `completing`. `src/features/dashboard/upload-panel.tsx:338-349` treats every successful 2xx completion response as finished. In an ambiguous finalize/crash case, the user can be sent back to a file list where the file remains invisible until the five-minute reconciliation boundary.

**Required fix:**

- Return an explicit upload status and polling URL with `202`.
- Poll with bounded backoff until `completed` or a terminal failure; only then refresh/navigate as success.
- Alternatively, make a repeated complete request actively reconcile the object with `HeadObject` and finish the PostgreSQL transition before returning success.

### PERF-001 acceptance tests required before closure

- Kill the API immediately after `CreateMultipartUpload` and before the database insert; verify the unknown multipart session is discovered and aborted.
- Inject a transient `AbortMultipartUpload` failure; verify durable cleanup state remains and later succeeds.
- Attempt an oversized single PUT and oversized part; both must be rejected by the signed request.
- Retry completion while state is `completing`; the UI must not report success until metadata is active.
- Interrupt and resume a 1–2 GB multipart upload, verify only missing parts are resent, and verify final integrity.
- Upload via replica A, authorize/download via replica B, redeploy both, and verify persistence.
- Verify a range download returns `206` from storage.

## Correctly addressed critical findings

### PERF-002 — pass in code

- Recursive storage scans, `statvfs`, blocking `std::fs`, and bucket listing are absent from request paths.
- Production storage operations use S3; bounded local-development operations use `tokio::fs`.
- File/storage summaries read PostgreSQL-maintained `user_file_counters`.
- Object deletion is moved to durable PostgreSQL jobs.

The original request-path blocking and O(all stored objects) latency defect is removed.

### PERF-003 — pass in code

- `backend/src/db.rs` uses a bounded `deadpool-postgres` pool instead of one global PostgreSQL connection.
- Acquire/connect/create/recycle/query/lock/idle-transaction/lifetime controls are configured.
- Normal query helpers use per-connection cached statements.
- Admin transactions acquire pooled clients rather than opening ad hoc TCP connections.
- Health checks ping PostgreSQL and expose pool availability/waiters.

The original API-wide single-connection serialization and no-reconnect failure are removed. Runtime pool sizing must still obey:

`pool_max_per_replica × maximum_replica_count + maintenance/migration reserve < PostgreSQL max_connections`

### PERF-004 — pass in code

- Both download actions in `src/features/dashboard/dashboard-shell.tsx` use native `<a>` elements, not `next/link`.
- `backend/src/routes/files.rs:1000-1018` authorizes and returns a `302` to a short-lived signed S3 GET.
- The signed response includes the intended content disposition.

This removes Next.js route prefetch/navigation behavior from blob downloads.

### PERF-005 — pass and locally production-verified

- `prebuild` runs an explicit esbuild worker bundle.
- `upload-panel.tsx` loads `/folder-zip.worker.js` as a module worker.
- A clean Next.js 16.2.10 production build completed successfully.
- The generated worker passed JavaScript syntax checks, contained no unresolved TypeScript/path-alias/package imports, and was served as `application/javascript`.
- An isolated worker-compatible runtime smoke test compressed `tiny-folder/hello.txt` and returned a valid 210-byte ZIP beginning with `PK\x03\x04`.

The original raw-TypeScript worker release blocker is removed.

### PERF-006 — pass in code

- File and admin pages default to 50 rows and hard-cap at 100.
- Queries use stable keyset cursors and fetch `page_size + 1` to derive `hasMore`.
- File cursor context includes the current view/folder/sort/direction and stable tie-breakers.
- ASC/DESC predicates for name, size, and time sorts were checked against their `ORDER BY` clauses; no static duplicate/omission defect was found.
- User and invitation cursors use matching timestamp/ID orders.
- Search/sort are server-side, summaries use bounded counter rows, and the client renders only the returned page.

The original unbounded response, aggregate, serialization, and DOM defect is removed.

## Verification record and limitations

- GitHub `master` was rechecked at the end of the audit and still pointed to `86092629c982c8ff36f6834d1df8443799ff2591`.
- GitHub reports no Actions workflow runs associated with this merge commit.
- Frontend dependencies installed cleanly and the production Next.js build/worker smoke tests passed.
- This review environment did not provide a Rust toolchain, live PostgreSQL, authenticated Railway deployment, or Railway S3 credentials. Backend compilation, load, crash, cross-replica, range, and database-recovery tests therefore remain unexecuted.
- No repository code or GitHub state was changed by this re-audit.

## Final close rule

Do not close the critical performance milestone until:

1. all four PERF-001 defects above are fixed,
2. the PERF-001 crash/abort/oversize/completing tests pass,
3. the original Railway/PostgreSQL/browser acceptance tests for PERF-002, PERF-003, PERF-004, and PERF-006 are captured as repeatable CI or staging evidence.

