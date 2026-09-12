import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const scratch = await mkdtemp(
  path.join(os.tmpdir(), "aeralyth-preview-profile-"),
);
const output = path.join(root, "performance/results/legacy-preview-2026-09-12");
const sourcePath = "src/features/repositories/repository-file-loader.ts";
const baselineRevision = "fe9556cf9f011297e16500f18cdf04b991b35635";
const baseline = execFileSync(
  "git",
  ["show", `${baselineRevision}:${sourcePath}`],
  { encoding: "utf8" },
);
const current = await readFile(sourcePath, "utf8");
const runner = `
import { createHash } from "node:crypto";
import { loadRepositoryFile as current } from ${JSON.stringify(path.join(root, sourcePath))};
import { loadRepositoryFile as baseline } from "./baseline.ts";
const variant = process.argv[2];
const load = variant === "current" ? current : baseline;
const bytes = 100 * 1024 * 1024;
const chunkBytes = 1024 * 1024;
let copiedBytes = 0;
let copyCalls = 0;
let reads = 0;
let canceled = false;
const peaks = { rss: 0, arrayBuffers: 0, external: 0 };
const sample = () => { const memory = process.memoryUsage(); for (const key of Object.keys(peaks)) peaks[key] = Math.max(peaks[key], memory[key]); };
const originalFrom = Uint8Array.from;
const originalFetch = globalThis.fetch;
const expected = createHash("sha256");
globalThis.fetch = async () => new Response(new ReadableStream({
  pull(controller) {
    if (reads === bytes / chunkBytes) { controller.close(); return; }
    const chunk = new Uint8Array(chunkBytes).fill((reads++ % 251) + 1);
    expected.update(chunk);
    sample();
    controller.enqueue(chunk);
  },
  cancel() { canceled = true; },
}, { highWaterMark: 0 }), { headers: { "content-length": String(bytes), "content-type": "image/png" } });
Uint8Array.from = function(...args) { const result = Reflect.apply(originalFrom, this, args); copyCalls += 1; copiedBytes += result.byteLength; sample(); return result; };
globalThis.gc?.();
const initialMemory = process.memoryUsage();
let loaded;
const started = performance.now();
try {
  loaded = await load({
    entry: { id: "synthetic", entryType: "file", e2eeState: "legacy", sizeBytes: bytes, mimeType: "image/png", updatedAt: "2026-09-12T00:00:00Z" },
    resolvedName: "synthetic.png",
    vault: { client: null, openNode() { throw new Error("Unexpected encrypted path"); } },
    onProgress: sample,
  });
  sample();
} finally { Uint8Array.from = originalFrom; globalThis.fetch = originalFetch; }
const durationMs = performance.now() - started;
const observed = createHash("sha256");
for await (const chunk of loaded.blob.stream()) observed.update(chunk);
const actualSha256 = observed.digest("hex");
const expectedSha256 = expected.digest("hex");
if (loaded.blob.size !== bytes || actualSha256 !== expectedSha256 || reads !== 100) throw new Error("Preview content changed");
if (copiedBytes !== (variant === "current" ? 0 : bytes)) throw new Error("Explicit copy budget changed");
console.log(JSON.stringify({ variant, durationMs, bytes, chunkBytes, reads, copyCalls, explicitCopiedBytes: copiedBytes, initialMemory, sampledPeakMemory: peaks, sha256: actualSha256, matchesSource: true, sourceStreamCanceled: canceled }));
`;

try {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(scratch, "baseline.ts"), baseline);
  await writeFile(path.join(scratch, "runner.ts"), runner);
  await build({
    entryPoints: [path.join(scratch, "runner.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    outfile: path.join(scratch, "runner.mjs"),
    alias: { "@": path.join(root, "src") },
  });
  const runs = [];
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const variants =
      repetition % 2 ? ["current", "baseline"] : ["baseline", "current"];
    for (const variant of variants) {
      const result = execFileSync(
        process.execPath,
        [
          "--expose-gc",
          "--max-old-space-size=256",
          path.join(scratch, "runner.mjs"),
          variant,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      runs.push({ repetition, ...JSON.parse(result) });
    }
  }
  const median = (values) =>
    values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summaries = ["baseline", "current"].map((variant) => {
    const selected = runs.filter((run) => run.variant === variant);
    return {
      variant,
      medianDurationMs: median(selected.map((run) => run.durationMs)),
      explicitCopiedBytes: selected[0].explicitCopiedBytes,
      medianPeakArrayBuffers: median(
        selected.map((run) => run.sampledPeakMemory.arrayBuffers),
      ),
      medianPeakRss: median(selected.map((run) => run.sampledPeakMemory.rss)),
    };
  });
  const hash = (source) => createHash("sha256").update(source).digest("hex");
  const result = {
    recordedAt: new Date().toISOString(),
    command: "node performance/profile-legacy-preview.mjs",
    runtime: process.version,
    baselineRevision,
    sourceHashes: {
      baseline: hash(baseline),
      current: hash(current),
      harness: hash(await readFile(import.meta.filename)),
    },
    methodology:
      "Actual historical/current legacy loader, maximum 100 MiB preview, fresh process per sample, three samples per variant with alternating order, genuine Response/ReadableStream/Blob and complete SHA-256 verification.",
    limitations: [
      "The PNG filename selects the full media-preview budget. These generated bytes are a transport fixture, not a decodable image and do not exercise image rendering.",
      "Uint8Array.from instrumentation counts the explicit application copy removed by PERF-034. Native Blob, response, decoder and allocator copies are not included in that counter.",
      "Memory samples are taken at stream production, explicit copies, progress callbacks and completion; RSS and ArrayBuffers are observed sampled peaks, not a browser heap profile or exact instantaneous maximum.",
      "This is a Node stream allocation comparison with generated local data, not browser paint or real provider throughput. The 256 MiB V8 heap setting is not a physical-memory cap.",
      "The timed interval includes fixture chunk generation, expected SHA-256 calculation and instrumentation in addition to the loader; it does not isolate loader CPU cost. The complete output digest is checked after timing.",
    ],
    summaries,
    runs,
  };
  await writeFile(
    path.join(output, "summary.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(summaries, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
