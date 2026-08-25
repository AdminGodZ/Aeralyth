import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildFolderArchivePath,
  requestFolderArchiveManifest,
} from "@/features/files/folder-archive";
import type { FolderArchiveEntry } from "@/lib/api";

function entry(
  id: string,
  name: string,
  entryType: "file" | "folder",
  parentId: string,
): FolderArchiveEntry {
  return {
    id,
    name,
    mimeType: entryType === "file" ? "text/plain" : null,
    entryType,
    parentId,
    sizeBytes: entryType === "file" ? 12 : 0,
    e2eeState: "legacy",
    updatedAt: "2026-08-17T00:00:00Z",
    contentVersion: "2026-08-17T00:00:00.123456Z",
    vaultGenerationId: null,
    vaultRecordVersion: null,
    vaultRecordHash: null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("folder archive paths", () => {
  it("preserves nested folders beneath the selected folder", () => {
    const source = entry("folder", "src", "folder", "root");
    const nested = entry("nested", "features", "folder", source.id);
    const file = entry("file", "index.ts", "file", nested.id);
    const entriesById = new Map([
      [source.id, source],
      [nested.id, nested],
      [file.id, file],
    ]);
    const namesById = new Map(
      [...entriesById].map(([id, value]) => [id, value.name]),
    );

    expect(
      buildFolderArchivePath({
        entry: file,
        entriesById,
        namesById,
        rootFolderId: "root",
        archiveRoot: "project",
      }),
    ).toBe("project/src/features/index.ts");
  });

  it("rejects cycles and entries outside the selected folder", () => {
    const left = entry("left", "left", "folder", "right");
    const right = entry("right", "right", "folder", "left");
    const entriesById = new Map([
      [left.id, left],
      [right.id, right],
    ]);
    const namesById = new Map([
      [left.id, left.name],
      [right.id, right.name],
    ]);

    expect(() =>
      buildFolderArchivePath({
        entry: left,
        entriesById,
        namesById,
        rootFolderId: "root",
        archiveRoot: "project",
      }),
    ).toThrow("contains a cycle");

    const outside = entry("outside", "outside.txt", "file", "missing");
    expect(() =>
      buildFolderArchivePath({
        entry: outside,
        entriesById: new Map([[outside.id, outside]]),
        namesById: new Map([[outside.id, outside.name]]),
        rootFolderId: "root",
        archiveRoot: "project",
      }),
    ).toThrow("outside the selected folder");
  });
});

describe("folder archive manifest", () => {
  it("requests and validates the bounded recursive manifest", async () => {
    const child = entry("child", "empty", "folder", "root");
    const fetchMock = vi.fn(async () =>
      Response.json({ rootId: "root", entries: [child], totalBytes: 0 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestFolderArchiveManifest("root")).resolves.toEqual({
      rootId: "root",
      entries: [child],
      totalBytes: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/files/root/archive-manifest", {
      signal: undefined,
      cache: "no-store",
    });
  });

  it("rejects duplicate or root entries in a manifest", async () => {
    const child = entry("child", "child.txt", "file", "root");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          rootId: "root",
          entries: [child, child],
          totalBytes: 24,
        }),
      ),
    );
    await expect(requestFolderArchiveManifest("root")).rejects.toThrow(
      "manifest is invalid",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          rootId: "root",
          entries: [entry("root", "root", "folder", "outside")],
          totalBytes: 0,
        }),
      ),
    );
    await expect(requestFolderArchiveManifest("root")).rejects.toThrow(
      "manifest is invalid",
    );
  });

  it("rejects manifests without an immutable content version", async () => {
    const { contentVersion: _contentVersion, ...unversioned } = entry(
      "child",
      "child.txt",
      "file",
      "root",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          rootId: "root",
          entries: [unversioned],
          totalBytes: 12,
        }),
      ),
    );

    await expect(requestFolderArchiveManifest("root")).rejects.toThrow(
      "manifest is invalid",
    );
  });

  it("keeps the folder action and archive code split behind a dynamic import", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../vault/vault-file-list.tsx"),
      "utf8",
    );

    expect(source).toContain('"Download ZIP"');
    expect(source).toMatch(
      /import\(\s*"@\/features\/files\/folder-archive"\s*\)/u,
    );
    expect(source).toContain("folderDownloadAbortRef.current?.abort()");
    expect(source).toContain("VAULT_LOCKING_EVENT");
    expect(source).toContain("activeDownloadIdRef");
    expect(source).toContain("isUnlocked:");
    const archiveSource = readFileSync(
      resolve(import.meta.dirname, "folder-archive.ts"),
      "utf8",
    );
    expect(archiveSource).toContain("entry.contentVersion");
    expect(archiveSource).toContain("createStreamingZipDestination");
    expect(archiveSource).toContain("readEncryptedFileStream");
    expect(archiveSource).not.toContain("downloadedFiles");
    expect(archiveSource).not.toContain("new Map<string, VaultDownloadPlan>");
  });
});
