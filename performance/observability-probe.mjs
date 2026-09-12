import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  isolatedOrigin,
  phaseViolations,
  runArrivalPhase,
} from "./arrival-load.mjs";

// An external staging probe. It starts the existing release binary and restores
// the one deliberate database fault in finally. No application code is changed.
const env = process.env;
const origin = isolatedOrigin(env.AERALYTH_PERF_URL);
assert.equal(new URL(origin).hostname, "127.0.0.1");
assert.equal(new URL(origin).port, "58085");
const databaseUrl = new URL(env.DATABASE_URL);
assert.equal(databaseUrl.hostname, "127.0.0.1");
assert.equal(databaseUrl.port, "55432");
assert.equal(databaseUrl.pathname, "/aeralyth_audit_debug_final");
assert.equal(env.AERALYTH_PERF_DATABASE_NAME, "aeralyth_audit_debug_final");
assert.equal(env.AERALYTH_PERF_DATABASE_CONTAINER, "aeralyth-audit-20260912");
assert.ok(env.AERALYTH_METRICS_TOKEN);
assert.ok(env.AERALYTH_PERF_BUILD_ID);
const binary = "backend/target/release/aeralyth-api";
const output = env.AERALYTH_PERF_OUTPUT;
assert.ok(output?.startsWith("performance/results/"));
const execute = promisify(execFile);
const result = {
  timestamp: new Date().toISOString(),
  artifact: {
    identity: env.AERALYTH_PERF_BUILD_ID,
    binarySha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    profile: "release",
    routing: "direct-actix",
  },
  harness: {
    scope:
      "External validation only; starts the prebuilt release binary without rebuilding or changing application code",
    files: Object.fromEntries(
      await Promise.all(
        [
          "performance/observability-probe.mjs",
          "performance/arrival-load.mjs",
        ].map(async (path) => [
          path,
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        ]),
      ),
    ),
  },
  configuration: {
    origin,
    successRoute: "/api/auth/info?username=probe-success",
    successRouteRationale:
      "Public authentication-info responses return200 and use the same Standard success log class as authenticated auth/me responses; auth/me correctly requires a session",
    arrivalRate: 200,
    concurrency: 32,
    loggingSuccessSampleRate: 1,
    slowRequestMs: 1,
    stdoutPolicy:
      "drain normally, pause all reads for 20 seconds, then drain and shut down",
    databaseFault:
      "temporarily rename invitations in the dedicated debug-final database",
    scrapeIntervalsMs: [1000, 20],
    queueCapacity: 1024,
    maximumEventBytes: 65536,
    maximumRssGrowthBytes: 33554432,
  },
  responsesByStatus: {},
  responseBytes: 0,
  phases: [],
  samples: [],
  logMessages: {},
  representativeLogs: [],
  violations: [],
};
const portCheck = createServer();
await new Promise((resolve, reject) => {
  portCheck.once("error", reject);
  portCheck.listen(58085, "127.0.0.1", resolve);
});
await new Promise((resolve) => portCheck.close(resolve));
const child = spawn(binary, [], {
  env: {
    ...env,
    AERALYTH_API_HOST: "127.0.0.1",
    AERALYTH_API_PORT: new URL(origin).port,
    AERALYTH_STRUCTURED_LOGS: "true",
    AERALYTH_REQUEST_SUCCESS_SAMPLE_RATE: "1",
    AERALYTH_REQUEST_SLOW_MS: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
result.process = { pid: child.pid };
let pendingLog = "";
let stderr = "";
let renameAttempted = false;
let exited = false;
const childExit = new Promise((resolve) =>
  child.once("close", (code, signal) => {
    exited = true;
    resolve({ code, signal });
  }),
);
child.stdout.on("data", (chunk) => {
  pendingLog += chunk.toString();
  let newline = pendingLog.indexOf("\n");
  while (newline >= 0) {
    const line = pendingLog.slice(0, newline);
    pendingLog = pendingLog.slice(newline + 1);
    try {
      const entry = JSON.parse(line);
      const message = entry.fields?.message ?? "other";
      result.logMessages[message] = (result.logMessages[message] ?? 0) + 1;
      if (
        ["request rejected", "request failed", "slow request"].includes(
          message,
        ) &&
        result.representativeLogs.filter((item) => item.message === message)
          .length < 3
      ) {
        result.representativeLogs.push({
          message,
          level: entry.level,
          status: entry.fields.status,
          durationMs: entry.fields.duration_ms,
          suppressedSinceLast: entry.fields.suppressed_since_last,
        });
      }
    } catch {
      /* Startup output may contain non-JSON diagnostics. */
    }
    newline = pendingLog.indexOf("\n");
  }
  // The application caps event bytes; the probe also caps partial-line memory.
  pendingLog = pendingLog.slice(-65536);
});
child.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-65536);
});
child.on("error", (error) => {
  result.violations.push(`spawn: ${error.message}`);
});

