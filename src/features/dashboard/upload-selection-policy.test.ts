import { describe, expect, it } from "vitest";

import {
  finalizeFolderUploadSelection,
  getUploadSelectionCountError,
  getUploadSelectionError,
  MAX_SELECTION_FILES,
  MAX_UPLOAD_BYTES,
  prepareFolderUploadSelection,
} from "@/features/dashboard/upload-selection-policy";

describe("upload selection policy", () => {
  it("enforces the safety cap against the effective upload set", () => {
    expect(getUploadSelectionCountError(MAX_SELECTION_FILES, false)).toBeNull();
    expect(getUploadSelectionCountError(MAX_SELECTION_FILES + 1, false)).toBe(
      "Choose no more than 1,000 files at once.",
    );
  });

  it("prepares .gitignore defaults without losing the files they exclude", async () => {
    const selections = [
      {
        file: new File(["node_modules/\ndist/\n"], ".gitignore"),
        relativePath: "admingod/.gitignore",
      },
      {
        file: new File(["{}"], "package.json"),
        relativePath: "admingod/package.json",
      },
      ...Array.from({ length: MAX_SELECTION_FILES + 1 }, (_, index) => ({
        file: new File(["dependency"], `module-${String(index)}.js`),
        relativePath: `admingod/node_modules/module-${String(index)}.js`,
      })),
      {
        file: new File(["output"], "index.js"),
        relativePath: "admingod/dist/index.js",
      },
    ];

    const prepared = await prepareFolderUploadSelection(selections);

    expect(selections.length).toBeGreaterThan(MAX_SELECTION_FILES);
    expect(prepared.files.map(({ relativePath }) => relativePath)).toEqual([
      "admingod/.gitignore",
      "admingod/package.json",
    ]);
    expect(prepared.uploadableFiles).toHaveLength(selections.length);
    expect(prepared.gitIgnoredFiles).toHaveLength(MAX_SELECTION_FILES + 2);
    expect(
      prepared.gitIgnoreItems.map(({ kind, path, files }) => ({
        kind,
        path,
        fileCount: files.length,
      })),
    ).toEqual([
      { kind: "folder", path: "dist", fileCount: 1 },
      {
        kind: "folder",
        path: "node_modules",
        fileCount: MAX_SELECTION_FILES + 1,
      },
    ]);
    expect(prepared.gitMetadataFiles).toBe(0);
    expect(prepared.gitIgnoreFileCount).toBe(1);
    expect(prepared.error).toBeNull();
  });

  it("keeps an explicitly selected .env file while Git metadata stays excluded", async () => {
    const selections = [
      {
        file: new File([".env\n"], ".gitignore"),
        relativePath: "demo/.gitignore",
      },
      {
        file: new File(["{}"], "package.json"),
        relativePath: "demo/package.json",
      },
      {
        file: new File(["TOKEN=secret"], ".env"),
        relativePath: "demo/.env",
      },
      {
        file: new File(["ref: refs/heads/main"], "HEAD"),
        relativePath: "demo/.git/HEAD",
      },
    ];
    const prepared = await prepareFolderUploadSelection(selections);
    const envFile = selections[2];
    if (!envFile) throw new Error("Missing .env test fixture.");

    const finalized = finalizeFolderUploadSelection(prepared, [envFile]);

    expect(finalized.files.map(({ relativePath }) => relativePath)).toEqual([
      "demo/.gitignore",
      "demo/package.json",
      "demo/.env",
    ]);
    expect(finalized.ignoredFiles).toBe(1);
    expect(finalized.error).toBeNull();
  });

  it("groups wholly ignored folders while leaving ignored files in mixed folders separate", async () => {
    const selections = [
      {
        file: new File(["node_modules/\n*.generated.ts\n"], ".gitignore"),
        relativePath: "demo/.gitignore",
      },
      {
        file: new File(["source"], "app.ts"),
        relativePath: "demo/src/app.ts",
      },
      {
        file: new File(["generated"], "types.generated.ts"),
        relativePath: "demo/src/types.generated.ts",
      },
      {
        file: new File(["dependency"], "index.js"),
        relativePath: "demo/node_modules/pkg/index.js",
      },
      {
        file: new File(["metadata"], "package.json"),
        relativePath: "demo/node_modules/pkg/package.json",
      },
    ];

    const prepared = await prepareFolderUploadSelection(selections);

    expect(
      prepared.gitIgnoreItems.map(({ kind, path, files }) => ({
        kind,
        path,
        fileCount: files.length,
      })),
    ).toEqual([
      { kind: "folder", path: "node_modules", fileCount: 2 },
      { kind: "file", path: "src/types.generated.ts", fileCount: 1 },
    ]);
  });

  it("validates the files chosen in the .gitignore review", async () => {
    const selections = [
      {
        file: new File(["generated/\n"], ".gitignore"),
        relativePath: "demo/.gitignore",
      },
      ...Array.from({ length: MAX_SELECTION_FILES }, (_, index) => ({
        file: new File(["output"], `file-${String(index)}.js`),
        relativePath: `demo/generated/file-${String(index)}.js`,
      })),
    ];
    const prepared = await prepareFolderUploadSelection(selections);
    const finalized = finalizeFolderUploadSelection(
      prepared,
      prepared.gitIgnoredFiles,
    );

    expect(finalized.error).toBe("Choose no more than 1,000 files at once.");
  });

  it("still requires exactly one file for a shared-file replacement", () => {
    expect(getUploadSelectionCountError(2, true)).toBe(
      "Choose exactly one file to replace the shared file.",
    );
  });

  it("rejects an oversized file before any upload starts", () => {
    expect(
      getUploadSelectionError(
        [
          { file: { name: "small.bin", size: 1 } },
          { file: { name: "large.bin", size: MAX_UPLOAD_BYTES + 1 } },
        ],
        false,
      ),
    ).toBe("large.bin exceeds the 2 GB upload limit.");
  });
});
