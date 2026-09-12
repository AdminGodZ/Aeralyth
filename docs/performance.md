# Performance verification and observability

Aeralyth keeps performance regressions visible at three layers: deterministic
browser-pipeline budgets, a repeatable HTTP load check, and protected runtime
metrics. These checks intentionally leave the application UI and UX unchanged.

## Regression checks

Run the deterministic vault budgets with:

```sh
npm run test:performance
```

The suite protects the encrypted transfer invariants that are easy to regress:

- a 4 MiB crypto download split into 64 KiB network reads gets one exact output
  allocation instead of a growing accumulator;
- encrypted multipart uploads refill each available slot as a part completes,
  with four active parts and at most one prepared part, preserving ordered
  publication within the five-part buffer ceiling;
- up to three small files may overlap. Large-file encryption and upload reserve
  the full content-buffer budget, while other files may initialize or finalize
  without holding a content permit;
- folder preparation follows parent dependencies and publishes bounded batches.
  Files start when their own parent is durable, while unrelated folder branches
  continue preparing.

Run the API load check against a local server with:

```sh
npm run perf:http
```

The default check sends 250 dependency-free liveness requests to
`http://127.0.0.1:8080/health` at
concurrency 20 and fails above 250 ms p95 latency or any HTTP error. It refuses
remote hosts unless `AERALYTH_PERF_ALLOW_REMOTE=1` is explicit. Adjust controlled
test runs through `AERALYTH_PERF_URL`, `AERALYTH_PERF_REQUESTS`,
`AERALYTH_PERF_CONCURRENCY`, `AERALYTH_PERF_MAX_P95_MS`, and
`AERALYTH_PERF_MAX_ERROR_RATE`.

Latency thresholds are matched-run guardrails, not a claim that every device or
network has the same absolute speed. Compare the same scenario, data size,
browser, backend build, and storage endpoint before and after a change.

Use `/health/ready` when the check must include PostgreSQL. Readiness results are
cached for two seconds so concurrent probes share one database ping.

## Runtime metrics and request tracing

Set a random token of at least 32 bytes in `AERALYTH_METRICS_TOKEN` to enable the
protected `/metrics` and `/api/metrics` endpoints. Scrape with:

```sh
curl -H "Authorization: Bearer $AERALYTH_METRICS_TOKEN" http://127.0.0.1:8080/metrics
```

Without a configured token the endpoint returns 404; an invalid token returns
401. Metrics use matched route templates rather than raw URLs, preventing IDs or
tokens from becoming labels. Current coverage includes:

- header latency, completed-body latency, consumed request bytes, yielded response
  bytes, status, and request-scoped database checkouts;
- database pool size, waiters, checkout latency, and failures;
- admission-gate wait time;
- active SSE streams, stream lifetime, reconnects, termination reasons, and event
  delivery lag;
- maintenance-worker latency, failures, and supervisor restarts;
- process uptime and build information.

The header histogram measures the response becoming available. The ordinary
request histogram and byte totals finish when the body completes, errors, or is
cancelled. Long-lived SSE bodies use their own lifetime metrics and do not distort
ordinary HTTP percentiles. Handler error responses are counted; rare raw service
errors that bypass body wrapping carry the `unobserved_service_error` outcome.
Yielded response bytes measure the application handing data to the transport,
not a remote client's acknowledgment. The mixed gate measures its own provider
transfers through complete download and ciphertext verification; browser transfer
telemetry measures the browser's direct provider path.

Responses include `x-request-id` and `server-timing`. Successful request logs are
sampled; successful health probes are excluded and successful multipart
presign/status controls use one tenth the normal sampling frequency. Separate
4xx, 5xx, and slow-request budgets admit up to 20 log events per second per class.
Suppressed events remain visible in counters. The logger uses a nonblocking
queue of at most 1,024 events with a 64 KiB cap per event, and exports queue,
dropped-event, and writer-error metrics. Shutdown permits a two-second drain and
records timeout rather than blocking indefinitely on a stalled log sink.
The queue carries operational diagnostics. Durable application state and realtime
event records keep their database write paths; the queue does not provide a
reliable security-audit stream.

Logs contain matched route templates and aggregate byte/count data, never URL
tokens, request bodies, or cryptographic payloads. Configure
`AERALYTH_REQUEST_SUCCESS_SAMPLE_RATE` (default 100),
`AERALYTH_REQUEST_SLOW_MS` (default 500), and `AERALYTH_STRUCTURED_LOGS`.
Production defaults to JSON logs.

