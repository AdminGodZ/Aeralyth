import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  boundedNumber,
  isolatedOrigin,
  maintenanceIdleSummary,
  phaseViolations,
  runArrivalPhase,
} from "./arrival-load.mjs";
import { createMixedFixture } from "./mixed-fixture.mjs";

const execute = promisify(execFile);
const env = process.env;
const origin = isolatedOrigin(
  env.AERALYTH_PERF_URL ?? "http://127.0.0.1:8080/health",
);
const durationSeconds = setting("DURATION_SECONDS", 30, 1, 3_600);
const baselineSeconds = setting("BASELINE_SECONDS", 5, 1, 300);
const recoverySeconds = setting("RECOVERY_SECONDS", 5, 1, 300);
const arrivalRate = setting("ARRIVAL_RATE", 10, 1, 1_000);
const concurrency = setting("CONCURRENCY", 32, 1, 256, true);
const timeoutMs = setting("TIMEOUT_MS", 5_000, 1, 120_000);
const sampleIntervalMs = setting("SAMPLE_INTERVAL_MS", 5_000, 250, 60_000);
const maximumStartDelayMs = setting("MAX_START_DELAY_MS", 100, 1, 10_000);
const maximumMemoryGrowthBytes =
  setting("MAX_MEMORY_GROWTH_MIB", 256, 1, 16_384) * 1_048_576;
const maximumP99Ms = setting("MAX_P99_MS", 1_000, 1, 120_000);
const maximumErrorRate = setting("MAX_ERROR_RATE", 0, 0, 1);
const maximumDroppedRate = setting("MAX_DROPPED_RATE", 0, 0, 1);
const injectedDatabaseStallMs = setting(
  "INJECT_DB_STALL_MS",
  0,
  0,
  10_000,
  true,
);
const idleSeconds = setting("IDLE_SECONDS", 2, 1, 60);
const idleSettleMs = setting("IDLE_SETTLE_MS", 1_000, 0, 60_000);
const maximumIdleMaintenanceRunsPerSecond = setting(
  "MAX_IDLE_MAINTENANCE_RUNS_PER_SECOND",
  10,
  0.01,
  10_000,
);
const profile = env.AERALYTH_PERF_BUILD_PROFILE ?? "unspecified";
const enforceTiming = env.AERALYTH_PERF_ENFORCE_THRESHOLDS !== "0";
if (!enforceTiming && profile !== "debug-comparison") {
  throw new Error("Only a debug-comparison run may disable timing thresholds");
}
if (!env.AERALYTH_METRICS_TOKEN) {
  throw new Error(
    "AERALYTH_METRICS_TOKEN is required to measure pool/gate waits",
  );
}
// Reject huge runs before creating accounts or starting provider work.
for (const seconds of [baselineSeconds, durationSeconds, recoverySeconds]) {
  boundedNumber(
    "offered arrivals per phase",
    Math.ceil(seconds * arrivalRate),
    1,
    100_000,
    true,
  );
}
boundedNumber(
  "runtime snapshots",
  Math.ceil(
    ((baselineSeconds + durationSeconds + recoverySeconds + idleSeconds) *
      1_000 +
      idleSettleMs) /
      sampleIntervalMs,
  ),
  1,
  2_000,
  true,
);

