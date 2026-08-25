import {
  claimArchivePath,
  createStreamingZipDestination,
  normalizeArchiveSegment,
  parseArchiveTimestamp,
  triggerBlobDownload,
} from "@/features/archive/browser-archive";
import { archiveCompressionLevel } from "@/features/archive/compression-policy";
import { createAnimationFrameProgressCoalescer } from "@/features/uploads/progress-coalescer";
import { readEncryptedFileStream } from "@/features/vault/encrypted-download";
import {
  toBase64Url,
  type VaultDownloadPlan,
  type VaultManifest,
} from "@/features/vault/protocol";
import { getVaultDownloadPlan } from "@/features/vault/vault-api";
import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type {
  FolderArchiveEntry,
  FolderArchiveManifest,
  RepositoryEntry,
} from "@/lib/api";

const MAX_FOLDER_ARCHIVE_ENTRIES = 50_000;
const MAX_FOLDER_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

export type FolderArchiveProgress = {
  label: string;
  percentage: number | null;
};

export type FolderArchiveRoot = {
  id: string;
  name: string;
  entryType: "folder";
  e2eeState: "legacy" | "staged" | "encrypted";
  updatedAt: string;
};

type VaultArchiveAccess = {
  state: string;
  client: VaultCryptoClient | null;
  requestUnlock(): void;
  openNode(
    nodeId: string,
    plan?: VaultDownloadPlan,
    signal?: AbortSignal,
  ): Promise<VaultManifest>;
  isUnlocked(): boolean;
};