When `AERALYTH_METRICS_TOKEN` is present, `npm run perf:http` also verifies that
the protected scrape contains the exercised route.

Run the body-completion, disconnect, bounded-logger, and concurrent-scrape
regressions with:

```sh
cargo test --locked --manifest-path backend/Cargo.toml observability::tests -- --include-ignored --nocapture
```

This command includes the loopback streaming tests and the comparative metrics
contention measurement in CI. A local September 12 comparison used 128 metric
series, 100 scrapes, and 10,000 observations. Three runs measured 184.750,
183.723, and 185.811 ms of aggregate observation-lock wait while formatting under
the lock, compared with 0.545, 0.583, and 0.586 ms when formatting an owned
snapshot after releasing it. Those are synthetic contention measurements on the
local machine. Observation-lock wait p99 differences were near the noise level,
so they do not establish an HTTP request-latency improvement. The test checks consistent counters and
bounded state without enforcing a hardware-sensitive timing ratio.

## Local external logging and scrape probe

`performance/observability-probe.mjs` starts the existing release binary in the
explicitly isolated September 12 audit environment. It offers 200 requests per
second across expected successful, rejected, and database-error responses. It
compares normal scrapes, frequent scrapes, a second normal window, and a
20-second pause of all stdout reads. The script checks complete response bodies,
arrival drops, route counters, queue capacity, overflow accounting, memory,
restoration of the deliberate database fault, and process shutdown. Its exact
validation-script hashes are separate from the prebuilt application identity.

The final local run completed all 7,000 measured operations with their expected
status and no dropped arrivals. The mix deliberately included 1,400 HTTP 400 and
1,400 HTTP 500 responses; these are fault scenarios, not successful application
requests. HTTP p99 was 3.038 ms with normal scrapes, 3.206 ms at 45.96 scrapes per
second across 39 route/status series, 2.925 ms in the repeated normal window, and
3.007 ms while stdout consumption was paused. The paused sink filled the
1,024-event queue and caused 1,904 overflow drops by the end of that phase. The
queue drained after reads resumed; dropped and suppressed diagnostics remained
visible in counters, with no writer error. Maximum sampled API RSS growth was
2,080,768 bytes, and shutdown completed in 313 ms.

These are short, sequential measurements of a small request mix on one local
release artifact. They verify bounded behavior under the measured scrape and
logging rates; they do not establish production capacity or a universal p99
improvement. The first attempt had an incorrect harness expectation for an
unauthenticated request. Its failed capture is retained alongside the corrected,
independently reviewed run in
[`final-native-2026-09-12`](../performance/results/final-native-2026-09-12/observability-probe.json).

## PostgreSQL query statistics

The Compose database preloads `pg_stat_statements`, and migration 007 enables
the extension. Existing environments should recreate only the PostgreSQL
container with the new Compose command, retain the named data volume, and then
run `npm run db:migrate`. Confirm collection with:

```sql
SELECT queryid, calls, total_exec_time, mean_exec_time, rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

Use normalized query IDs and staging-only `EXPLAIN (ANALYZE, BUFFERS)` samples;
never export raw parameters or production secrets.

## Release and production comparison

The backend latency job builds `backend/target/release/aeralyth-api` once with
`cargo build --release --locked --manifest-path backend/Cargo.toml` and starts
that exact binary for HTTP, authentication, realtime, and mixed-workload checks.
The correctness checks retain their existing E2EE-off configuration. The mixed
workload restarts the same artifact with E2EE migration mode and isolated MinIO
storage, matching the production image's encrypted upload configuration.

Both the direct release run and the production image run execute
`node performance/mixed-load.mjs` with the same arrival rate, duration,
concurrency, timeout, and latency limits. The image run reaches Actix through the
bundled Caddy listener and uploads directly to MinIO using the original presigned
URL. CI maps `aeralyth-s3-smoke` to loopback on the runner and to the storage
container on the Docker network, so the signed hostname stays unchanged.

Direct release and debug runs use two allowed CPU cores. The production image
has a two-CPU quota and a 2 GiB memory limit shared by Actix, Next.js, and Caddy.
The direct runs use the runner's available memory; their resource record includes
the actual CPU affinity and host memory. Compare those configurations explicitly
when interpreting a difference between direct API and whole-image results.
Both configurations use a request database pool of eight and a maintenance pool
of two.

Download the `backend-performance-<commit>` and
`production-performance-<commit>` workflow artifacts for the JSON reports,
binary SHA256 hashes, image ID, commit, configuration, and server logs. Each JSON
report includes `AERALYTH_PERF_BUILD_ID`, `AERALYTH_PERF_BUILD_PROFILE`, and
`AERALYTH_PERF_ROUTING`, which associate the measurements with their artifact and
request path. CI records only an explicit configuration allowlist, excluding
credentials and tokens.

To establish a debug/release/image comparison for a commit, run the workflow
manually with **compare-debug** enabled. That adds a fresh debug process and
fixture using the same mixed workload after release acceptance. Its
`debug-comparison` report retains latency and dropped-arrival violations without
enforcing those thresholds, while operation errors and fixture failures still
fail the run. Release and production-image thresholds remain enforced on every
push, pull request, scheduled run, and manual run. The workflow's presence alone
does not establish a measured comparison; retain the artifacts from a completed
run as evidence.

The completed September 12 local comparison used the same 400-operation fixture
for native debug, native release, and the production image. All three passed,
with mixed-phase p99 of 52.40, 50.02, and 45.16 ms, respectively, and zero
unexpected failures or dropped arrivals. Unlike the CI affinity setting above,
the local native processes had unrestricted host CPU/memory. They used macOS
arm64 and Rust 1.97.1; the image used Linux arm64, Rust 1.98, and a two-CPU/2 GiB
limit. Native memory measurements cover Actix; image measurements cover the
whole Caddy/Next/Actix cgroup. The
[comparison report](../performance/results/final-native-2026-09-12/artifact-comparison.md)
records those limits and the exact artifact identities. A separate 300-second
image run completed 3,100 operations, including 250 encrypted publications, with
zero unexpected failures or drops and mixed-phase p99 of 50.43 ms. Expired
sessions, uploads, and provider jobs converged to zero; all nine idle maintenance
workers performed zero iterations during the final two-second observation.

## Arrival-controlled mixed workload

The health smoke test remains useful for quick liveness checks. Its latency
summary now includes failed requests, and it reports success and failure
percentiles separately. Its fixed worker count is a closed workload model, so it
does not establish application capacity.

The mixed gate offers work at fixed timestamps even when previous requests
slow down. An arrival that misses its scheduling deadline or finds every worker
busy is counted as dropped. No client request queue can conceal overload. The
report includes offered, started, completed, successful, failed, and dropped work
for each phase and operation. Latency starts at the scheduled arrival and ends
after the complete operation, including provider response bytes and ciphertext
verification. It retains all-response, success, and failure p50/p95/p99 values.

Only use the mixed gate with an isolated API, database, and S3 bucket. It requires
`AERALYTH_PERF_ISOLATED=1` even for loopback. Other API hosts must be listed in
`AERALYTH_PERF_ISOLATED_HOSTS`; provider hosts must be loopback or listed with
their port in `AERALYTH_PERF_PROVIDER_HOSTS`. Requests reject redirects. Random
fixture prefixes and exact owner/object predicates restrict cleanup to the data
created by that invocation.

Start an E2EE-enabled release API against the isolated PostgreSQL/MinIO fixture,
then run:

```sh
AERALYTH_PERF_ISOLATED=1 \
AERALYTH_PERF_URL=http://127.0.0.1:18080/health \
AERALYTH_METRICS_TOKEN="$AERALYTH_METRICS_TOKEN" \
AERALYTH_PERF_API_PID="$AERALYTH_PERF_API_PID" \
AERALYTH_PERF_BUILD_PROFILE=release \
AERALYTH_PERF_BUILD_ID="$AERALYTH_PERF_BUILD_ID" \
AERALYTH_PERF_OUTPUT=/tmp/aeralyth-release-mixed.json \
node performance/mixed-load.mjs
```

The database defaults to the Compose `postgres` service and `aeralyth` database.
For a separately provisioned disposable container, set
`AERALYTH_PERF_DATABASE_CONTAINER` and `AERALYTH_PERF_DATABASE_NAME`. A custom
Compose fixture can instead set `AERALYTH_PERF_COMPOSE_FILE` and
`AERALYTH_PERF_COMPOSE_PROJECT`. API credentials are generated as short-lived
fixture sessions in that database. The script does not need a production login.

The default fixture contains 1,000 encrypted files, 16 nested folders, an owner,
a shared recipient, and eight held SSE streams. The baseline phase browses and
loads metadata for five seconds. The 30-second mixed phase combines owner/shared
browsing, 25-node metadata batches, real signed encrypted single-part publication,
direct provider upload and download with GCM verification, realtime catch-up, and
upload-abort cleanup work. A five-second recovery phase checks browsing while
maintenance drains. Seeded expired sessions and provider cleanup jobs must
converge, held SSE streams must remain healthy, and fixture cleanup must complete.
After convergence, the gate allows one second for pending notifications to drain
and observes two seconds with no offered work. It fails if any maintenance worker
runs more than ten iterations per second during that idle window. This catches a
notification loop that repeatedly claims empty queues even when HTTP latency and
error rates look healthy. Missing or reset maintenance counters fail the check.

Use these variables to compare a heavier matched run:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `AERALYTH_PERF_DURATION_SECONDS` | 30 | Mixed phase duration, up to 3,600 seconds |
| `AERALYTH_PERF_BASELINE_SECONDS` | 5 | Baseline duration |
| `AERALYTH_PERF_RECOVERY_SECONDS` | 5 | Recovery duration |
| `AERALYTH_PERF_ARRIVAL_RATE` | 10 | Offered operations per second |
| `AERALYTH_PERF_CONCURRENCY` | 32 | Maximum active operations |
| `AERALYTH_PERF_FIXTURE_ROWS` | 1000 | Seeded encrypted files, up to 20,000 |
| `AERALYTH_PERF_FIXTURE_DEPTH` | 16 | Folder depth, up to 64 |
| `AERALYTH_PERF_SSE_STREAMS` | 8 | Held SSE streams, up to 64 |
| `AERALYTH_PERF_UPLOAD_BYTES` | 65536 | Plaintext bytes per publication, up to 4 MiB |
| `AERALYTH_PERF_MAX_P99_MS` | 1000 | All-response p99 limit for each operation |
| `AERALYTH_PERF_MAX_DROPPED_RATE` | 0 | Allowed dropped arrivals divided by offered arrivals |
| `AERALYTH_PERF_MAX_ERROR_RATE` | 0 | Allowed errors divided by started operations |
| `AERALYTH_PERF_MAX_START_DELAY_MS` | 100 | Scheduling delay after which an arrival is dropped |
| `AERALYTH_PERF_MAX_MEMORY_GROWTH_MIB` | 256 | Allowed final memory growth from the initial sample |
| `AERALYTH_PERF_IDLE_SECONDS` | 2 | Idle observation after maintenance convergence |
| `AERALYTH_PERF_IDLE_SETTLE_MS` | 1000 | Time to drain final workload notifications before observing idle work |
| `AERALYTH_PERF_MAX_IDLE_MAINTENANCE_RUNS_PER_SECOND` | 10 | Maximum idle iterations per second for each maintenance worker |

Each phase permits at most 100,000 offered operations, and a run permits at most
2,000 periodic runtime snapshots. These limits bound the load generator itself.
Weekly CI runs sustain the mixed phase for 300 seconds. Every run samples
protected database pool and admission-wait histograms, maintenance counters, and
fixture backlog. `AERALYTH_PERF_API_PID` records direct-process RSS;
`AERALYTH_PERF_MEMORY_CONTAINER` records Linux cgroup v2 memory for the production
image. Without either source, the report explicitly records memory as unavailable.

The following acceptance test takes an isolated database lock for 1.8 seconds
while mixed arrivals continue. It succeeds only when the mixed gate fails for
recorded dropped arrivals or tail latency, completes every phase, reports no
operation/fixture error, and removes the fixture:

```sh
AERALYTH_PERF_ISOLATED=1 \
AERALYTH_PERF_URL=http://127.0.0.1:18080/health \
AERALYTH_METRICS_TOKEN="$AERALYTH_METRICS_TOKEN" \
node performance/mixed-load-self-test.mjs
```

CI executes this fault test against the release API. Its JSON evidence is saved
as `release-database-stall.json`. The shorter independent scheduler regression
suite runs with `node --test performance/arrival-load.node-test.mjs`; it includes
slow failed responses, a stalled admission gate, a provider response whose body
finishes after its headers, and an operation that ignores cancellation.

This gate uses real encrypted provider transfers and a repeatable database stall.
It does not currently inject faults inside the S3 provider or measure a browser's
rendering/crypto-worker scheduling. Provider-region latency and browser transfer
capacity require separately recorded staging/browser runs with matching artifact
and data sizes; a passing local MinIO run alone cannot establish those values.
