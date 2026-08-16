import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FOLDER_ZIP_WORKER_URL,
  VAULT_WORKER_URL,
} from "@/generated/worker-assets";

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
    ["public/vault.worker.js", VAULT_WORKER_URL],
    ["public/folder-zip.worker.js", FOLDER_ZIP_WORKER_URL],
  ])("matches the committed contents of %s", async (path, url) => {
    const bytes = await readFile(resolve(root, path));
    const fingerprint = createHash("sha256").update(bytes).digest("hex");

    expect(url).toBe(`/${basename(path)}?v=${fingerprint}`);
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
    const repositoryArchive = readFileSync(
      resolve(root, "src/features/repositories/repository-archive.ts"),
      "utf8",
    );

    expect(vaultClient).toContain("new Worker(VAULT_WORKER_URL");
    expect(uploadPanel).toContain("new Worker(FOLDER_ZIP_WORKER_URL");
    expect(repositoryArchive).toContain("new Worker(FOLDER_ZIP_WORKER_URL");
    const allSource = sourceFiles(resolve(root, "src"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(allSource).not.toMatch(
      /new Worker\(["']\/(?:vault|folder-zip)\.worker\.js/,
    );
  });
});
