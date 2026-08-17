import type { FileEntry } from "@/lib/api";

export function removeEncryptedSelections(
  selectedIds: Set<string>,
  entries: readonly Pick<FileEntry, "id" | "e2eeState">[],
): Set<string> {
  const encryptedIds = new Set<string>();
  for (const entry of entries) {
    if (entry.e2eeState === "encrypted") encryptedIds.add(entry.id);
  }

  let next: Set<string> | null = null;
  for (const entryId of selectedIds) {
    if (!encryptedIds.has(entryId)) continue;
    next ??= new Set(selectedIds);
    next.delete(entryId);
  }
  return next ?? selectedIds;
}
