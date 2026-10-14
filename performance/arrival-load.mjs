import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

// Arrivals have fixed deadlines independent of response speed. A full worker
// budget drops an arrival immediately; it never queues hidden client work.
export async function runArrivalPhase({
  name,
  durationSeconds,
  arrivalRate,
  concurrency,
  timeoutMs,
  maximumStartDelayMs = 100,
  operations,
}) {
  boundedNumber("durationSeconds", durationSeconds, 0.001, 3_600);
  boundedNumber("arrivalRate", arrivalRate, 0.001, 10_000);
  boundedNumber("concurrency", concurrency, 1, 1_024, true);
  boundedNumber("timeoutMs", timeoutMs, 1, 120_000);
  boundedNumber("maximumStartDelayMs", maximumStartDelayMs, 0, 60_000);
  const count = Math.ceil(durationSeconds * arrivalRate);
  boundedNumber("offered arrivals", count, 1, 100_000, true);
  if (!operations?.length)
    throw new Error("At least one operation is required");
  const names = new Set();
  const choices = operations.flatMap((operation) => {
    if (names.has(operation.name) || typeof operation.run !== "function") {
      throw new Error("Operations require unique names and a run function");
    }
    names.add(operation.name);
    const weight = operation.weight ?? 1;
    boundedNumber("operation weight", weight, 1, 100, true);
    return Array.from({ length: weight }, () => operation);
  });
  const active = new Set();
  const observations = [];
  const samples = [];
  const dropped = [];
  const origin = performance.now();
  for (let index = 0; index < count; index += 1) {
    const due = origin + (index * 1_000) / arrivalRate;
    // Sleep only until the next offered arrival, never until a response ends.
    while (performance.now() < due) {
      await delay(Math.max(1, due - performance.now()));
    }
    const operation = choices[index % choices.length];
    const startDelayMs = Math.max(0, performance.now() - due);
    const reason =
      startDelayMs > maximumStartDelayMs
        ? "scheduler-late"
        : active.size >= concurrency
          ? "concurrency-limit"
          : null;
    if (reason) {
      dropped.push({ operation: operation.name, reason, startDelayMs });
      continue;
    }
    const request = observe(operation, due, timeoutMs, startDelayMs, () =>
      active.delete(request),
    ).then((sample) => samples.push(sample));
    active.add(request);
    observations.push(request);
  }
  await Promise.all(observations);
  return summarizePhase({
    name,
    durationSeconds,
    arrivalRate,
    concurrency,
    elapsedMs: performance.now() - origin,
    samples,
    dropped,
    operationNames: [...names],
  });
}

