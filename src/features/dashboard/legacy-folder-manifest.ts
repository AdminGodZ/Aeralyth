import { normalizeUploadPath } from "@/features/dashboard/folder-upload-conflicts";

export type LegacyFolderManifest = {
  parentIds: Array<string | null>;
  rootFolderId: string | null;
};

export function needsLegacyFolderManifest(relativePaths: readonly string[]) {
  return relativePaths.some((path) => normalizeUploadPath(path).includes("/"));
}

export function validateLegacyFolderManifest(
  manifest: LegacyFolderManifest,
  expectedFiles: number,
): LegacyFolderManifest {
  if (manifest.parentIds.length !== expectedFiles) {
    throw new Error(
      "The folder service returned an incomplete upload manifest.",
    );
  }
  return manifest;
}

export function legacyUploadTarget({
  relativePath,
  fileName,
  baseParentId,
  resolvedParentId,
}: {
  relativePath: string;
  fileName: string;
  baseParentId: string | null;
  resolvedParentId: string | null | undefined;
}) {
  if (resolvedParentId === undefined) {
    return {
      relativePath,
      parentId: baseParentId,
    };
  }

  return {
    relativePath: fileName,
    parentId: resolvedParentId,
  };
}
