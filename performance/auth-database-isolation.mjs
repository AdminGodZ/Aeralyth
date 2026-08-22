import { performance } from "node:perf_hooks";

const healthUrlValue =
  process.env.AERALYTH_PERF_URL ?? "http://127.0.0.1:8080/health";
if (!URL.canParse(healthUrlValue)) {
  throw new Error("AERALYTH_PERF_URL must be a valid absolute URL");
}
const healthUrl = new URL(healthUrlValue);
const origin = healthUrl.origin;
const metricsToken = process.env.AERALYTH_METRICS_TOKEN;
const timeoutMs = Number(
  process.env.AERALYTH_AUTH_ISOLATION_TIMEOUT_MS ?? 5_000,
);
const burstSize = Number(process.env.AERALYTH_AUTH_ISOLATION_BURST ?? 20);
const controlSamples = Number(
  process.env.AERALYTH_AUTH_ISOLATION_CONTROL_SAMPLES ?? 16,
);
const maxControlP95Ms = Number(
  process.env.AERALYTH_AUTH_ISOLATION_MAX_P95_MS ?? 500,
);
const maxCheckoutP99BucketSeconds = Number(
  process.env.AERALYTH_AUTH_ISOLATION_MAX_CHECKOUT_P99_BUCKET_SECONDS ?? 0.1,
);
const username = process.env.AERALYTH_PERF_USERNAME ?? "admingod";
const password = process.env.AERALYTH_PERF_PASSWORD?.trim();

if (!metricsToken) {
  throw new Error("AERALYTH_METRICS_TOKEN is required for the isolation check");
}
if (!password) {
  throw new Error("AERALYTH_PERF_PASSWORD is required for the isolation check");
}
if (!Number.isSafeInteger(burstSize) || burstSize < 1) {
  throw new Error("AERALYTH_AUTH_ISOLATION_BURST must be a positive integer");
}

const cookie = await login(username, password);
await controlRequest(cookie);
await Promise.all(
  Array.from({ length: Math.max(controlSamples, burstSize) }, () =>
    controlRequest(cookie),
  ),
);
const metricsBefore = await readMetrics();
assertPoolMetrics(metricsBefore);

const baseline = [];
for (let index = 0; index < Math.min(controlSamples, 8); index += 1) {
  // Baseline samples must be sequential so the control latency is not self-contended.
  // react-doctor-disable-next-line react-doctor/async-await-in-loop
  baseline.push(await controlRequest(cookie));
}

const loginBurst = Array.from({ length: burstSize }, (_, index) =>
  invalidLogin(index),
);
const controls = Array.from({ length: controlSamples }, () =>
  controlRequest(cookie),
);
const [loginStatuses, controlDurations] = await Promise.all([
  Promise.all(loginBurst),
  Promise.all(controls),
]);

const metricsAfter = await readMetrics();
const baselineP95 = percentile(baseline, 0.95);
const controlP95 = percentile(controlDurations, 0.95);
const adaptiveLimit = Math.max(maxControlP95Ms, baselineP95 * 5 + 25);
const requestFailuresBefore = metricValue(
  metricsBefore,
  "aeralyth_db_pool_checkout_failures_total",
  { pool: "request" },
);
const requestFailuresAfter = metricValue(
  metricsAfter,
  "aeralyth_db_pool_checkout_failures_total",
  { pool: "request" },
);
const checkoutP99BucketSeconds = histogramDeltaUpperBound(
  metricsBefore,
  metricsAfter,
  "aeralyth_db_pool_checkout_duration_seconds",
  { pool: "request" },
  0.99,
);

if (controlP95 > adaptiveLimit) {
  throw new Error(
    `authenticated file-control p95 ${controlP95.toFixed(2)}ms exceeded ${adaptiveLimit.toFixed(2)}ms during login burst`,
  );
}
if (requestFailuresAfter !== requestFailuresBefore) {
  throw new Error("login burst caused request-pool checkout failures");
}
if (checkoutP99BucketSeconds > maxCheckoutP99BucketSeconds) {
  throw new Error(
    `request-pool checkout p99 exceeded the ${maxCheckoutP99BucketSeconds}s bucket`,
  );
}
if (!loginStatuses.every((status) => status === 303 || status === 429)) {
  throw new Error(`unexpected login statuses: ${loginStatuses.join(",")}`);
}

