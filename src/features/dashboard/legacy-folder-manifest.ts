import { normalizeUploadPath } from "@/features/dashboard/folder-upload-conflicts";

export type LegacyFolderManifest = {
  parentIds: Array<string | null>;
  rootFolderId: string | null;
};

export const LEGACY_FOLDER_MANIFEST_BATCH_SIZE = 1000;

export function needsLegacyFolderManifest(relativePaths: readonly string[]) {
  return relativePaths.some((path) => normalizeUploadPath(path).includes("/"));
}

export async function resolveLegacyFolderManifest(
  relativePaths: readonly string[],
  requestBatch: (
    batchRelativePaths: readonly string[],
  ) => Promise<LegacyFolderManifest>,
): Promise<LegacyFolderManifest> {
  const parentIds: Array<string | null> = [];
  let rootFolderId: string | null = null;

  for (
    let start = 0;
    start < relativePaths.length;
    start += LEGACY_FOLDER_MANIFEST_BATCH_SIZE
  ) {
    const batchRelativePaths = relativePaths.slice(
      start,
      start + LEGACY_FOLDER_MANIFEST_BATCH_SIZE,
    );
    // Batches intentionally settle in order because the backend admits one
    // recursive manifest operation per user. Parallel requests self-shed.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const response = await requestBatch(batchRelativePaths);
    const manifest = validateLegacyFolderManifest(
      response,
      batchRelativePaths.length,
    );
    parentIds.push(...manifest.parentIds);
    rootFolderId ??= manifest.rootFolderId;
  }

  return { parentIds, rootFolderId };
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
