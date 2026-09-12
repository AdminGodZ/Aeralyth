import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  publishWorkerAsset,
  restoreWorkerAssets,
} from "./worker-asset-store.mjs";

const temporaryRoots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(resolve(tmpdir(), "aeralyth-worker-release-"));
  temporaryRoots.push(root);
  return root;
}

function name(bytes: Buffer, prefix = "vault", extension = "worker.js") {
  return `${prefix}.${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("immutable worker release archive", () => {
  it("serves the exact A worker and its WASM on a fresh B image without a builder cache", async () => {
    const buildA = await temporaryRoot();
    const workerA = Buffer.from('self.postMessage("protocol-A");');
    const wasmA = Buffer.from("version-A-wasm");
    await publishWorkerAsset(buildA, name(workerA), workerA);
    await publishWorkerAsset(buildA, name(wasmA, "zip-module", "wasm"), wasmA);

    // Only the checked-in archive crosses the release boundary. There is no
    // public directory, HTTP cache, image layer, or previous builder state.
    const buildB = await temporaryRoot();
    await cp(resolve(buildA, "deployment"), resolve(buildB, "deployment"), {
      recursive: true,
    });
    await restoreWorkerAssets(buildB);
    const workerB = Buffer.from('self.postMessage("protocol-B");');
    await publishWorkerAsset(buildB, name(workerB), workerB);
    expect(
      await readFile(resolve(buildB, "public/workers", name(workerA))),
    ).toEqual(workerA);
    expect(
      await readFile(resolve(buildB, "public/workers", name(workerB))),
    ).toEqual(workerB);
    expect(
      await readFile(
        resolve(buildB, "public/workers", name(wasmA, "zip-module", "wasm")),
      ),
    ).toEqual(wasmA);
  });

  it("refuses bytes that do not match the requested hash", async () => {
    const root = await temporaryRoot();
    await expect(
      publishWorkerAsset(root, name(Buffer.from("old")), Buffer.from("new")),
    ).rejects.toThrow("immutable name");
  });

  it("rejects a corrupted archive instead of serving a mismatched protocol", async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from("worker");
    await publishWorkerAsset(root, name(bytes), bytes);
    await writeFile(
      resolve(root, "deployment/worker-assets", `${name(bytes)}.gz`),
      "broken",
    );
    await expect(restoreWorkerAssets(root)).rejects.toThrow();
  });

  it("keeps archived bytes stable across repeated builds", async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from("worker");
    await publishWorkerAsset(root, name(bytes), bytes);
    const path = resolve(root, "deployment/worker-assets", `${name(bytes)}.gz`);
    const first = await readFile(path);
    await publishWorkerAsset(root, name(bytes), bytes);
    expect(await readFile(path)).toEqual(first);
  });
});
