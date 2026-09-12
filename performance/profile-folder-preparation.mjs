import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceFile = "src/features/vault/encrypted-folder-upload.ts";
const helperFile = "src/features/vault/bounded-async.ts";
const sourceHashes = Object.fromEntries(
  await Promise.all(
    [sourceFile, helperFile].map(async (file) => [
      file,
      createHash("sha256")
        .update(await readFile(path.join(root, file)))
        .digest("hex"),
    ]),
  ),
);
const fixtureKey = "__aeralythFolderProfile";
const temporary = await mkdtemp(
  path.join(tmpdir(), "aeralyth-folder-profile-"),
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadScheduler() {
  const outfile = path.join(temporary, "scheduler.mjs");
  await build({
    entryPoints: [path.join(root, sourceFile)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    plugins: [
      {
        name: "controlled-folder-adapters",
        setup(plugin) {
          plugin.onResolve({ filter: /^@\// }, async (args) => {
            const name = args.path.split("/").at(-1);
            if (["vault-api", "share-directory-sync"].includes(name))
              return { path: name, namespace: "profile" };
            return plugin.resolve(path.join(root, "src", args.path.slice(2)), {
              kind: args.kind,
              resolveDir: root,
            });
          });
          plugin.onLoad(
            { filter: /.*/, namespace: "profile" },
            ({ path: name }) => ({
              contents:
                name === "vault-api"
                  ? `export const publishVaultFoldersBatch = (...args) => globalThis.${fixtureKey}.publish(...args);`
                  : `export const enqueueShareDirectorySync = (...args) => globalThis.${fixtureKey}.share(...args);`,
            }),
          );
        },
      },
    ],
  });
  return import(pathToFileURL(outfile).href);
}

function scenarios() {
  const wide = Array.from({ length: 1000 }, (_, index) => `wide-${index}`);
  const deep = [];
  const leaves = [];
  for (let branch = 0; branch < 10; branch++) {
    let folder = "";
    for (let level = 0; level < 100; level++) {
      folder = folder ? `${folder}/level-${level}` : `branch-${branch}`;
      deep.push(folder);
    }
    leaves.push(folder);
  }
  const empty = [
    "file-parent",
    ...Array.from({ length: 999 }, (_, index) => `empty-${index}`),
  ];
  return [
    { name: "wide-1000", folders: wide, fileParents: wide, cores: 8 },
    {
      name: "deep-10-branches-depth-100",
      folders: deep,
      fileParents: leaves,
      cores: 8,
    },
    {
      name: "empty-heavy-1000",
      folders: empty,
      fileParents: ["file-parent"],
      cores: 8,
    },
    {
      name: "failed-second-publication",
      folders: wide.slice(0, 250),
      fileParents: [],
      cores: 8,
      failBatch: 2,
    },
    {
      name: "cancel-late-worker-starts",
      folders: wide.slice(0, 40),
      fileParents: [],
      cores: 8,
      abortAfterMs: 2,
      startDelayMs: 20,
    },
  ];
}

async function profile(scheduler, scenario) {
  const origin = performance.now();
  const now = () => performance.now() - origin;
  const events = [];
  const sessions = new Map();
  const records = new Map();
  const knownByNode = new Map();
  const durable = new Set();
  const folderIds = new Map([["", ""]]);
  const fileParents = new Set(scenario.fileParents);
  const released = new Set();
  const shared = new Set();
  const batches = [];
  let activeCrypto = 0;
  let outstanding = 0;
  let prepared = 0;
  let peakCrypto = 0;
  let peakOutstanding = 0;
  let peakPrepared = 0;
  let cleaned = 0;
  let parentKeyChecks = 0;
  let publicationParentChecks = 0;
  let firstEligibleMs = null;
  let foldersRemainingAtFirstFileEligibility = null;
  let ordinal = 0;
  const sample = () => {
    peakCrypto = Math.max(peakCrypto, activeCrypto);
    peakOutstanding = Math.max(peakOutstanding, outstanding);
    peakPrepared = Math.max(peakPrepared, prepared);
    assert.ok(activeCrypto <= 4, "folder crypto tasks remain bounded");
    assert.ok(
      outstanding <= 100,
      "active, prepared, and publishing records share one bound",
    );
    assert.ok(prepared <= 100, "prepared record memory remains bounded");
  };
  const client = {
    async startEncryption(input) {
      assert.equal(input.entryType, "folder");
      assert.equal(input.plaintextBytes, 0);
      const parent = input.parentId ? knownByNode.get(input.parentId) : null;
      if (input.parentId) {
        assert.ok(
          parent && ["prepared", "durable"].includes(parent.state),
          "parent key must finalize before child starts",
        );
        parentKeyChecks++;
      }
      const entry = {
        sessionId: `session-${ordinal}`,
        nodeId: `node-${ordinal++}`,
        parentId: input.parentId,
        path: parent ? `${parent.path}/${input.name}` : input.name,
        state: "preparing",
      };
      sessions.set(entry.sessionId, entry);
      knownByNode.set(entry.nodeId, entry);
      activeCrypto++;
      outstanding++;
      sample();
      events.push({ event: "crypto-start", nodeId: entry.nodeId, ms: now() });
      await delay(scenario.startDelayMs ?? 1);
      return {
        sessionId: entry.sessionId,
        nodeId: entry.nodeId,
        generationNumber: 1,
        generationId: entry.nodeId,
        recordVersion: 1,
        paddedBytes: 0,
        ciphertextLength: 0,
        chunkCount: 0,
      };
    },
    async finalizeEncryption(sessionId) {
      const entry = sessions.get(sessionId);
      assert.equal(entry.state, "preparing");
      await delay(1);
      activeCrypto--;
      prepared++;
      entry.state = "prepared";
      sample();
      const record = {
        bootstrapCbor: new Uint8Array(32),
        bootstrapSignature: new Uint8Array(64),
        encryptedManifest: new Uint8Array(128),
        wrappers: [],
      };
      records.set(record, entry);
      events.push({
        event: "crypto-finalized",
        nodeId: entry.nodeId,
        ms: now(),
      });
      return {
        nodeId: entry.nodeId,
        generationNumber: 1,
        generationId: entry.nodeId,
        recordVersion: 1,
        ciphertextLength: 0,
        chunkCount: 0,
        record,
      };
    },
    async abortEncryption(sessionId, nodeId) {
      const entry = sessions.get(sessionId);
      assert.equal(entry.nodeId, nodeId);
      assert.ok(
        !durable.has(nodeId),
        "cleanup must retain durably published keys",
      );
      assert.ok(
        ["preparing", "prepared"].includes(entry.state),
        "each abandoned session is cleaned once",
      );
      if (entry.state === "preparing") activeCrypto--;
      else prepared--;
      outstanding--;
      entry.state = "aborted";
      cleaned++;
      events.push({ event: "cleaned", nodeId: entry.nodeId, ms: now() });
    },
  };
  const fixture = {
    async publish(_csrf, batch, signal) {
      assert.ok(batch.length > 0 && batch.length <= 100);
      const batchNumber = batches.length + 1;
      const parents = new Set(durable);
      const entries = batch.map((record) => {
        const entry = records.get(record);
        assert.equal(entry.state, "prepared");
        if (entry.parentId) {
          assert.ok(
            parents.has(entry.parentId),
            "publication requires a durable parent or earlier parent in this batch",
          );
          publicationParentChecks++;
        }
        parents.add(entry.nodeId);
        return entry;
      });
      batches.push({
        batch: batchNumber,
        count: entries.length,
        nodeIds: entries.map((entry) => entry.nodeId),
        parentIds: entries.map((entry) => entry.parentId),
        startMs: now(),
        publishedMs: null,
      });
      await delay(4);
      if (signal.aborted) throw signal.reason;
      if (scenario.failBatch === batchNumber)
        throw new Error("controlled publication failure");
      for (const entry of entries) {
        durable.add(entry.nodeId);
        entry.state = "durable";
        outstanding--;
        prepared--;
      }
      batches.at(-1).publishedMs = now();
      return {
        folders: entries.map((entry) => ({
          nodeId: entry.nodeId,
          generationNumber: 1,
          generationId: entry.nodeId,
          recordVersion: 1,
          recordHash: entry.nodeId,
          shareSyncRequired: true,
        })),
      };
    },
    share({ batchId, job }) {
      assert.equal(batchId, "controlled-folder-profile");
      assert.ok(durable.has(job.nodeId));
      assert.equal(job.entryType, "folder");
      shared.add(job.nodeId);
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { hardwareConcurrency: scenario.cores },
    configurable: true,
  });
  globalThis[fixtureKey] = fixture;
  const operation = new AbortController();
  const abortTimer =
    scenario.abortAfterMs === undefined
      ? undefined
      : setTimeout(
          () => operation.abort(new Error("controlled cancellation")),
          scenario.abortAfterMs,
        );
  let errorMessage = null;
  try {
    await scheduler.publishEncryptedFolderTree({
      folders: scenario.folders,
      folderIds,
      csrfToken: "controlled-profile",
      client,
      signal: operation.signal,
      shareSyncBatchId: "controlled-folder-profile",
      priorityParents: fileParents,
      onPublished(folder, nodeId) {
        assert.ok(
          durable.has(nodeId),
          "file eligibility requires durable publication",
        );
        assert.equal(folderIds.get(folder), nodeId);
        assert.ok(
          shared.has(nodeId),
          "share jobs precede dependency callbacks",
        );
        assert.ok(!released.has(folder));
        released.add(folder);
        events.push({ event: "folder-released", nodeId, ms: now() });
        if (fileParents.has(folder) && firstEligibleMs === null) {
          firstEligibleMs = now();
          foldersRemainingAtFirstFileEligibility =
            scenario.folders.length - durable.size;
        }
      },
    });
  } catch (error) {
    errorMessage = error.message;
  } finally {
    clearTimeout(abortTimer);
  }
  const elapsedMs = now();
  const expectFailure =
    scenario.failBatch || scenario.abortAfterMs !== undefined;
  assert.equal(errorMessage !== null, Boolean(expectFailure));
  assert.equal(outstanding, 0, "no uncleaned prepared/worker sessions remain");
  assert.equal(activeCrypto, 0);
  assert.equal(prepared, 0);
  assert.equal(shared.size, durable.size);
  assert.equal(released.size, durable.size);
  if (!expectFailure) {
    assert.equal(durable.size, scenario.folders.length);
    assert.ok(firstEligibleMs !== null && firstEligibleMs < elapsedMs);
    assert.ok(
      foldersRemainingAtFirstFileEligibility >= 100,
      "ready files must release while substantial unrelated preparation remains",
    );
    assert.ok(scenario.fileParents.every((folder) => released.has(folder)));
  } else if (scenario.failBatch) {
    assert.equal(errorMessage, "controlled publication failure");
    assert.equal(durable.size, 100);
    assert.equal(cleaned, 100);
  } else {
    assert.equal(errorMessage, "controlled cancellation");
    assert.equal(durable.size, 0);
    assert.equal(cleaned, 4);
  }
  return {
    scenario: scenario.name,
    folderCount: scenario.folders.length,
    maximumDepth: Math.max(
      ...scenario.folders.map((folder) => folder.split("/").length),
    ),
    fileParentCount: scenario.fileParents.length,
    emptyFolderCount: scenario.folders.filter(
      (folder) =>
        !fileParents.has(folder) &&
        !scenario.folders.some((child) => child.startsWith(`${folder}/`)),
    ).length,
    hardwareConcurrency: scenario.cores,
    elapsedMs,
    firstFileEligibleMs: firstEligibleMs,
    foldersRemainingAtFirstFileEligibility,
    priorAllFoldersBarrierEarliestEligibilityMs: scenario.fileParents.length
      ? elapsedMs
      : null,
    peakCryptoTasks: peakCrypto,
    peakPreparedRecords: peakPrepared,
    peakOutstandingRecords: peakOutstanding,
    recordCeiling: 100,
    cryptoTaskCeiling: 4,
    parentKeyChecks,
    publicationParentChecks,
    publishedFolders: durable.size,
    cleanedSessions: cleaned,
    retainedPublishedKeys: durable.size,
    startedSessions: sessions.size,
    pendingSessionsAfterCompletion: outstanding,
    publicationRequests: batches.length,
    errorMessage,
    batches,
    traceEventCount: events.length,
    traceSample:
      events.length <= 40
        ? events
        : [...events.slice(0, 20), ...events.slice(-20)],
  };
}

try {
  const scheduler = await loadScheduler();
  const results = [];
  for (const scenario of scenarios()) {
    const result = await profile(scheduler, scenario);
    results.push(result);
    console.info(
      JSON.stringify({
        scenario: result.scenario,
        elapsedMs: result.elapsedMs,
        firstFileEligibleMs: result.firstFileEligibleMs,
        peakCryptoTasks: result.peakCryptoTasks,
        peakOutstandingRecords: result.peakOutstandingRecords,
        cleanedSessions: result.cleanedSessions,
      }),
    );
  }
  const output = path.resolve(
    process.env.AERALYTH_FOLDER_PROFILE_OUTPUT ??
      path.join(root, "performance/results/folder-preparation-2026-09-12.json"),
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        nodeVersion: process.version,
        sourceHashes,
        methodology: {
          real: [
            "actual current folder dependency scheduler",
            "actual bounded semaphore hardware detection",
            "wall-clock timings",
            "record/session ownership counts",
            "parent-key and parent-publication ordering checks",
            "durable callbacks and share job ordering",
            "failure/cancellation cleanup",
          ],
          controlled: [
            "worker start 1 ms and finalize 1 ms; cancellation case start 20 ms",
            "folder publication 4 ms",
            "generated dummy encrypted records, no real cryptography",
            "publication failure in second 100-record batch",
            "cancellation 2 ms after starting four worker calls",
          ],
          limitations: [
            "current implementation only; prior barrier column is an earliest eligibility bound based on the same run, not a baseline measurement",
            "firstFileEligibleMs is the durable folder callback time, not a measured file PUT start",
            "single sample per scenario; no statistical performance claim",
            "no browser, account, database, real worker cryptography, network, or RSS measurement",
            "deep fixture uses the production-supported maximum depth 100",
            "1000 helper folders can include empty paths even though ordinary File selections do not represent empty directories",
            "prepared counts cover record count, not byte allocation because encrypted records are dummy data",
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
  await rm(temporary, { recursive: true, force: true });
}
