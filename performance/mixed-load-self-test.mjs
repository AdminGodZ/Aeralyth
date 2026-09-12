import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isolatedOrigin } from "./arrival-load.mjs";

isolatedOrigin(process.env.AERALYTH_PERF_URL ?? "http://127.0.0.1:8080/health");
const execute = promisify(execFile);
const directory = await mkdtemp(path.join(tmpdir(), "aeralyth-mixed-fault-"));
const output =
  process.env.AERALYTH_PERF_FAULT_OUTPUT ?? path.join(directory, "result.json");
try {
  let exitCode = 0;
  try {
    await execute(
      process.execPath,
      [fileURLToPath(new URL("./mixed-load.mjs", import.meta.url))],
      {
        timeout: 180_000,
        maxBuffer: 32 * 1_048_576,
        env: {
          ...process.env,
          AERALYTH_PERF_OUTPUT: output,
          AERALYTH_PERF_BASELINE_SECONDS: "2",
          AERALYTH_PERF_DURATION_SECONDS: "4",
          AERALYTH_PERF_RECOVERY_SECONDS: "2",
          AERALYTH_PERF_ARRIVAL_RATE: "20",
          AERALYTH_PERF_CONCURRENCY: "2",
          AERALYTH_PERF_TIMEOUT_MS: "5000",
          AERALYTH_PERF_MAX_P99_MS: "1000",
          AERALYTH_PERF_INJECT_DB_STALL_MS: "1800",
          AERALYTH_PERF_ENFORCE_THRESHOLDS: "1",
          AERALYTH_PERF_MAX_ERROR_RATE: "0",
          AERALYTH_PERF_MAX_DROPPED_RATE: "0",
        },
      },
    );
  } catch (error) {
    if (error.code !== 1) throw error;
    exitCode = error.code;
  }
  const report = JSON.parse(await readFile(output, "utf8"));
  assert.equal(
    exitCode,
    1,
    "an injected DB stall must fail the performance gate",
  );
  assert.equal(
    report.fixtureCleanup,
    "complete",
    "fault fixture must clean up",
  );
  assert.equal(report.phases.length, 3, "fault run must finish every phase");
  assert.ok(
    report.violations.length > 0,
    "fault run needs a reported violation",
  );
  assert.ok(
    report.violations.every((message) => /: (dropped |p99 )/.test(message)),
    `fault run failed for a reason other than tail latency or dropped arrivals: ${report.violations.join("; ")}`,
  );
  const mixed = report.phases.find((phase) => phase.name === "mixed");
  assert.equal(mixed.failed, 0, "injection must not hide HTTP/schema errors");
  assert.ok(
    mixed.dropped > 0 || mixed.latencyMs.all.p99 > 1_000,
    "the injected DB stall must change the measured mixed workload",
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        expectedGateFailure: report.violations,
        mixedOffered: mixed.offered,
        mixedStarted: mixed.started,
        mixedDropped: mixed.dropped,
        mixedP99Ms: mixed.latencyMs.all.p99,
        output:
          process.env.AERALYTH_PERF_FAULT_OUTPUT ?? "temporary fixture report",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
