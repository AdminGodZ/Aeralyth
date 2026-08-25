import { describe, expect, it, vi } from "vitest";

import {
  folderUploadCreatesRepository,
  resolveFolderUploadConflicts,
  UPLOAD_PATH_LOOKUP_CONCURRENCY,
  UPLOAD_TREE_REQUEST_CONCURRENCY,
  type UploadTreeEntry,
} from "@/features/dashboard/folder-upload-conflicts";

function entry(
  id: string,
  name: string,
  entryType: "file" | "folder",
): UploadTreeEntry {
  return { id, name, entryType, e2eeState: "encrypted" };
}

describe("resolveFolderUploadConflicts", () => {
  it("stops traversal when the selected root folder does not exist", async () => {
    const loadChildren = vi.fn(async () => []);

    const resolution = await resolveFolderUploadConflicts({
      relativePaths: ["project/src/main.ts", "project/README.md"],
      parentFolderId: null,
      loadChildren,
    });

    expect(resolution.existingFolders.size).toBe(0);
    expect(resolution.replacementFiles.size).toBe(0);
    expect(loadChildren).toHaveBeenCalledOnce();
    expect(loadChildren).toHaveBeenCalledWith(null);
  });

  it("finds same-path files while leaving new and omitted files alone", async () => {
    const children = new Map<string, UploadTreeEntry[]>([
      ["root", [entry("folder-project", "project", "folder")]],
      [
        "folder-project",
        [
          entry("folder-src", "src", "folder"),
          entry("file-readme", "README.md", "file"),
          entry("file-omitted", "keep.txt", "file"),
        ],
      ],
      ["folder-src", [entry("file-main", "main.ts", "file")]],
    ]);

    const resolution = await resolveFolderUploadConflicts({
      relativePaths: [
        "project/src/main.ts",
        "project/README.md",
        "project/new.txt",
      ],
      parentFolderId: "root",
      loadChildren: async (parentId) => children.get(parentId ?? "") ?? [],
    });

    expect(Array.from(resolution.existingFolders.keys())).toEqual([
      "project",
      "project/src",
    ]);
    expect(resolution.conflictPaths).toEqual([
      "project/README.md",
      "project/src/main.ts",
    ]);
    expect(resolution.replacementFiles.has("project/new.txt")).toBe(false);
    expect(
      Array.from(resolution.replacementFiles.values(), ({ id }) => id).sort(),
    ).toEqual(["file-main", "file-readme"]);
  });

  it("matches existing paths case-insensitively", async () => {
    const resolution = await resolveFolderUploadConflicts({
      relativePaths: ["Project/README.md"],
      parentFolderId: null,
      loadChildren: async (parentId) =>
        parentId === null
          ? [entry("folder-project", "project", "folder")]
          : [entry("file-readme", "readme.MD", "file")],
    });

    expect(resolution.replacementFiles.get("Project/README.md")?.id).toBe(
      "file-readme",
    );
  });

  it("rejects file and folder type collisions", async () => {
    await expect(
      resolveFolderUploadConflicts({
        relativePaths: ["project/main.ts"],
        parentFolderId: null,
        loadChildren: async () => [entry("file-project", "project", "file")],
      }),
    ).rejects.toThrow("already exists as a different item type");
  });

  it("rejects ambiguous existing duplicate names", async () => {
    await expect(
      resolveFolderUploadConflicts({
        relativePaths: ["project/main.ts"],
        parentFolderId: null,
        loadChildren: async () => [
          entry("folder-one", "project", "folder"),
          entry("folder-two", "Project", "folder"),
        ],
      }),
    ).rejects.toThrow("More than one existing item matches");
  });

  it("serializes lookups for large existing folder trees", async () => {
    const projectCount = UPLOAD_PATH_LOOKUP_CONCURRENCY * 3;
    const projects = Array.from({ length: projectCount }, (_, index) =>
      entry(`project-${String(index)}`, `project-${String(index)}`, "folder"),
    );
    let activeLoads = 0;
    let maximumActiveLoads = 0;

    const resolution = await resolveFolderUploadConflicts({
      relativePaths: projects.map(
        (_, index) => `project-${String(index)}/src/main.ts`,
      ),
      parentFolderId: null,
      loadChildren: async (parentId) => {
        activeLoads += 1;
        maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeLoads -= 1;

        if (parentId === null) return projects;
        if (parentId.startsWith("project-")) {
          return [entry(`src-for-${parentId}`, "src", "folder")];
        }
        return [];
      },
    });

    expect(resolution.existingFolders.size).toBe(projectCount * 2);
    expect(maximumActiveLoads).toBe(UPLOAD_TREE_REQUEST_CONCURRENCY);
  });
});

describe("folderUploadCreatesRepository", () => {
  it("keeps folders uploaded from Files in regular file storage", () => {
    expect(folderUploadCreatesRepository("files")).toBe(false);
    expect(folderUploadCreatesRepository("shared")).toBe(false);
  });

  it("creates repositories only from the Repositories surface", () => {
    expect(folderUploadCreatesRepository("repositories")).toBe(true);
  });
});