const started = performance.now();
const result = {
  workloadModel: "fixed-arrival-mixed",
  target: origin,
  timestamp: new Date().toISOString(),
  artifact: {
    identity: env.AERALYTH_PERF_BUILD_ID ?? "unrecorded-local-build",
    profile,
    routing: env.AERALYTH_PERF_ROUTING ?? "direct-actix",
    node: process.version,
  },
  configuration: {
    durationSeconds,
    baselineSeconds,
    recoverySeconds,
    arrivalRate,
    concurrency,
    timeoutMs,
    maximumStartDelayMs,
    sampleIntervalMs,
    injectedDatabaseStallMs,
    idleSeconds,
    idleSettleMs,
  },
  thresholds: {
    maximumP99Ms,
    maximumErrorRate,
    maximumDroppedRate,
    maximumMemoryGrowthBytes,
    enforceTiming,
    maximumIdleMaintenanceRunsPerSecond,
  },
  phases: [],
  snapshots: [],
  thresholdViolations: [],
  violations: [],
};
let fixture;
const sampling = new AbortController();
let sampler;
let databaseStall;
try {
  fixture = await createMixedFixture({ origin, timeoutMs, env });
  result.fixtureSetupMs = performance.now() - started;
  result.fixture = fixture.fixture;
  const required = ["browse", "metadata", "publication", "maintenance"];
  for (const name of required) {
    if (!fixture.operations.some((operation) => operation.name === name)) {
      throw new Error(`Fixture is missing the ${name} operation`);
    }
  }
  await snapshot("before-baseline");
  sampler = samplePeriodically();
  for (const [name, seconds, operations] of [
    [
      "baseline",
      baselineSeconds,
      fixture.operations.filter((operation) =>
        ["browse", "metadata"].includes(operation.name),
      ),
    ],
    ["mixed", durationSeconds, fixture.operations],
    [
      "recovery",
      recoverySeconds,
      fixture.operations.filter((operation) =>
        ["browse", "metadata", "maintenance"].includes(operation.name),
      ),
    ],
  ]) {
    if (name === "mixed" && injectedDatabaseStallMs > 0) {
      databaseStall = await fixture.injectDatabaseStall(
        injectedDatabaseStallMs,
      );
    }
    const phase = await runArrivalPhase({
      name,
      durationSeconds: seconds,
      arrivalRate,
      concurrency,
      timeoutMs,
      maximumStartDelayMs,
      operations,
    });
    if (name === "mixed") await databaseStall?.done;
    result.phases.push(phase);
    result.thresholdViolations.push(
      ...phaseViolations(phase, { ...result.thresholds, enforceTiming: true }),
    );
    result.violations.push(...phaseViolations(phase, result.thresholds));
    if (name === "mixed") {
      for (const operation of required) {
        if (!phase.operations[operation]?.successful) {
          result.violations.push(`mixed/${operation}: no successful coverage`);
        }
      }
    }
    await snapshot(`after-${name}`);
  }
  if (fixture.verify) result.fixtureVerification = await fixture.verify();
  // All arrival work has finished and the fixture has converged. Give its final
  // notifications time to drain before checking that empty maintenance sleeps.
  await delay(idleSettleMs);
  const idleBefore = await snapshot("idle-start");
  await delay(idleSeconds * 1_000);
  const idleAfter = await snapshot("idle-end");
  result.idleMaintenance = maintenanceIdleSummary(
    idleBefore.metrics,
    idleAfter.metrics,
    idleAfter.metricsObservedAtMs - idleBefore.metricsObservedAtMs,
    maximumIdleMaintenanceRunsPerSecond,
  );
  result.thresholdViolations.push(...result.idleMaintenance.violations);
  result.violations.push(...result.idleMaintenance.violations);
  const first = result.snapshots[0];
  const last = result.snapshots.at(-1);
  result.runtimeDelta = metricDelta(first.metrics, last.metrics);
  result.waits = histogramWaits(result.runtimeDelta);
  result.memory = memorySummary(result.snapshots);
  if (
    result.memory.growthBytes !== null &&
    result.memory.growthBytes > maximumMemoryGrowthBytes
  ) {
    const violation = `memory grew by ${result.memory.growthBytes} bytes`;
    result.thresholdViolations.push(violation);
    if (enforceTiming) result.violations.push(violation);
  }
} catch (error) {
  result.violations.push(
    error instanceof Error ? error.message : String(error),
  );
} finally {
  sampling.abort();
  try {
    await databaseStall?.release();
  } catch (error) {
    result.violations.push(`fault cleanup: ${error.message ?? String(error)}`);
  }
  await sampler;
  const cleanupStarted = performance.now();
  try {
    await fixture?.close();
    result.fixtureCleanup = fixture ? "complete" : "not-created";
  } catch (error) {
    result.fixtureCleanup = "failed";
    result.violations.push(
      `fixture cleanup: ${error.message ?? String(error)}`,
    );
  } finally {
    result.fixtureCleanupMs = performance.now() - cleanupStarted;
  }
  result.elapsedMs = performance.now() - started;
  result.passed = result.violations.length === 0;
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (env.AERALYTH_PERF_OUTPUT) await writeFile(env.AERALYTH_PERF_OUTPUT, json);
  console.log(json);
}
if (!result.passed) process.exitCode = 1;

async function samplePeriodically() {
  try {
    while (!sampling.signal.aborted) {
      await delay(sampleIntervalMs, undefined, { signal: sampling.signal });
      await snapshot("interval");
    }
  } catch (error) {
    if (!sampling.signal.aborted) {
      result.violations.push(
        `runtime sampling: ${error.message ?? String(error)}`,
      );
    }
  }
}

