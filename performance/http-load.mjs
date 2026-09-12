import { performance } from "node:perf_hooks";
import { latencySummary } from "./arrival-load.mjs";

const targetValue =
  process.env.AERALYTH_PERF_URL ?? "http://127.0.0.1:8080/health";
if (!URL.canParse(targetValue)) {
  throw new Error("AERALYTH_PERF_URL must be a valid absolute URL");
}
const target = new URL(targetValue);
const requestCount = positiveInteger("AERALYTH_PERF_REQUESTS", 250);
const concurrency = positiveInteger("AERALYTH_PERF_CONCURRENCY", 20);
const warmupRequests = nonNegativeInteger("AERALYTH_PERF_WARMUP_REQUESTS", 20);
const timeoutMs = positiveNumber("AERALYTH_PERF_TIMEOUT_MS", 5_000);
const maximumP95Ms = positiveNumber("AERALYTH_PERF_MAX_P95_MS", 250);
const maximumErrorRate = nonNegativeNumber("AERALYTH_PERF_MAX_ERROR_RATE", 0);
if (maximumErrorRate > 1) {
  throw new Error("AERALYTH_PERF_MAX_ERROR_RATE must be at most 1.");
}

if (
  !isLoopback(target.hostname) &&
  process.env.AERALYTH_PERF_ALLOW_REMOTE !== "1"
) {
  throw new Error(
    "Refusing to load-test a non-loopback host without AERALYTH_PERF_ALLOW_REMOTE=1.",
  );
}

await runRequests(warmupRequests, Math.min(concurrency, warmupRequests || 1));
const samples = await runRequests(requestCount, concurrency);
const successful = samples.filter((sample) => sample.ok);
const durations = samples.map((sample) => sample.durationMs);
const failed = requestCount - successful.length;
const errorRate = failed / requestCount;
const result = {
  target: target.toString(),
  workloadModel: "closed-loop-smoke",
  requests: requestCount,
  offered: requestCount,
  started: samples.length,
  completed: samples.length,
  dropped: 0,
  concurrency,
  successful: successful.length,
  failed,
  errorRate,
  latencyMs: latencySummary(durations),
  latencyByOutcomeMs: {
    success: latencySummary(successful.map((sample) => sample.durationMs)),
    failure: latencySummary(
      samples.filter((sample) => !sample.ok).map((sample) => sample.durationMs),
    ),
  },
  thresholds: {
    maximumP95Ms,
    maximumErrorRate,
  },
};

console.log(JSON.stringify(result));

const metricsToken = process.env.AERALYTH_METRICS_TOKEN;
if (metricsToken) {
  const metricsUrl = new URL(
    process.env.AERALYTH_PERF_METRICS_URL ?? "/metrics",
    target,
  );
  const response = await fetch(metricsUrl, {
    headers: { Authorization: `Bearer ${metricsToken}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  if (!response.ok || !body.includes("aeralyth_http_requests_total")) {
    throw new Error(
      "The protected metrics endpoint did not expose HTTP metrics.",
    );
  }
  const route = process.env.AERALYTH_PERF_ROUTE_LABEL ?? target.pathname;
  if (!body.includes(`route="${route}"`)) {
    throw new Error(
      `Metrics did not contain the expected route label: ${route}`,
    );
  }
}

if (successful.length === 0) {
  throw new Error("The load check did not receive a successful response.");
}
if ((result.latencyMs.p95 ?? Number.POSITIVE_INFINITY) > maximumP95Ms) {
  throw new Error(
    `p95 latency ${result.latencyMs.p95?.toFixed(2)}ms exceeded ${maximumP95Ms}ms.`,
  );
}
if (errorRate > maximumErrorRate) {
  throw new Error(
    `Error rate ${errorRate.toFixed(4)} exceeded ${maximumErrorRate}.`,
  );
}

async function runRequests(count, workerCount) {
  const results = new Array(count);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(workerCount, count) },
    async () => {
      while (true) {
        const index = next;
        if (index >= count) return;
        next += 1;
        const started = performance.now();
        try {
          // Each worker is sequential by design; concurrency comes from the worker pool.
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          const response = await fetch(target, {
            cache: "no-store",
            signal: AbortSignal.timeout(timeoutMs),
          });
          await response.arrayBuffer();
          results[index] = {
            ok: response.ok,
            status: response.status,
            durationMs: performance.now() - started,
          };
        } catch (error) {
          results[index] = {
            ok: false,
            status: 0,
            durationMs: performance.now() - started,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function isLoopback(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function positiveInteger(name, fallback) {
  const value = numberFromEnvironment(name, fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(name, fallback) {
  const value = numberFromEnvironment(name, fallback);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function positiveNumber(name, fallback) {
  const value = numberFromEnvironment(name, fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

function nonNegativeNumber(name, fallback) {
  const value = numberFromEnvironment(name, fallback);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return value;
}

function numberFromEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric.`);
  return value;
}
