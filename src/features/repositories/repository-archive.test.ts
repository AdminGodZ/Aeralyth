import { describe, expect, it } from "vitest";

import {
  buildArchivePath,
  normalizeArchiveSegment,
} from "@/features/repositories/repository-archive";
import type { RepositoryEntry } from "@/lib/api";

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
  };
}

describe("repository archive paths", () => {
  it("builds a GitHub-style archive path from the repository root", () => {
    const source = entry("folder", "src", "folder", "root");
    const file = entry("file", "index.ts", "file", source.id);
    const entriesById = new Map([
      [source.id, source],
      [file.id, file],
    ]);
    const namesById = new Map([
      [source.id, source.name],
      [file.id, file.name],
    ]);

    expect(
      buildArchivePath({
        entry: file,
        entriesById,
        namesById,
        rootFolderId: "root",
        archiveRoot: "aeralyth-main",
      }),
    ).toBe("aeralyth-main/src/index.ts");
  });

  it("rejects entries whose parent chain leaves the repository", () => {
    const file = entry("file", "index.ts", "file", "outside");

    expect(() =>
      buildArchivePath({
        entry: file,
        entriesById: new Map([[file.id, file]]),
        namesById: new Map([[file.id, file.name]]),
        rootFolderId: "root",
        archiveRoot: "aeralyth-main",
      }),
    ).toThrow("outside the repository root");
  });

  it("sanitizes unsafe archive path characters", () => {
    expect(normalizeArchiveSegment('../bad\\name:*?"<>|. ')).toBe(
      ".._bad_name_______",
    );
    expect(normalizeArchiveSegment("..")).toBe("unnamed");
  });
});
