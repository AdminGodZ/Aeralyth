import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  buildArchivePath,
  normalizeArchiveSegment,
  requestRepositoryArchiveManifest,
} from "@/features/repositories/repository-archive";
import type {
  RepositoryArchiveEntry,
  RepositoryEntry,
  RepositorySummary,
} from "@/lib/api";

function entry(
  id: string,
  name: string,
  entryType: "file" | "folder",
  parentId: string,
): RepositoryEntry {
  return {
    id,
    name,
    mimeType: entryType === "file" ? "text/plain" : null,
    entryType,
    parentId,
    sizeBytes: entryType === "file" ? 12 : 0,
    e2eeState: "legacy",
    updatedAt: "2026-08-10T00:00:00Z",
    vaultGenerationId: null,
    vaultRecordVersion: null,
    vaultRecordHash: null,
  };
}

describe("repository archive paths", () => {
  it("builds a GitHub-style archive path from the repository root", () => {
    const source = entry("folder", "src", "folder", "root");
    const file = entry("file", "index.ts", "file", source.id);
    const namesById = new Map([
      [source.id, source.name],
      [file.id, file.name],
    ]);
    const pathsById = new Map<string, string>();

    const sourcePath = buildArchivePath({
      entry: source,
      pathsById,
      namesById,
      rootFolderId: "root",
      archiveRoot: "aeralyth-main",
    });
    pathsById.set(source.id, sourcePath);
    const filePath = buildArchivePath({
      entry: file,
      pathsById,
      namesById,
      rootFolderId: "root",
      archiveRoot: "aeralyth-main",
    });

    expect(filePath).toBe("aeralyth-main/src/index.ts");
  });

  it("rejects entries whose parent chain leaves the repository", () => {
    const file = entry("file", "index.ts", "file", "outside");

    expect(() =>
      buildArchivePath({
        entry: file,
        pathsById: new Map(),
        namesById: new Map([[file.id, file.name]]),
        rootFolderId: "root",
        archiveRoot: "aeralyth-main",
      }),
    ).toThrow("outside the repository root");
  });

  it("memoizes a 50,000-entry parent-first tree with one parent lookup each", () => {
    const branchCount = 500;
    const depth = 100;
    const pathsById = new Map<string, string>();
    const namesById = new Map<string, string>();
    let parentLookups = 0;
    const originalGet = pathsById.get.bind(pathsById);
    pathsById.get = (id) => {
      parentLookups += 1;
      return originalGet(id);
    };

    for (let level = 0; level < depth; level += 1) {
      for (let branch = 0; branch < branchCount; branch += 1) {
        const id = `branch-${branch}-level-${level}`;
        const parentId =
          level === 0 ? "root" : `branch-${branch}-level-${level - 1}`;
        const node = entry(id, `level-${level}`, "folder", parentId);
        const path = buildArchivePath({
          entry: node,
          pathsById,
          namesById,
          rootFolderId: "root",
          archiveRoot: "project-main",
        });
        pathsById.set(id, path);
      }
    }

    expect(pathsById).toHaveLength(50_000);
    expect(parentLookups).toBe(49_500);
    expect(pathsById.get("branch-499-level-99")?.split("/")).toHaveLength(101);
  });

  it("sanitizes unsafe archive path characters", () => {
    expect(normalizeArchiveSegment('../bad\\name:*?"<>|. ')).toBe(
      ".._bad_name_______",
    );
    expect(normalizeArchiveSegment("..")).toBe("unnamed");
  });

  it("loads archive metadata through bounded snapshot pages", async () => {
    const folder = {
      ...entry("folder", "src", "folder", "root"),
      contentVersion: "2026-08-10T00:00:00.000001Z",
    } satisfies RepositoryArchiveEntry;
    const file = {
      ...entry("file", "index.ts", "file", folder.id),
      contentVersion: "2026-08-10T00:00:00.000002Z",
    } satisfies RepositoryArchiveEntry;
    const repository = {
      id: "repository",
      ownerUsername: "admin",
      defaultBranch: "main",
      description: null,
      root: {
        id: "root",
        name: "project",
        e2eeState: "legacy",
        updatedAt: "2026-08-10T00:00:00Z",
        vaultGenerationId: null,
        vaultRecordVersion: null,
        vaultRecordHash: null,
      },
      createdAt: "2026-08-10T00:00:00Z",
      updatedAt: "2026-08-10T00:00:00Z",
    } satisfies RepositorySummary;
    const page = {
      repository,
      snapshotVersion: 7,
      totalEntries: 2,
      totalFiles: 1,
      totalBytes: 12,
      totalEncryptedEntries: 0,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          ...page,
          entries: [folder],
          nextCursor: "cursor-2",
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ...page,
          entries: [file],
          nextCursor: null,
          hasMore: false,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const manifest = await requestRepositoryArchiveManifest(repository.id);

      expect(manifest.entries).toEqual([folder, file]);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "/api/repositories/repository/archive-manifest",
        { signal: undefined, cache: "no-cache" },
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "/api/repositories/repository/archive-manifest?cursor=cursor-2",
        { signal: undefined, cache: "no-cache" },
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cancels encrypted archive work synchronously when the vault locks", () => {
    const menuSource = readFileSync(
      resolve(import.meta.dirname, "repository-code-menu.tsx"),
      "utf8",
    );
    const archiveSource = readFileSync(
      resolve(import.meta.dirname, "repository-archive.ts"),
      "utf8",
    );

    expect(menuSource).toContain("VAULT_LOCKING_EVENT");
    expect(menuSource).toContain("archiveAbortRef.current?.abort(");
    expect(menuSource).toContain('vaultStateRef.current = "locked"');
    expect(menuSource).toContain("isUnlocked:");
    expect(archiveSource).toContain("if (needsVault && !vault.isUnlocked())");
    expect(archiveSource).toContain("createStreamingZipDestination");
    expect(archiveSource).toContain("readEncryptedArchiveFileStream");
    expect(archiveSource).not.toContain("downloadedFiles");
    const streamSource = readFileSync(
      resolve(import.meta.dirname, "../archive/archive-file-streams.ts"),
      "utf8",
    );
    expect(streamSource).toContain("readEncryptedFileStream");
    expect(streamSource).toContain("plan.recordHash !== entry.vaultRecordHash");
    expect(archiveSource).not.toContain("new Map<string, VaultDownloadPlan>");
  });
});
