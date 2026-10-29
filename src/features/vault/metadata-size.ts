import type { VaultCachedMetadataResult } from "@/features/vault/vault-messages";

/** Approximate in-memory size of a cached metadata entry, for cache budgets. */
export function estimateMetadataBytes(
  result: VaultCachedMetadataResult,
): number {
  const manifest = result.manifest;
  return (
    256 +
    result.nodeId.length * 2 +
    result.recordHash.length * 2 +
    manifest.name.length * 2 +
    (manifest.mimeType?.length ?? 0) * 2 +
    (manifest.parentId?.length ?? 0) * 2 +
    manifest.generationId.byteLength
  );
}
