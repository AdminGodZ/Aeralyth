import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  isolatedOrigin,
  latencySummary,
  maintenanceIdleSummary,
  phaseViolations,
  runArrivalPhase,
} from "./arrival-load.mjs";

const defaults = {
  name: "mixed",
  durationSeconds: 0.15,
  arrivalRate: 100,
  concurrency: 4,
  timeoutMs: 200,
  maximumStartDelayMs: 100,
};

test("latency reports preserve slow failures rather than successful-only tails", () => {
  assert.deepEqual(latencySummary([1, 2, 500]), {
    count: 3,
    mean: 503 / 3,
    p50: 2,
    p95: 500,
    p99: 500,
    max: 500,
  });
  assert.equal(latencySummary([]).p99, null);
});

test("mixed arrivals start on schedule and retain per-operation results", async () => {
  const result = await runArrivalPhase({
    ...defaults,
    operations: [
      { name: "browse", weight: 2, run: async () => {} },
      { name: "metadata", weight: 1, run: async () => {} },
    ],
  });
  assert.equal(result.offered, 15);
  assert.equal(result.started, 15);
  assert.equal(result.completed, 15);
  assert.equal(result.operations.browse.successful, 10);
  assert.equal(result.operations.metadata.successful, 5);
  assert.equal(result.dropped, 0);
  assert.deepEqual(phaseViolations(result, { maximumP99Ms: 100 }), []);
});

test("an injected gate stall drops arrivals without reducing offered work", async () => {
  const result = await runArrivalPhase({
    ...defaults,
    concurrency: 1,
    operations: [{ name: "browse", run: () => delay(80) }],
  });
  assert.equal(result.offered, 15);
  assert.equal(result.started + result.dropped, result.offered);
  assert.equal(result.started, result.completed);
  assert.ok(result.dropped >= 10);
  assert.ok(
    phaseViolations(result, { maximumP99Ms: 1_000 }).some((message) =>
      message.includes("dropped"),
    ),
  );
});

test("slow failed responses stay in failure and all-response tail thresholds", async () => {
  let index = 0;
  const result = await runArrivalPhase({
    ...defaults,
    concurrency: 32,
    operations: [
      {
        name: "metadata",
        async run() {
          index += 1;
          if (index % 5 === 0) {
            await delay(70);
            throw new Error("injected DB timeout");
          }
        },
      },
    ],
  });
  assert.equal(result.successful, 12);
  assert.equal(result.failed, 3);
  assert.equal(result.latencyMs.success.count, 12);
  assert.equal(result.latencyMs.failure.count, 3);
  assert.ok(result.latencyMs.failure.p99 >= 60);
  assert.ok(result.latencyMs.all.p99 >= 60);
  assert.ok(
    phaseViolations(result, {
      maximumP99Ms: 50,
      maximumErrorRate: 1,
    }).some((message) => message.includes("p99")),
  );
});

test("an operation ignoring abort retains capacity and cannot hang the run", async () => {
  let started = 0;
  const result = await runArrivalPhase({
    ...defaults,
    concurrency: 2,
    timeoutMs: 25,
    operations: [
      {
        name: "publication",
        run() {
          started += 1;
          return new Promise(() => {});
        },
      },
    ],
  });
  assert.equal(started, 2);
  assert.equal(result.failed, 2);
  assert.equal(result.dropped, 13);
  assert.ok(result.elapsedMs < 1_000);
});

test("HTTP body completion includes an injected provider stall", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    response.write("header-time-is-fast");
    setTimeout(() => response.end("body-completed"), 80);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const result = await runArrivalPhase({
      ...defaults,
      durationSeconds: 0.1,
      arrivalRate: 50,
      concurrency: 8,
      operations: [
        {
          name: "download",
          async run(signal) {
            const response = await fetch(`http://127.0.0.1:${port}`, {
              signal,
            });
            await response.arrayBuffer();
          },
        },
      ],
    });
    assert.equal(result.failed, 0);
    assert.ok(result.latencyMs.all.p99 >= 70);
    assert.ok(
      phaseViolations(result, { maximumP99Ms: 50 }).some((message) =>
        message.includes("p99"),
      ),
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("isolation authorization is required even for localhost mutations", () => {
  assert.throws(() => isolatedOrigin("http://localhost:8080", {}), /ISOLATED/);
  assert.throws(
    () =>
      isolatedOrigin("https://production.example", {
        AERALYTH_PERF_ISOLATED: "1",
      }),
    /loopback/,
  );
  assert.equal(
    isolatedOrigin("http://127.0.0.1:8080/health", {
      AERALYTH_PERF_ISOLATED: "1",
    }),
    "http://127.0.0.1:8080",
  );
  assert.throws(
    () =>
      isolatedOrigin("http://user:password@localhost", {
        AERALYTH_PERF_ISOLATED: "1",
      }),
    /credentials/,
  );
});

test("invalid or unbounded load parameters fail before any operation", async () => {
  await assert.rejects(
    runArrivalPhase({
      ...defaults,
      durationSeconds: 3_600,
      arrivalRate: 10_000,
      operations: [{ name: "browse", run: async () => {} }],
    }),
    /offered arrivals/,
  );
});

test("idle worker iteration budget catches a notification storm despite fast HTTP", () => {
  const key =
    'aeralyth_maintenance_duration_seconds_count{worker="storage deletion"}';
  const quiet = maintenanceIdleSummary({ [key]: 20 }, { [key]: 22 }, 2_000);
  assert.equal(quiet.workers["storage deletion"].runsPerSecond, 1);
  assert.deepEqual(quiet.violations, []);
  const storm = maintenanceIdleSummary({ [key]: 20 }, { [key]: 1_020 }, 2_000);
  assert.equal(storm.workers["storage deletion"].runsPerSecond, 500);
  assert.match(storm.violations[0], /500.00 iterations\/s exceeds 10/);
});

test("idle worker budget cannot pass with missing or reset metrics", () => {
  const key =
    'aeralyth_maintenance_duration_seconds_count{worker="storage deletion"}';
  assert.match(maintenanceIdleSummary({}, {}, 2_000).violations[0], /missing/);
  assert.match(
    maintenanceIdleSummary({ [key]: 20 }, { [key]: 1 }, 2_000).violations[0],
    /reset/,
  );
});
