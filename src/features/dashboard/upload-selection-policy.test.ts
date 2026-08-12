import { describe, expect, it } from "vitest";

import {
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

  it("applies .gitignore before counting a project folder", async () => {
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
    expect(prepared.ignoredFiles).toBe(MAX_SELECTION_FILES + 2);
    expect(prepared.error).toBeNull();
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