export async function downloadFolderArchive({
  folder,
  vault,
  signal,
  onProgress,
}: {
  folder: FolderArchiveRoot;
  vault: VaultArchiveAccess;
  signal?: AbortSignal;
  onProgress?(progress: FolderArchiveProgress): void;
}): Promise<void> {
  throwIfAborted(signal);
  const progress = onProgress
    ? createAnimationFrameProgressCoalescer(onProgress)
    : null;
  const reportProgress = (value: FolderArchiveProgress, immediate = false) =>
    progress?.publish(value, immediate);
  reportProgress({ label: "Reading folder tree…", percentage: null }, true);
  const archiveManifest = await requestFolderArchiveManifest(folder.id, signal);
  const encryptedEntries = archiveManifest.entries.filter(
    (entry) => entry.e2eeState === "encrypted",
  );
  const needsVault =
    folder.e2eeState === "encrypted" || encryptedEntries.length > 0;
  if (needsVault && vault.state !== "unlocked") {
    vault.requestUnlock();
    throw new Error("Unlock the vault, then choose Download ZIP again.");
  }
  if (needsVault && !vault.client) {
    throw new Error("The encrypted vault is not ready yet.");
  }

  const entriesById = new Map(
    archiveManifest.entries.map((entry) => [entry.id, entry]),
  );
  const namesById = new Map<string, string>();
  let rootName = folder.name;
  let decryptedNames = 0;
  let completedFiles = 0;
  let completedBytes = 0;
  const totalFiles = archiveManifest.entries.filter(
    (entry) => entry.entryType === "file",
  ).length;
  const totalEncryptedNames =
    encryptedEntries.length + (folder.e2eeState === "encrypted" ? 1 : 0);

  if (folder.e2eeState === "encrypted") {
    throwIfAborted(signal);
    const rootPlan = await getVaultDownloadPlan(folder.id, signal);
    const rootManifest = await vault.openNode(folder.id, rootPlan, signal);
    throwIfAborted(signal);
    if (rootManifest.entryType !== "folder") {
      throw new Error("The encrypted folder metadata is inconsistent.");
    }
    rootName = rootManifest.name;
    decryptedNames += 1;
    reportNameProgress(reportProgress, decryptedNames, totalEncryptedNames);
  }

  for (const entry of archiveManifest.entries) {
    if (entry.e2eeState !== "encrypted") namesById.set(entry.id, entry.name);
  }

  const archiveRoot = normalizeArchiveSegment(rootName);
  const claimedPaths = new Set<string>();
  claimArchivePath(claimedPaths, archiveRoot);
  const destination = await createStreamingZipDestination({
    totalSourceBytes: archiveManifest.totalBytes,
  });

  try {
    await destination.zipWriter.add(`${archiveRoot}/`, undefined, {
      directory: true,
      lastModDate: new Date(parseArchiveTimestamp(folder.updatedAt)),
      signal,
    });
    for (const entry of archiveManifest.entries) {
      throwIfAborted(signal);
      let encrypted:
        | { manifest: VaultManifest; plan: VaultDownloadPlan }
        | undefined;
      if (entry.e2eeState === "encrypted") {
        // Parent keys can be required to open children, so archive entries stay
        // in the bounded parent-first order returned by the server.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const plan = await getVaultDownloadPlan(entry.id, signal);
        const manifest = await vault.openNode(entry.id, plan, signal);
        throwIfAborted(signal);
        if (
          manifest.entryType !== entry.entryType ||
          manifest.parentId !== entry.parentId
        ) {
          throw new Error("The encrypted folder tree is inconsistent.");
        }
        namesById.set(entry.id, manifest.name);
        decryptedNames += 1;
        reportNameProgress(reportProgress, decryptedNames, totalEncryptedNames);
        encrypted = { manifest, plan };
      }

      const path = buildFolderArchivePath({
        entry,
        entriesById,
        namesById,
        rootFolderId: folder.id,
        archiveRoot,
      });
      claimArchivePath(claimedPaths, path);
      if (entry.entryType === "folder") {
        // ZIP entries must be serialized into one output stream.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await destination.zipWriter.add(`${path}/`, undefined, {
          directory: true,
          lastModDate: new Date(parseArchiveTimestamp(entry.updatedAt)),
          signal,
        });
        continue;
      }

      const resolvedName = namesById.get(entry.id) ?? "folder file";
      reportProgress({
        label: `Archiving ${resolvedName}…`,
        percentage: archivePercentage(
          completedBytes,
          archiveManifest.totalBytes,
        ),
      });
      const source = encrypted
        ? readEncryptedArchiveFileStream({
            entry,
            ...encrypted,
            client: vault.client,
            signal,
          })
        : await readLegacyArchiveFileStream(entry, resolvedName, signal);
      // A ZIP writer has one ordered output stream, so entries are consumed
      // sequentially while each source remains backpressured.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await destination.zipWriter.add(path, source, {
        level: archiveCompressionLevel({
          path,
          mimeType: encrypted?.manifest.mimeType ?? entry.mimeType,
        }),
        lastModDate: new Date(parseArchiveTimestamp(entry.updatedAt)),
        signal,
        onprogress(processedBytes) {
          reportProgress({
            label: `Archiving ${resolvedName}…`,
            percentage: archivePercentage(
              completedBytes + processedBytes,
              archiveManifest.totalBytes,
            ),
          });
        },
      });
      completedBytes += entry.sizeBytes;
      completedFiles += 1;
      reportProgress({
        label: `Archived ${completedFiles} of ${totalFiles} files…`,
        percentage: archivePercentage(
          completedBytes,
          archiveManifest.totalBytes,
        ),
      });
    }

    throwIfAborted(signal);
    const archive = await destination.close();
    throwIfAborted(signal);
    if (needsVault && !vault.isUnlocked()) {
      throw new DOMException(
        "The vault locked before the ZIP download completed.",
        "AbortError",
      );
    }
    triggerBlobDownload(archive, `${archiveRoot}.zip`, () =>
      destination.release(),
    );
    reportProgress({ label: "ZIP download ready", percentage: 100 }, true);
  } catch (error) {
    await destination.discard(error);
    throw error;
  } finally {
    progress?.cancel();
  }
}

export async function requestFolderArchiveManifest(
  folderId: string,
  signal?: AbortSignal,
): Promise<FolderArchiveManifest> {
  const response = await fetch(
    `/api/files/${encodeURIComponent(folderId)}/archive-manifest`,
    { signal, cache: "no-store" },
  );
  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new Error(
      message || `Folder ZIP preparation failed (${response.status}).`,
    );
  }
  const value = (await response.json()) as Partial<FolderArchiveManifest>;
  if (
    value.rootId !== folderId ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_FOLDER_ARCHIVE_ENTRIES ||
    !value.entries.every(isArchiveEntry) ||
    new Set(value.entries.map((entry) => entry.id)).size !==
      value.entries.length ||
    value.entries.some((entry) => entry.id === folderId) ||
    !Number.isSafeInteger(value.totalBytes) ||
    (value.totalBytes ?? -1) < 0 ||
    (value.totalBytes ?? 0) > MAX_FOLDER_ARCHIVE_BYTES ||
    value.entries
      .filter((entry) => entry.entryType === "file")
      .reduce((total, entry) => total + entry.sizeBytes, 0) !== value.totalBytes
  ) {
    throw new Error("The folder archive manifest is invalid.");
  }
  return value as FolderArchiveManifest;
}

