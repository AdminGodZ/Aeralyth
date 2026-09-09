import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FOLDER_ZIP_WORKER_URL,
  UPLOAD_CHECKSUM_WORKER_URL,
  VAULT_WORKER_URL,
} from "@/generated/worker-assets";
import { ZIP_CODEC_WORKER_URL, ZIP_WASM_URL } from "@/generated/zip-assets";

const root = resolve(import.meta.dirname, "../..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

describe("worker asset fingerprints", () => {
  it.each([
    ["vault", VAULT_WORKER_URL],
    ["folder-zip", FOLDER_ZIP_WORKER_URL],
    ["upload-checksum", UPLOAD_CHECKSUM_WORKER_URL],
    ["zip-codec", ZIP_CODEC_WORKER_URL],
  ])("matches the emitted content hash for %s", async (name, url) => {
    expect(url).toMatch(
      new RegExp(`^/workers/${name}\\.([a-f0-9]{64})\\.worker\\.js$`, "u"),
    );
    const bytes = await readFile(resolve(root, `public${url}`));
    const fingerprint = createHash("sha256").update(bytes).digest("hex");

    expect(url).toBe(`/workers/${name}.${fingerprint}.worker.js`);
  });

  it("ships the matching ZIP WebAssembly module under its content hash", async () => {
    const bytes = await readFile(resolve(root, `public${ZIP_WASM_URL}`));
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    expect(ZIP_WASM_URL).toBe(`/workers/zip-module.${fingerprint}.wasm`);
    const packaged = await readFile(
      new URL(import.meta.resolve("@zip.js/zip.js/dist/zip-module.wasm")),
    );
    expect(bytes).toEqual(packaged);
    await expect(WebAssembly.compile(bytes)).resolves.toBeInstanceOf(
      WebAssembly.Module,
    );
  });

  it("serves only hash-named worker assets with immutable caching", () => {
    const config = readFileSync(resolve(root, "next.config.ts"), "utf8");
    const buildScript = readFileSync(
      resolve(root, "scripts/write-worker-assets.mjs"),
      "utf8",
    );

    expect(config).toContain('source: "/workers/:asset*"');
    expect(config).toContain('value: "public, max-age=31536000, immutable"');
    expect(buildScript).toMatch(
      /const fileName = `\$\{workerName\}\.\$\{fingerprint\}\.worker\.js`;/u,
    );
    expect(buildScript).not.toMatch(/\?v=\$\{fingerprint\}/u);
    expect(readdirSync(resolve(root, "public/workers")).sort()).toEqual(
      [
        VAULT_WORKER_URL,
        FOLDER_ZIP_WORKER_URL,
        UPLOAD_CHECKSUM_WORKER_URL,
        ZIP_CODEC_WORKER_URL,
        ZIP_WASM_URL,
      ]
        .map((url) => url.slice("/workers/".length))
        .sort(),
    );
  });

  it("uses fingerprinted URLs at every worker construction site", () => {
    const vaultClient = readFileSync(
      resolve(root, "src/features/vault/vault-client.ts"),
      "utf8",
    );
    const uploadPanel = readFileSync(
      resolve(root, "src/features/dashboard/upload-panel.tsx"),
      "utf8",
    );
    const browserArchive = readFileSync(
      resolve(root, "src/features/archive/browser-archive.ts"),
      "utf8",
    );
    const uploadChecksumClient = readFileSync(
      resolve(root, "src/features/dashboard/upload-checksum-client.ts"),
      "utf8",
    );

    expect(vaultClient).toContain("new Worker(VAULT_WORKER_URL");
    expect(uploadPanel).toContain("new Worker(FOLDER_ZIP_WORKER_URL");
    expect(browserArchive).toContain("new Worker(FOLDER_ZIP_WORKER_URL");
    expect(uploadChecksumClient).toContain(
      "new Worker(UPLOAD_CHECKSUM_WORKER_URL",
    );
    const allSource = sourceFiles(resolve(root, "src"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(allSource).not.toMatch(
      /new Worker\(["']\/(?:vault|folder-zip|upload-checksum)(?:\.[a-f0-9]{64})?\.worker\.js/,
    );
  });

  it("keeps decryption cancellation wired through the client and worker", () => {
    const vaultClient = readFileSync(
      resolve(root, "src/features/vault/vault-client.ts"),
      "utf8",
    );
    const vaultWorker = readFileSync(
      resolve(root, "src/features/vault/vault.worker.ts"),
      "utf8",
    );

    expect(vaultClient).toContain("async abortDecryption(");
    expect(vaultClient).toContain('type: "abortDecryption"');
    expect(vaultWorker).toContain('case "abortDecryption"');
    expect(vaultWorker).toContain(
      "for (const sessionId of decryptionSessions.keys())",
    );
    expect(vaultWorker).toContain("abortDecryption(sessionId);");
  });
});