console.log(
  JSON.stringify({
    burstSize,
    passwordWorkerBackpressureResponses: loginStatuses.filter(
      (status) => status === 429,
    ).length,
    baselineControlP95Ms: Number(baselineP95.toFixed(2)),
    burstControlP95Ms: Number(controlP95.toFixed(2)),
    requestPoolCheckoutP99UpperBoundMs: checkoutP99BucketSeconds * 1_000,
    requestPoolCheckoutFailures: requestFailuresAfter,
  }),
);

async function login(loginUsername, loginPassword) {
  const body = new URLSearchParams({
    username: loginUsername,
    password: loginPassword,
  });
  const response = await fetch(new URL("/api/auth/login", origin), {
    method: "POST",
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 303) {
    throw new Error(`test login failed with ${response.status}`);
  }
  const setCookie = response.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0];
  if (!cookie?.startsWith("aeralyth_session=")) {
    throw new Error("test login did not return a session cookie");
  }
  return cookie;
}

async function invalidLogin(index) {
  const body = new URLSearchParams({
    username: `perf-missing-${index}`,
    password: "not-the-password",
  });
  const response = await fetch(new URL("/api/auth/login", origin), {
    method: "POST",
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  await response.arrayBuffer();
  return response.status;
}

async function controlRequest(cookie) {
  const started = performance.now();
  const response = await fetch(new URL("/api/files", origin), {
    headers: { Cookie: cookie },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  await response.arrayBuffer();
  if (!response.ok) {
    throw new Error(
      `authenticated file-control request failed with ${response.status}`,
    );
  }
  return performance.now() - started;
}

async function readMetrics() {
  const response = await fetch(new URL("/metrics", origin), {
    headers: { Authorization: `Bearer ${metricsToken}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`metrics request failed with ${response.status}`);
  }
  return body;
}

function assertPoolMetrics(metrics) {
  for (const pool of ["request", "maintenance"]) {
    if (
      !metrics.includes(
        `aeralyth_db_pool_connections{pool="${pool}",state="max"}`,
      ) ||
      !metrics.includes(
        `aeralyth_db_pool_connections_created_total{pool="${pool}"}`,
      )
    ) {
      throw new Error(`metrics do not expose the independent ${pool} pool`);
    }
  }
}

function metricValue(metrics, name, labels) {
  const labelText = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(",");
  const prefix = `${name}{${labelText}} `;
  const line = metrics
    .split("\n")
    .find((candidate) => candidate.startsWith(prefix));
  if (!line) {
    throw new Error(`metric not found: ${prefix}`);
  }
  const value = Number(line.slice(prefix.length));
  if (!Number.isFinite(value)) {
    throw new Error(`metric is not numeric: ${line}`);
  }
  return value;
}

function histogramDeltaUpperBound(before, after, name, labels, fraction) {
  const beforeBuckets = histogramBuckets(before, name, labels);
  const afterBuckets = histogramBuckets(after, name, labels);
  const deltas = [...afterBuckets].map(([upperBound, count]) => ({
    upperBound,
    count: count - (beforeBuckets.get(upperBound) ?? 0),
  }));
  const total = deltas.find(
    ({ upperBound }) => upperBound === Number.POSITIVE_INFINITY,
  )?.count;
  if (!Number.isFinite(total) || total < 1) {
    throw new Error(`histogram had no new observations: ${name}`);
  }
  const target = Math.ceil(total * fraction);
  const bucket = deltas.find(({ count }) => count >= target);
  if (!bucket || !Number.isFinite(bucket.upperBound)) {
    throw new Error(`histogram percentile was unbounded: ${name}`);
  }
  return bucket.upperBound;
}

function histogramBuckets(metrics, name, labels) {
  const expectedLabels = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(",");
  const prefix = `${name}_bucket{${expectedLabels},le="`;
  return new Map(
    metrics
      .split("\n")
      .filter((line) => line.startsWith(prefix))
      .map((line) => {
        const suffix = line.slice(prefix.length);
        const separator = suffix.indexOf('"} ');
        const rawBound = suffix.slice(0, separator);
        return [
          rawBound === "+Inf" ? Number.POSITIVE_INFINITY : Number(rawBound),
          Number(suffix.slice(separator + 3)),
        ];
      }),
  );
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}
