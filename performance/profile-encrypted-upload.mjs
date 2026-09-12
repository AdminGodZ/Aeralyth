import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Runs the production upload scheduler, assembler, checksum, and retry code.
// Crypto and authenticated API/storage I/O use explicitly controlled adapters.
// No account data, credentials, browser, or live storage service are involved.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselineRef = "fe9556cf9f011297e16500f18cdf04b991b35635";
const partBytes = 32 * 1024 * 1024;
const cryptoBytes = 4 * 1024 * 1024;
const maximumCiphertextBytes = 2_415_919_104;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await mkdtemp(path.join(tmpdir(), "aeralyth-upload-profile-"));
const sourcePath = "src/features/vault/encrypted-upload.ts";
const currentSource = await readFile(path.join(root, sourcePath), "utf8");
const baselineSource = execFileSync(
  "git",
  ["show", `${baselineRef}:${sourcePath}`],
  {
    cwd: root,
    encoding: "utf8",
  },
);
const sourceHash = (source) =>
  createHash("sha256").update(source).digest("hex");
const helperHashes = Object.fromEntries(
  await Promise.all(
    [
      "src/features/vault/bounded-async.ts",
      "src/features/vault/buffered-bytes.ts",
      "src/features/vault/protocol.ts",
      "src/features/uploads/upload-retry.ts",
    ].map(async (file) => [
      file,
      sourceHash(await readFile(path.join(root, file))),
    ]),
  ),
);
const fixtureKey = "__aeralythUploadProfile";

const scenarios = [
  { name: "multipart-threshold-plus-one", bytes: [partBytes + 1], cores: 8 },
  { name: "64-mib", bytes: [64 * 1024 * 1024], cores: 8 },
  { name: "128-mib", bytes: [128 * 1024 * 1024], cores: 8 },
  { name: "maximum-supported", bytes: [maximumCiphertextBytes], cores: 8 },
  {
    name: "mixed-two-core",
    bytes: [64 * 1024 * 1024, 64 * 1024, 128 * 1024],
    cores: 2,
  },
  {
    name: "mixed-single-core",
    bytes: [64 * 1024 * 1024, 64 * 1024, 128 * 1024],
    cores: 1,
  },
];

async function bundle(label, source) {
  const outfile = path.join(temp, `${label}.mjs`);
  await build({
    stdin: {
      contents: source,
      loader: "ts",
      resolveDir: root,
      sourcefile: `${label}-encrypted-upload.ts`,
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    plugins: [
      {
        name: "controlled-upload-adapters",
        setup(plugin) {
          plugin.onResolve({ filter: /^\//, namespace: "profile" }, (args) => ({
            path: args.path,
            namespace: "file",
          }));
          plugin.onResolve({ filter: /^@\// }, async (args) => {
            const name = args.path.split("/").at(-1);
            if (
              [
                "vault-api",
                "share-directory-sync",
                "bounded-async",
                "buffered-bytes",
              ].includes(name)
            ) {
              return { path: name, namespace: "profile" };
            }
            return plugin.resolve(path.join(root, "src", args.path.slice(2)), {
              kind: args.kind,
              resolveDir: root,
            });
          });
          plugin.onLoad({ filter: /.*/, namespace: "profile" }, (args) => {
            const fixture = `globalThis.${fixtureKey}`;
            if (args.path === "vault-api") {
              const names = [
                "abortVaultUpload",
                "getVaultContentUrl",
                "getVaultPartUrl",
                "getVaultPartUrls",
                "initVaultUpload",
                "publishVaultFoldersBatch",
                "publishVaultUpload",
              ];
              return {
                contents: names
                  .map(
                    (name) =>
                      `export const ${name} = (...args) => ${fixture}.${name}(...args);`,
                  )
                  .join("\n"),
              };
            }
            if (args.path === "share-directory-sync") {
              return {
                contents:
                  "export const beginShareDirectorySyncBatch = () => 'profile'; export const enqueueShareDirectorySync = () => {}; export const finishShareDirectorySyncBatch = async () => {};",
              };
            }
            const original = JSON.stringify(
              path.join(root, `src/features/vault/${args.path}.ts`),
            );
            if (args.path === "buffered-bytes") {
              return {
                contents: `
              export { ExactStreamReader } from ${original};
              import { FixedSizeBufferAssembler as Original } from ${original};
              export class FixedSizeBufferAssembler extends Original {
                constructor(capacity) { super(capacity, (length) => {
                  const bytes = new Uint8Array(length);
                  ${fixture}.holdBuffer(bytes.buffer);
                  return bytes;
                }); }
              }
            `,
              };
            }
            return {
              contents: `
            export { detectedCryptoConcurrency, WeightedSemaphore, mapWithConcurrency } from ${original};
            import { BoundedBatchPipeline as Batch, BoundedRollingPipeline as Rolling } from ${original};
            export class BoundedBatchPipeline extends Batch {
              constructor(batchSize, lookahead, process) {
                super(batchSize, lookahead, async (parts) => {
                  try { return await process(parts); }
                  finally { for (const part of parts) ${fixture}.releaseBuffer(part.content.buffer); }
                });
              }
            }
            export class BoundedRollingPipeline extends Rolling {
              constructor(concurrency, capacity, sizeOf, process, signal, onFailure) {
                super(concurrency, capacity, sizeOf, async (part) => {
                  try { return await process(part); }
                  finally { ${fixture}.releaseBuffer(part.content.buffer); }
                }, signal, onFailure);
              }
            }
          `,
            };
          });
        },
      },
    ],
  });
  return import(pathToFileURL(outfile).href);
}