async function sql(statement) {
  return execute(
    "docker",
    [
      "exec",
      "-i",
      env.AERALYTH_PERF_DATABASE_CONTAINER,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "aeralyth",
      "-d",
      env.AERALYTH_PERF_DATABASE_NAME,
      "-Atc",
      statement,
    ],
    { timeout: 10000 },
  );
}
async function request(path, expected, signal) {
  const response = await fetch(`${origin}${path}`, { signal });
  const body = await response.arrayBuffer();
  result.responseBytes += body.byteLength;
  result.responsesByStatus[response.status] =
    (result.responsesByStatus[response.status] ?? 0) + 1;
  assert.equal(response.status, expected, path);
}
async function scrape() {
  const response = await fetch(`${origin}/metrics`, {
    headers: { Authorization: `Bearer ${env.AERALYTH_METRICS_TOKEN}` },
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  const scalar = (name) => {
    const value = text.match(new RegExp(`^${name} ([0-9.]+)$`, "m"));
    assert.ok(value, `missing ${name}`);
    return Number(value[1]);
  };
  return {
    atMs: performance.now(),
    queued: scalar("aeralyth_log_queue_events"),
    capacity: scalar("aeralyth_log_queue_capacity"),
    dropped: scalar("aeralyth_log_dropped_events_total"),
    suppressed: scalar("aeralyth_log_suppressed_requests_total"),
    writeErrors: scalar("aeralyth_log_write_errors_total"),
    httpSeries: (text.match(/^aeralyth_http_requests_total\{/gm) ?? []).length,
    httpHeaders: [
      ...text.matchAll(/^aeralyth_http_requests_total\{[^\n]*\} ([0-9]+)$/gm),
    ].reduce((sum, match) => sum + Number(match[1]), 0),
  };
}
let latestRssBytes = 0;
async function readRss() {
  const { stdout } = await execute("ps", [
    "-o",
    "rss=",
    "-p",
    String(child.pid),
  ]);
  latestRssBytes = Number(stdout.trim()) * 1024;
  assert.ok(Number.isFinite(latestRssBytes) && latestRssBytes > 0);
}
async function captureMetrics(label) {
  const value = { ...(await scrape()), label, rssBytes: latestRssBytes };
  result.samples.push(value);
  return value;
}
async function sample(label) {
  await readRss();
  return captureMetrics(label);
}
async function phase(name, seconds, scrapeIntervalMs, operations) {
  let stopped = false;
  let scrapeCount = 0;
  const scrapeStarted = performance.now();
  await readRss();
  const scraping = (async () => {
    while (!stopped) {
      try {
        await captureMetrics(name);
        scrapeCount += 1;
      } catch (error) {
        result.violations.push(`${name} scrape: ${error.message}`);
      }
      await delay(scrapeIntervalMs);
    }
  })();
  const rssSampling = (async () => {
    while (!stopped) {
      try {
        await readRss();
      } catch (error) {
        result.violations.push(`${name} RSS: ${error.message}`);
      }
      await delay(500);
    }
  })();
  try {
    const value = await runArrivalPhase({
      name,
      durationSeconds: seconds,
      arrivalRate: 200,
      concurrency: 32,
      timeoutMs: 2000,
      operations,
    });
    value.scrapes = {
      count: scrapeCount,
      intervalMs: scrapeIntervalMs,
      actualRatePerSecond:
        scrapeCount / ((performance.now() - scrapeStarted) / 1000),
      rssIntervalMs: 500,
    };
    result.phases.push(value);
    result.violations.push(...phaseViolations(value, { maximumP99Ms: 1000 }));
  } finally {
    stopped = true;
    await Promise.all([scraping, rssSampling]);
  }
}
try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (exited) throw new Error(`API exited before readiness: ${stderr}`);
    try {
      await request("/health", 200, AbortSignal.timeout(100));
      break;
    } catch {
      await delay(100);
    }
  }
  await request("/health", 200, AbortSignal.timeout(2000));
  // Populate only fixed, unauthenticated GET route labels, without user changes.
  for (const path of [
    "/health",
    "/health/live",
    "/health/ready",
    "/api/health",
    "/api/health/live",
    "/api/health/ready",
    "/api/auth/me",
    "/api/auth/info?username=probe",
    "/api/auth/csrf",
    "/api/admin/me",
    "/api/admin/users",
    "/api/admin/storage",
    "/api/profile/avatar",
    "/api/repositories",
    "/api/repositories/probe",
    "/api/repositories/probe/archive-manifest",
    "/api/files",
    "/api/files/summary",
    "/api/files/operations/probe",
    "/api/files/uploads/probe/status",
    "/api/files/probe/archive-manifest",
    "/api/files/probe/download",
    "/api/storage",
    "/api/vault",
    "/api/vault/unlock-material",
    "/api/vault/account-state",
    "/api/vault/identities/probe",
    "/api/vault/nodes/probe/download-plan",
    "/api/vault/nodes/probe/share-plan",
    "/api/vault/nodes/probe/share-contexts",
    "/api/vault/share-sync-jobs",
    "/api/vault/shares",
    "/api/vault/shares/probe/epochs/pending",
    "/api/share-links",
    "/api/share-links/access/probe",
    "/api/events/sync",
  ]) {
    const response = await fetch(`${origin}${path}`, {
      signal: AbortSignal.timeout(2000),
    });
    await response.arrayBuffer();
    assert.ok(response.status < 500, `warming ${path}: ${response.status}`);
  }
  const precheck = await sql(
    "SELECT to_regclass('public.aeralyth_probe_invitations') IS NULL AND to_regclass('public.invitations') IS NOT NULL;",
  );
  assert.equal(
    precheck.stdout.trim(),
    "t",
    "database fault namespace is not clean",
  );
  renameAttempted = true;
  await sql(
    "BEGIN; SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='2s'; ALTER TABLE public.invitations RENAME TO aeralyth_probe_invitations; COMMIT;",
  );
  const operations = [
    {
      name: "success",
      weight: 4,
      run: (signal) => request(result.configuration.successRoute, 200, signal),
    },
    {
      name: "database-success",
      weight: 2,
      run: (signal) => request("/api/auth/info?username=probe", 200, signal),
    },
    {
      name: "rejected",
      weight: 2,
      run: (signal) => request("/api/auth/info?username=", 400, signal),
    },
    {
      name: "database-failure",
      weight: 2,
      run: (signal) =>
        request(`/api/invitations/${"a".repeat(40)}`, 500, signal),
    },
  ];
  await phase("normal-scrapes", 5, 1000, operations);
  await phase("frequent-scrapes", 5, 20, operations);
  await phase("normal-scrapes-repeat", 5, 1000, operations);
  const beforeThrottle = await sample("before-paused-consumer");
  child.stdout.pause();
  await phase("paused-log-consumer", 20, 500, operations);
  const afterThrottle = await sample("after-paused-consumer");
  child.stdout.resume();
  for (
    let attempt = 0;
    attempt < 100 && (await scrape()).queued > 0;
    attempt += 1
  )
    await delay(20);
  const drained = await sample("consumer-resumed-drained");
  result.logConsumer = { beforeThrottle, afterThrottle, drained };
  assert.ok(
    afterThrottle.dropped > beforeThrottle.dropped,
    "paused consumer did not fill the bounded queue",
  );
  assert.ok(
    afterThrottle.suppressed > beforeThrottle.suppressed,
    "repeated warnings were not suppressed",
  );
  assert.equal(drained.capacity, result.configuration.queueCapacity);
  assert.equal(drained.queued, 0, "queue did not drain after consumer resumed");
  assert.equal(drained.writeErrors, 0, "stdout write failed");
  const warmRss = result.samples[0].rssBytes;
  result.memoryGrowthBytes =
    Math.max(...result.samples.map((entry) => entry.rssBytes)) - warmRss;
  assert.ok(
    result.memoryGrowthBytes <= result.configuration.maximumRssGrowthBytes,
    "RSS growth exceeds32MiB",
  );
  for (const entry of result.samples) {
    // The gauge increments before try_send, so up to32 producers can be visible
    // briefly in addition to the strictly1024-capacity channel.
    assert.ok(
      entry.queued <= 1024 + 32,
      "queue accounting exceeds capacity plus bounded producers",
    );
  }
  for (let index = 1; index < result.samples.length; index += 1) {
    assert.ok(
      result.samples[index].httpHeaders >=
        result.samples[index - 1].httpHeaders,
      "HTTP counter decreased",
    );
  }
  assert.ok(drained.httpSeries >= 30, "too few real route/status series");
  for (const message of [
    "request rejected",
    "request failed",
    "slow request",
  ]) {
    assert.ok(
      result.logMessages[message] > 0,
      `no representative ${message} diagnostic retained`,
    );
  }
} catch (error) {
  result.violations.push(error.stack ?? String(error));
} finally {
  child.stdout.resume();
  if (renameAttempted) {
    try {
      await sql(
        `BEGIN; SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='2s';
        DO $$ BEGIN
          IF to_regclass('public.aeralyth_probe_invitations') IS NOT NULL AND to_regclass('public.invitations') IS NULL THEN
            ALTER TABLE public.aeralyth_probe_invitations RENAME TO invitations;
          ELSIF NOT (to_regclass('public.aeralyth_probe_invitations') IS NULL AND to_regclass('public.invitations') IS NOT NULL) THEN
            RAISE EXCEPTION 'ambiguous invitation probe restore state';
          END IF;
        END; $$; COMMIT;`,
      );
      result.databaseRestored = true;
    } catch (error) {
      result.violations.push(`DATABASE RESTORE REQUIRED: ${error.message}`);
    }
  }
  const stopStarted = performance.now();
  if (!exited) child.kill("SIGINT");
  const stop = await Promise.race([childExit, delay(10000).then(() => null)]);
  if (!stop) {
    child.kill("SIGKILL");
    await childExit;
    result.violations.push("shutdown exceeded10seconds");
  }
  result.shutdown = { ...stop, elapsedMs: performance.now() - stopStarted };
  if (stop && stop.code !== 0)
    result.violations.push(`API exit: ${JSON.stringify(stop)}`);
  result.stderrTail = stderr;
  result.passed = result.violations.length === 0;
  await mkdir(output.slice(0, output.lastIndexOf("/")), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify({
      passed: result.passed,
      phases: result.phases.map((entry) => ({
        name: entry.name,
        p99: entry.latencyMs.all.p99,
        dropped: entry.dropped,
        failed: entry.failed,
      })),
      logConsumer: result.logConsumer,
      memoryGrowthBytes: result.memoryGrowthBytes,
      shutdown: result.shutdown,
      violations: result.violations,
    }),
  );
}
if (!result.passed) process.exitCode = 1;