async function observe(operation, due, timeoutMs, startDelayMs, release) {
  const started = performance.now();
  const controller = new AbortController();
  let timeout;
  try {
    // The race also bounds a faulty operation that ignores AbortSignal.
    await Promise.race([
      // A timed-out operation keeps its worker slot until it actually settles.
      // Even a broken operation ignoring abort cannot create unbounded work.
      Promise.resolve()
        .then(() => operation.run(controller.signal))
        .finally(release),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`operation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    return {
      operation: operation.name,
      ok: true,
      latencyMs: performance.now() - due,
      serviceMs: performance.now() - started,
      startDelayMs,
    };
  } catch (error) {
    return {
      operation: operation.name,
      ok: false,
      latencyMs: performance.now() - due,
      serviceMs: performance.now() - started,
      startDelayMs,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarizePhase({
  samples,
  dropped,
  operationNames,
  ...configuration
}) {
  return {
    ...configuration,
    ...summarizeWork(samples, dropped),
    operations: Object.fromEntries(
      operationNames.map((name) => [
        name,
        summarizeWork(
          samples.filter((sample) => sample.operation === name),
          dropped.filter((sample) => sample.operation === name),
        ),
      ]),
    ),
  };
}

function summarizeWork(samples, dropped) {
  const successful = samples.filter((sample) => sample.ok);
  const failures = samples.filter((sample) => !sample.ok);
  const offered = samples.length + dropped.length;
  return {
    offered,
    started: samples.length,
    completed: samples.length,
    successful: successful.length,
    failed: failures.length,
    dropped: dropped.length,
    errorRate: samples.length ? failures.length / samples.length : 0,
    droppedRate: offered ? dropped.length / offered : 0,
    latencyMs: {
      all: latencySummary(samples.map((sample) => sample.latencyMs)),
      success: latencySummary(successful.map((sample) => sample.latencyMs)),
      failure: latencySummary(failures.map((sample) => sample.latencyMs)),
    },
    serviceMs: latencySummary(samples.map((sample) => sample.serviceMs)),
    startDelayMs: latencySummary([
      ...samples.map((sample) => sample.startDelayMs),
      ...dropped.map((sample) => sample.startDelayMs),
    ]),
    dropReasons: frequencies(dropped.map((sample) => sample.reason)),
    errors: frequencies(failures.map((sample) => sample.error)),
  };
}

function frequencies(values) {
  const counts = Object.create(null);
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export function latencySummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction) =>
    sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
  return {
    count: sorted.length,
    mean: sorted.length
      ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length
      : null,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? null,
  };
}

export function isExpectedDatabaseStallViolation(report, message) {
  if (/: (dropped |p99 )/.test(message)) return true;
  const missing = message.match(
    /^mixed\/([^:]+): no (?:completed work|successful coverage)$/,
  );
  if (!missing) return false;
  const operation = report.phases.find((phase) => phase.name === "mixed")
    ?.operations[missing[1]];
  // A deliberately saturated worker budget can drop every arrival of a less
  // frequent operation. Accept that only when the report proves none ran and
  // every offered arrival was dropped for the injected capacity shortage.
  return (
    operation?.offered > 0 &&
    operation.started === 0 &&
    operation.completed === 0 &&
    operation.failed === 0 &&
    operation.dropped === operation.offered &&
    operation.dropReasons?.["concurrency-limit"] === operation.offered &&
    Object.keys(operation.dropReasons).length === 1
  );
}

export function phaseViolations(
  phase,
  {
    maximumP99Ms,
    maximumErrorRate = 0,
    maximumDroppedRate = 0,
    enforceTiming = true,
  },
) {
  const violations = [];
  if (phase.successful === 0)
    violations.push(`${phase.name}: no successful work`);
  if (phase.errorRate > maximumErrorRate) {
    violations.push(`${phase.name}: error rate ${phase.errorRate}`);
  }
  if (!enforceTiming) return violations;
  if (phase.droppedRate > maximumDroppedRate) {
    violations.push(`${phase.name}: dropped ${phase.dropped}/${phase.offered}`);
  }
  for (const [name, operation] of Object.entries(phase.operations)) {
    if (operation.offered === 0) continue;
    if (operation.completed === 0) {
      violations.push(`${phase.name}/${name}: no completed work`);
    } else if (operation.latencyMs.all.p99 > maximumP99Ms) {
      violations.push(
        `${phase.name}/${name}: p99 ${operation.latencyMs.all.p99.toFixed(2)}ms exceeds ${maximumP99Ms}ms`,
      );
    }
  }
  return violations;
}

export function boundedNumber(name, value, min, max, integer = false) {
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new Error(
      `${name} must be ${integer ? "an integer" : "a number"} in [${min}, ${max}]`,
    );
  }
  return value;
}

export function maintenanceIdleSummary(
  before,
  after,
  durationMs,
  maximumRunsPerSecond = 10,
) {
  boundedNumber("idle observation duration", durationMs, 1, 120_000);
  boundedNumber("idle maintenance budget", maximumRunsPerSecond, 0.01, 10_000);
  const pattern =
    /^aeralyth_maintenance_duration_seconds_count\{worker="([^"]+)"\}$/;
  const keys = [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].filter((key) => pattern.test(key));
  const workers = {};
  const violations = [];
  if (keys.length === 0) {
    violations.push(
      "idle-maintenance: maintenance iteration metrics are missing",
    );
  }
  for (const key of keys) {
    const name = key.match(pattern)[1];
    const start = before[key] ?? 0;
    const end = after[key];
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      violations.push(
        `idle-maintenance/${name}: iteration counter reset or unavailable`,
      );
      continue;
    }
    const iterations = end - start;
    const runsPerSecond = (iterations * 1_000) / durationMs;
    workers[name] = { iterations, runsPerSecond };
    if (runsPerSecond > maximumRunsPerSecond) {
      violations.push(
        `idle-maintenance/${name}: ${runsPerSecond.toFixed(2)} iterations/s exceeds ${maximumRunsPerSecond}`,
      );
    }
  }
  return { durationMs, maximumRunsPerSecond, workers, violations };
}

export function isolatedOrigin(value, env = process.env) {
  if (env.AERALYTH_PERF_ISOLATED !== "1") {
    throw new Error(
      "Mixed load mutates fixture data; AERALYTH_PERF_ISOLATED=1 is required",
    );
  }
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "The API target must be an HTTP(S) URL without credentials",
    );
  }
  const allowed = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    ...(env.AERALYTH_PERF_ISOLATED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
  ]);
  if (!allowed.has(url.hostname)) {
    throw new Error("The API host must be loopback or explicitly isolated");
  }
  return url.origin;
}