async function profile(module, variant, scenario) {
  globalThis.gc?.();
  const origin = performance.now();
  const now = () => performance.now() - origin;
  const startMemory = process.memoryUsage();
  const memoryPeak = { ...startMemory };
  const ownedBuffers = new Map();
  let peakOwnedAssemblerAndPartBytes = 0;
  let peakOwnedBufferCount = 0;
  let activePuts = 0;
  let peakActivePuts = 0;
  let presignRequests = 0;
  const events = [];
  const files = scenario.bytes.map((ciphertextBytes, index) => {
    const chunkCount = Math.ceil(ciphertextBytes / (cryptoBytes + 16));
    return {
      id: `file-${index}`,
      ciphertextBytes,
      chunkCount,
      size: ciphertextBytes - chunkCount * 16,
    };
  });
  const byId = new Map(files.map((file) => [file.id, file]));
  const memorySample = () => {
    for (const [key, value] of Object.entries(process.memoryUsage())) {
      memoryPeak[key] = Math.max(memoryPeak[key], value);
    }
  };
  const signedPart = (id, partNumber) => ({
    partNumber,
    url: `https://profile.invalid/${id}/${partNumber}`,
    contentLength: Math.min(
      partBytes,
      byId.get(id).ciphertextBytes - (partNumber - 1) * partBytes,
    ),
  });
  const record = {
    bootstrapCbor: new Uint8Array(),
    bootstrapSignature: new Uint8Array(),
    encryptedManifest: new Uint8Array(),
    wrappers: [],
  };
  const fixture = {
    holdBuffer(buffer) {
      ownedBuffers.set(buffer, buffer.byteLength);
      peakOwnedBufferCount = Math.max(peakOwnedBufferCount, ownedBuffers.size);
      peakOwnedAssemblerAndPartBytes = Math.max(
        peakOwnedAssemblerAndPartBytes,
        [...ownedBuffers.values()].reduce((sum, bytes) => sum + bytes, 0),
      );
      memorySample();
    },
    releaseBuffer(buffer) {
      ownedBuffers.delete(buffer);
      memorySample();
    },
    async initVaultUpload(_csrf, input) {
      events.push({ event: "init-start", file: input.nodeId, ms: now() });
      await delay(5);
      return {
        uploadId: input.nodeId,
        nodeId: input.nodeId,
        mode: input.ciphertextLength > partBytes ? "multipart" : "single",
        partSizeBytes: partBytes,
      };
    },
    async getVaultPartUrls(_csrf, id, parts) {
      presignRequests++;
      await delay(2);
      return {
        parts: parts.map(({ partNumber }) => signedPart(id, partNumber)),
      };
    },
    async getVaultPartUrl(_csrf, id, partNumber) {
      return signedPart(id, partNumber);
    },
    async getVaultContentUrl(_csrf, id) {
      return signedPart(id, 1);
    },
    async publishVaultUpload(_csrf, id, parts) {
      events.push({ event: "publish-start", file: id, ms: now() });
      if (byId.get(id).ciphertextBytes > partBytes) {
        assert.deepEqual(
          parts.map((part) => part.partNumber),
          Array.from(
            { length: Math.ceil(byId.get(id).ciphertextBytes / partBytes) },
            (_, i) => i + 1,
          ),
        );
      }
      await delay(id === "file-0" ? 200 : 5);
      return {
        nodeId: id,
        generationNumber: 1,
        generationId: "profile",
        recordVersion: 1,
        recordHash: "profile",
        shareSyncRequired: false,
      };
    },
    async publishVaultFoldersBatch() {
      return { folders: [] };
    },
    async abortVaultUpload() {
      throw new Error("Unexpected profile abort");
    },
  };
  globalThis[fixtureKey] = fixture;
  Object.defineProperty(globalThis, "navigator", {
    value: { hardwareConcurrency: scenario.cores, deviceMemory: 1 },
    configurable: true,
  });
  globalThis.fetch = async (url, init) => {
    const [, id, partValue] = new URL(url).pathname.split("/");
    const part = Number(partValue);
    const file = byId.get(id);
    assert.equal(init.method, "PUT");
    assert.equal(init.body.byteLength, signedPart(id, part).contentLength);
    assert.equal(typeof init.headers["x-amz-checksum-sha256"], "string");
    assert.equal(init.body[0], 7);
    assert.equal(init.body[init.body.length - 1], 7);
    activePuts++;
    peakActivePuts = Math.max(peakActivePuts, activePuts);
    events.push({
      event: "put-start",
      file: id,
      part,
      ms: now(),
      bytes: init.body.byteLength,
      activePuts,
    });
    memorySample();
    await delay(file.ciphertextBytes > partBytes && part === 1 ? 300 : 35);
    assert.equal(init.body[0], 7, "body must remain owned until PUT settles");
    activePuts--;
    events.push({ event: "put-end", file: id, part, ms: now(), activePuts });
    // The single-upload path wipes the buffer immediately after this return;
    // release accounting here avoids retaining a copy in the profiling adapter.
    if (file.ciphertextBytes <= partBytes)
      fixture.releaseBuffer(init.body.buffer);
    return new Response(null, {
      status: 200,
      headers: { ETag: `etag-${part}` },
    });
  };
  const client = {
    async startEncryption(input) {
      const file = byId.get(input.name);
      return {
        sessionId: file.id,
        nodeId: file.id,
        generationNumber: 1,
        generationId: "profile",
        recordVersion: 1,
        paddedBytes: file.size,
        ciphertextLength: file.ciphertextBytes,
        chunkCount: file.chunkCount,
      };
    },
    async encryptChunk(id, index, plaintext) {
      const file = byId.get(id);
      await delay(1);
      const length = Math.min(
        cryptoBytes + 16,
        file.ciphertextBytes - index * (cryptoBytes + 16),
      );
      new Uint8Array(plaintext).fill(0);
      const ciphertext = new Uint8Array(length).fill(7);
      if (index === 0)
        events.push({ event: "crypto-start", file: id, ms: now() });
      if (index === file.chunkCount - 1)
        events.push({ event: "crypto-end", file: id, ms: now() });
      memorySample();
      return { ciphertext: ciphertext.buffer, ciphertextBytes: length };
    },
    async finalizeEncryption(id) {
      await delay(3);
      return {
        nodeId: id,
        generationNumber: 1,
        generationId: "profile",
        recordVersion: 1,
        ciphertextLength: byId.get(id).ciphertextBytes,
        chunkCount: byId.get(id).chunkCount,
        record,
      };
    },
    async abortEncryption() {
      throw new Error("Unexpected crypto abort");
    },
  };
  const sampling = setInterval(memorySample, 10);
  try {
    await module.uploadEncryptedSelections({
      selections: files.map((file) => ({
        relativePath: file.id,
        file: {
          name: file.id,
          type: "application/octet-stream",
          size: file.size,
          lastModified: 0,
          slice(start, end) {
            return {
              async arrayBuffer() {
                return new ArrayBuffer(end - start);
              },
            };
          },
        },
      })),
      parentFolderId: null,
      csrfToken: "controlled-profile",
      client,
      signal: new AbortController().signal,
      onProgress() {},
      onFileStart(index) {
        events.push({ event: "file-start", file: files[index].id, ms: now() });
      },
      onFileComplete(index) {
        events.push({ event: "file-end", file: files[index].id, ms: now() });
      },
    });
  } finally {
    clearInterval(sampling);
  }
  const elapsedMs = now();
  memorySample();
  assert.equal(
    ownedBuffers.size,
    0,
    "all allocated assembler/part buffers must be released",
  );
  assert.equal(activePuts, 0);
  assert.ok(peakActivePuts <= 4);
  assert.ok(
    peakOwnedAssemblerAndPartBytes <= 6 * partBytes,
    "existing part/assembler memory ceiling",
  );
  const firstPut = events.find((event) => event.event === "put-start");
  const ends = events.filter((event) => event.event === "put-end");
  const lastPut = ends.at(-1);
  const firstSlowEnd = ends.find(
    (event) => event.file === "file-0" && event.part === 1,
  );
  const fifthStart = events.find(
    (event) =>
      event.event === "put-start" &&
      event.file === "file-0" &&
      event.part === 5,
  );
  const totalCiphertextBytes = files.reduce(
    (sum, file) => sum + file.ciphertextBytes,
    0,
  );
  let previousPutEventMs = null;
  let previouslyActivePuts = 0;
  let unusedPutSlotMs = 0;
  for (const event of events) {
    if (event.event !== "put-start" && event.event !== "put-end") continue;
    if (previousPutEventMs !== null) {
      unusedPutSlotMs +=
        (4 - previouslyActivePuts) * (event.ms - previousPutEventMs);
    }
    previouslyActivePuts = event.activePuts;
    previousPutEventMs = event.ms;
  }
  return {
    variant,
    scenario: scenario.name,
    hardwareConcurrency: scenario.cores,
    simulatedDeviceMemoryGiB: 1,
    totalCiphertextBytes,
    totalPlaintextBytes: files.reduce((sum, file) => sum + file.size, 0),
    chunkCount: files.reduce((sum, file) => sum + file.chunkCount, 0),
    partCount: ends.length,
    firstPutMs: firstPut.ms,
    lastPutMs: lastPut.ms,
    elapsedMs,
    transferPhaseMiBPerSecond:
      totalCiphertextBytes /
      (1024 * 1024) /
      ((lastPut.ms - firstPut.ms) / 1000),
    completePhaseMiBPerSecond:
      totalCiphertextBytes / (1024 * 1024) / (elapsedMs / 1000),
    presignRequests,
    unusedPutSlotMs,
    peakActivePuts,
    peakOwnedAssemblerAndPartBytes,
    peakOwnedBufferCount,
    ownedAssemblerAndPartCeilingBytes: 6 * partBytes,
    firstSlowPartEndMs: firstSlowEnd.ms,
    fifthPartStartMs: fifthStart?.ms ?? null,
    fifthPartStartedBeforeFirstPartEnded: fifthStart
      ? fifthStart.ms < firstSlowEnd.ms
      : null,
    peakRssBytes: memoryPeak.rss,
    initialRssBytes: startMemory.rss,
    peakArrayBufferBytes: memoryPeak.arrayBuffers,
    initialArrayBufferBytes: startMemory.arrayBuffers,
    peakExternalBytes: memoryPeak.external,
    files: files.map((file) => ({
      ...file,
      firstPutMs: events.find(
        (event) => event.event === "put-start" && event.file === file.id,
      ).ms,
      publishStartMs: events.find(
        (event) => event.event === "publish-start" && event.file === file.id,
      ).ms,
      completeMs: events.find(
        (event) => event.event === "file-end" && event.file === file.id,
      ).ms,
    })),
    events,
  };
}