export function buildFolderArchivePath({
  entry,
  entriesById,
  namesById,
  rootFolderId,
  archiveRoot,
}: {
  entry: FolderArchiveEntry;
  entriesById: Map<string, RepositoryEntry>;
  namesById: Map<string, string>;
  rootFolderId: string;
  archiveRoot: string;
}): string {
  const segments: string[] = [];
  const visited = new Set<string>();
  let current: RepositoryEntry | undefined = entry;

  while (current) {
    if (visited.has(current.id)) {
      throw new Error("The folder tree contains a cycle.");
    }
    visited.add(current.id);
    segments.unshift(
      normalizeArchiveSegment(namesById.get(current.id) ?? current.name),
    );
    if (current.parentId === rootFolderId) {
      return [archiveRoot, ...segments].join("/");
    }
    if (!current.parentId) break;
    current = entriesById.get(current.parentId);
  }

  throw new Error("A folder entry is outside the selected folder.");
}

async function readLegacyArchiveFileStream(
  entry: FolderArchiveEntry,
  resolvedName: string,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(
    `/api/files/${encodeURIComponent(entry.id)}/download?version=${encodeURIComponent(entry.contentVersion)}`,
    { signal, cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(`Could not download ${resolvedName} (${response.status}).`);
  }
  if (!response.body) {
    throw new Error(`Could not stream ${resolvedName}.`);
  }
  return requireExactStreamLength(
    response.body,
    entry.sizeBytes,
    `The downloaded size of ${resolvedName} changed.`,
  );
}

function readEncryptedArchiveFileStream({
  entry,
  manifest,
  plan,
  client,
  signal,
}: {
  entry: FolderArchiveEntry;
  manifest: VaultManifest | undefined;
  plan: VaultDownloadPlan | undefined;
  client: VaultCryptoClient | null;
  signal?: AbortSignal;
}): ReadableStream<Uint8Array> {
  if (!manifest || !plan || !client) {
    throw new Error("The encrypted folder is not unlocked.");
  }
  if (
    plan.nodeId !== entry.id ||
    plan.generationId !== toBase64Url(manifest.generationId) ||
    plan.generationId !== entry.vaultGenerationId ||
    plan.recordHash !== entry.vaultRecordHash
  ) {
    throw new Error("The encrypted folder changed during ZIP preparation.");
  }
  return requireExactStreamLength(
    readEncryptedFileStream({ plan, manifest, client, signal }),
    manifest.plaintextBytes,
    `The downloaded size of ${manifest.name} changed.`,
  );
}

function requireExactStreamLength(
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
  errorMessage: string,
): ReadableStream<Uint8Array> {
  let receivedBytes = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > expectedBytes) throw new Error(errorMessage);
        controller.enqueue(chunk);
      },
      flush() {
        if (receivedBytes !== expectedBytes) throw new Error(errorMessage);
      },
    }),
  );
}

function archivePercentage(processedBytes: number, totalBytes: number): number {
  if (totalBytes === 0) return 99;
  return Math.min(99, 20 + (processedBytes / totalBytes) * 79);
}

function reportNameProgress(
  onProgress: ((progress: FolderArchiveProgress) => void) | undefined,
  completed: number,
  total: number,
): void {
  onProgress?.({
    label: `Decrypting ${completed} of ${total} names…`,
    percentage: total ? (completed / total) * 20 : 20,
  });
}

function isArchiveEntry(value: unknown): value is FolderArchiveEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<FolderArchiveEntry>;
  return (
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    typeof entry.name === "string" &&
    (typeof entry.mimeType === "string" || entry.mimeType === null) &&
    (entry.entryType === "file" || entry.entryType === "folder") &&
    typeof entry.parentId === "string" &&
    Number.isSafeInteger(entry.sizeBytes) &&
    (entry.sizeBytes ?? -1) >= 0 &&
    (entry.e2eeState === "legacy" ||
      entry.e2eeState === "staged" ||
      entry.e2eeState === "encrypted") &&
    typeof entry.updatedAt === "string" &&
    typeof entry.contentVersion === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(
      entry.contentVersion,
    ) &&
    (typeof entry.vaultGenerationId === "string" ||
      entry.vaultGenerationId === null) &&
    (typeof entry.vaultRecordHash === "string" ||
      entry.vaultRecordHash === null) &&
    (entry.e2eeState !== "encrypted" ||
      (typeof entry.vaultGenerationId === "string" &&
        entry.vaultGenerationId.length > 0 &&
        typeof entry.vaultRecordHash === "string" &&
        entry.vaultRecordHash.length > 0))
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw (
    signal.reason ??
    new DOMException("The folder download was canceled.", "AbortError")
  );
}
