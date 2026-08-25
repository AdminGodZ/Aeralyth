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
- encrypted multipart uploads keep one four-part batch in flight and at most one
  complete lookahead part, preserving order with a five-part memory ceiling;
- up to three small encrypted files may overlap, while a large file consumes the
  complete file-level budget and therefore remains exclusive.

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

- request latency, status, declared body bytes, and request-scoped DB checkouts;
- database pool size, waiters, checkout latency, and failures;
- maintenance-worker latency, failures, and supervisor restarts;
- process uptime and build information.

Every response includes `x-request-id` and `server-timing`. Successful request
logs are sampled; successful health probes are excluded and successful multipart
presign/status controls use one tenth the normal sampling frequency. Every 4xx,
5xx, and slow request is retained. Logs contain matched route templates and
aggregate byte/count data, never URL tokens, request bodies, or cryptographic
payloads. Configure
`AERALYTH_REQUEST_SUCCESS_SAMPLE_RATE` (default 100),
`AERALYTH_REQUEST_SLOW_MS` (default 500), and `AERALYTH_STRUCTURED_LOGS`.
Production defaults to JSON logs.

When `AERALYTH_METRICS_TOKEN` is present, `npm run perf:http` also verifies that
the protected scrape contains the exercised route.

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