try {
  const modules = {
    baseline: await bundle("baseline", baselineSource),
    current: await bundle("current", currentSource),
  };
  const results = [];
  for (const scenario of scenarios) {
    for (const variant of ["baseline", "current"]) {
      const result = await profile(modules[variant], variant, scenario);
      results.push(result);
      console.info(
        JSON.stringify({
          scenario: scenario.name,
          variant,
          firstPutMs: result.firstPutMs,
          elapsedMs: result.elapsedMs,
          peakOwnedAssemblerAndPartBytes: result.peakOwnedAssemblerAndPartBytes,
          peakRssBytes: result.peakRssBytes,
        }),
      );
    }
  }
  const maximumBaseline = results.find(
    (row) => row.scenario === "maximum-supported" && row.variant === "baseline",
  );
  const maximumCurrent = results.find(
    (row) => row.scenario === "maximum-supported" && row.variant === "current",
  );
  assert.equal(maximumBaseline.fifthPartStartedBeforeFirstPartEnded, false);
  assert.equal(maximumCurrent.fifthPartStartedBeforeFirstPartEnded, true);
  for (const result of results.filter(
    (row) => row.scenario === "mixed-two-core",
  )) {
    assert.equal(
      result.files[1].completeMs < result.files[0].completeMs,
      result.variant === "current",
    );
  }
  const output = process.env.AERALYTH_UPLOAD_PROFILE_OUTPUT
    ? path.resolve(process.env.AERALYTH_UPLOAD_PROFILE_OUTPUT)
    : path.join(
        root,
        "performance/results/upload-pipeline-profile-2026-09-12.json",
      );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        nodeVersion: process.version,
        execArgv: process.execArgv,
        baselineRef,
        sourceHashes: {
          baseline: sourceHash(baselineSource),
          current: sourceHash(currentSource),
          sharedHelpers: helperHashes,
        },
        methodology: {
          real: [
            "current and historical production upload scheduling",
            "32 MiB part assembly and 4 MiB generated chunks",
            "SHA-256 part checksums",
            "retry wrapper",
            "actual wall-clock phase timings",
            "native process RSS and ArrayBuffer sampling",
            "allocated live assembler/part buffer accounting",
          ],
          controlled: [
            "crypto adapter produces generated ciphertext with 1 ms delay per chunk",
            "init 5 ms, presign 2 ms, finalize 3 ms",
            "first part 300 ms, other PUTs 35 ms",
            "first file publication 200 ms, others 5 ms",
            "navigator hardwareConcurrency and deviceMemory hints",
          ],
          limitations: [
            "No real encryption, network, disk, account, or browser",
            "deviceMemory is a hint, not a physical 1 GiB memory constraint",
            "process memory includes allocator/GC and instrumentation",
            "single sample per scenario, baseline then current; no statistical speed claims",
            "historical uploader entrypoint uses the same current semaphore, assembler, protocol, and retry helpers; their hashes are recorded",
            "all profiles run in one process; allocator-retained RSS carries between scenarios despite requested GC",
            "owned assembler/part metric excludes transient plaintext/ciphertext and native digest copies, captured separately in RSS/ArrayBuffers",
          ],
        },
        results,
      },
      null,
      2,
    )}\n`,
  );
  execFileSync(
    path.join(root, "node_modules/.bin/biome"),
    ["format", "--write", output],
    { stdio: "ignore" },
  );
  console.info(`Saved ${output}`);
} finally {
  delete globalThis[fixtureKey];
  await rm(temp, { recursive: true, force: true });
}