async function snapshot(phase) {
  const response = await fetch(`${origin}/metrics`, {
    headers: { Authorization: `Bearer ${env.AERALYTH_METRICS_TOKEN}` },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Metrics returned ${response.status}`);
  const text = await response.text();
  const metricsObservedAtMs = performance.now() - started;
  if (!text.includes("aeralyth_db_pool_checkout_duration_seconds")) {
    throw new Error("Metrics must include database pool checkout timing");
  }
  const selected = text
    .split("\n")
    .filter((line) =>
      /^aeralyth_(?:db_pool_|admission_wait_|maintenance_|s3_retry_|sse_)/.test(
        line,
      ),
    );
  const metrics = Object.fromEntries(
    selected.map((line) => {
      const separator = line.lastIndexOf(" ");
      return [line.slice(0, separator), Number(line.slice(separator + 1))];
    }),
  );
  const [memory, fixtureState] = await Promise.all([
    readMemory(),
    fixture.sample?.(),
  ]);
  const current = {
    phase,
    elapsedMs: performance.now() - started,
    metricsObservedAtMs,
    metrics,
    memory,
    fixture: fixtureState,
  };
  result.snapshots.push(current);
  return current;
}

async function readMemory() {
  const pid = env.AERALYTH_PERF_API_PID;
  const container = env.AERALYTH_PERF_MEMORY_CONTAINER;
  if (pid) {
    if (!/^[1-9]\d*$/.test(pid))
      throw new Error("API_PID must be a positive PID");
    const { stdout } = await execute("ps", ["-o", "rss=", "-p", pid], {
      timeout: timeoutMs,
    });
    const bytes = Number(stdout.trim()) * 1_024;
    if (!Number.isFinite(bytes) || bytes <= 0)
      throw new Error("API RSS is unavailable");
    return { source: "api-rss", bytes };
  }
  if (container) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) {
      throw new Error("Invalid memory container name");
    }
    const { stdout } = await execute(
      "docker",
      ["exec", container, "cat", "/sys/fs/cgroup/memory.current"],
      { timeout: timeoutMs },
    );
    const bytes = Number(stdout.trim());
    if (!Number.isFinite(bytes) || bytes <= 0)
      throw new Error("Container memory is unavailable");
    return { source: "container-cgroup-v2", bytes };
  }
  return { source: "unavailable", bytes: null };
}

function memorySummary(snapshots) {
  const samples = snapshots
    .map((sample) => sample.memory)
    .filter((sample) => sample.bytes !== null);
  if (!samples.length) return { source: "unavailable", growthBytes: null };
  return {
    source: samples[0].source,
    initialBytes: samples[0].bytes,
    finalBytes: samples.at(-1).bytes,
    peakBytes: Math.max(...samples.map((sample) => sample.bytes)),
    growthBytes: samples.at(-1).bytes - samples[0].bytes,
  };
}

function metricDelta(before, after) {
  return Object.fromEntries(
    Object.entries(after)
      .filter(([name]) => !name.startsWith("aeralyth_db_pool_connections{"))
      .map(([name, value]) => [name, value - (before[name] ?? 0)]),
  );
}

function histogramWaits(delta) {
  const groups = new Map();
  for (const [key, count] of Object.entries(delta)) {
    const match = key.match(
      /^(aeralyth_(?:db_pool_checkout_duration|admission_wait)_seconds)_bucket\{(.*),le="([^"]+)"\}$/,
    );
    if (!match) continue;
    const group = `${match[1]}{${match[2]}}`;
    const buckets = groups.get(group) ?? [];
    buckets.push({
      bound: match[3] === "+Inf" ? Number.POSITIVE_INFINITY : Number(match[3]),
      count,
    });
    groups.set(group, buckets);
  }
  return Object.fromEntries(
    [...groups].map(([name, buckets]) => {
      buckets.sort((left, right) => left.bound - right.bound);
      const count = buckets.at(-1).count;
      const p99 = count
        ? buckets.find((bucket) => bucket.count >= Math.ceil(count * 0.99))
            ?.bound
        : null;
      return [
        name,
        {
          count,
          p99UpperBoundSeconds: Number.isFinite(p99)
            ? p99
            : p99 === null
              ? null
              : "+Inf",
        },
      ];
    }),
  );
}

function setting(name, fallback, min, max, integer = false) {
  return boundedNumber(
    `AERALYTH_PERF_${name}`,
    Number(env[`AERALYTH_PERF_${name}`] ?? fallback),
    min,
    max,
    integer,
  );
}
