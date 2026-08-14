import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  legacyUploadTarget,
  needsLegacyFolderManifest,
  validateLegacyFolderManifest,
} from "@/features/dashboard/legacy-folder-manifest";

describe("legacy folder manifests", () => {
  it("keeps folder uploads on the batch-manifest boundary", () => {
    const uploadPanel = readFileSync(
      resolve(import.meta.dirname, "upload-panel.tsx"),
      "utf8",
    );

    expect(uploadPanel.match(/\/api\/files\/folder-manifests/g)).toHaveLength(
      1,
    );
    expect(uploadPanel).toContain("folderManifest?.parentIds[fileIndex]");
  });

  it("requests a manifest only for paths with folder components", () => {
    expect(needsLegacyFolderManifest(["readme.md"])).toBe(false);
    expect(
      needsLegacyFolderManifest(["project/readme.md", "project/src/app.ts"]),
    ).toBe(true);
  });

  it("sends only the basename after the manifest resolves its parent", () => {
    expect(
      legacyUploadTarget({
        relativePath: "project/src/app.ts",
        fileName: "app.ts",
        baseParentId: null,
        resolvedParentId: "folder-src",
      }),
    ).toEqual({
      relativePath: "app.ts",
      parentId: "folder-src",
    });
  });

  it("preserves the legacy fallback contract for single-file clients", () => {
    expect(
      legacyUploadTarget({
        relativePath: "project/src/app.ts",
        fileName: "app.ts",
        baseParentId: "base-folder",
        resolvedParentId: undefined,
      }),
    ).toEqual({
      relativePath: "project/src/app.ts",
      parentId: "base-folder",
    });
  });

  it("rejects an incomplete parent mapping", () => {
    expect(() =>
      validateLegacyFolderManifest(
        { parentIds: ["folder"], rootFolderId: "folder" },
        2,
      ),
    ).toThrow("incomplete upload manifest");
  });
});
