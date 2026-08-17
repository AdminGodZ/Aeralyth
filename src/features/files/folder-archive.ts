import {
  claimArchivePath,
  createBrowserZip,
  normalizeArchiveSegment,
  parseArchiveTimestamp,
  triggerBlobDownload,
} from "@/features/archive/browser-archive";
import type { FolderZipSource } from "@/features/dashboard/folder-zip-messages";
import { mapWithConcurrency } from "@/features/vault/bounded-async";
import { readEncryptedFileBlob } from "@/features/vault/encrypted-download";
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

const FILE_DOWNLOAD_CONCURRENCY = 4;
const MAX_FOLDER_ARCHIVE_ENTRIES = 50_000;
const MAX_FOLDER_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_FOLDER_ARCHIVE_OUTPUT_BYTES = 160 * 1024 * 1024;

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
  onProgress?.({ label: "Reading folder tree…", percentage: null });
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
  const downloadedFiles = new Map<string, File>();
  let encryptedDownloadBatch: Array<{
    entry: FolderArchiveEntry;
    manifest: VaultManifest;
    plan: VaultDownloadPlan;
  }> = [];
  let rootName = folder.name;
  let decryptedNames = 0;
  let completedFiles = 0;
  const totalFiles = archiveManifest.entries.filter(
    (entry) => entry.entryType === "file",
  ).length;
  const totalEncryptedNames =
    encryptedEntries.length + (folder.e2eeState === "encrypted" ? 1 : 0);
  const flushEncryptedDownloads = async () => {
    if (encryptedDownloadBatch.length === 0) return;
    const batch = encryptedDownloadBatch;
    encryptedDownloadBatch = [];
    await mapWithConcurrency(
      batch,
      FILE_DOWNLOAD_CONCURRENCY,
      async ({ entry, manifest, plan }) => {
        throwIfAborted(signal);
        onProgress?.({
          label: `Downloading ${manifest.name}…`,
          percentage: totalEncryptedNames
            ? (decryptedNames / totalEncryptedNames) * 20
            : 20,
        });
        const file = await readEncryptedArchiveFile({
          entry,
          manifest,
          plan,
          client: vault.client,
          signal,
        });
        if (file.size !== manifest.plaintextBytes) {
          throw new Error(`The downloaded size of ${manifest.name} changed.`);
        }
        downloadedFiles.set(entry.id, file);
        completedFiles += 1;
      },
    );
  };

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
    reportNameProgress(onProgress, decryptedNames, totalEncryptedNames);
  }

  for (const entry of archiveManifest.entries) {
    if (entry.e2eeState !== "encrypted") namesById.set(entry.id, entry.name);
  }
  for (const entry of encryptedEntries) {
    throwIfAborted(signal);
    // Parent keys can be required to open children, so metadata resolution is
    // intentionally parent-first. The server returns this bounded order.
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
    reportNameProgress(onProgress, decryptedNames, totalEncryptedNames);
    if (entry.entryType === "file") {
      encryptedDownloadBatch.push({ entry, manifest, plan });
      if (encryptedDownloadBatch.length >= FILE_DOWNLOAD_CONCURRENCY) {
        // Keep plan/wrapper metadata bounded while preserving four-way file I/O.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await flushEncryptedDownloads();
      }
    }
  }
  await flushEncryptedDownloads();

  const archiveRoot = normalizeArchiveSegment(rootName);
  const sources: FolderZipSource[] = [
    {
      directory: true,
      lastModified: parseArchiveTimestamp(folder.updatedAt),
      path: archiveRoot,
    },
  ];
  const files: Array<{ entry: FolderArchiveEntry; path: string }> = [];
  const claimedPaths = new Set<string>();
  claimArchivePath(claimedPaths, archiveRoot);

  for (const entry of archiveManifest.entries) {
    const path = buildFolderArchivePath({
      entry,
      entriesById,
      namesById,
      rootFolderId: folder.id,
      archiveRoot,
    });
    claimArchivePath(claimedPaths, path);
    if (entry.entryType === "folder") {
      sources.push({
        directory: true,
        lastModified: parseArchiveTimestamp(entry.updatedAt),
        path,
      });
    } else {
      files.push({ entry, path });
    }
  }

  await mapWithConcurrency(
    files.filter(({ entry }) => entry.e2eeState !== "encrypted"),
    FILE_DOWNLOAD_CONCURRENCY,
    async ({ entry }) => {
      throwIfAborted(signal);
      const fileName = namesById.get(entry.id) ?? "folder file";
      onProgress?.({
        label: `Downloading ${fileName}…`,
        percentage: totalFiles ? 20 + (completedFiles / totalFiles) * 55 : 75,
      });
      const file = await readLegacyArchiveFile(entry, fileName, signal);
      if (file.size !== entry.sizeBytes) {
        throw new Error(`The downloaded size of ${fileName} changed.`);
      }
      downloadedFiles.set(entry.id, file);
      completedFiles += 1;
      onProgress?.({
        label: `Downloaded ${completedFiles} of ${totalFiles} files…`,
        percentage: totalFiles ? 20 + (completedFiles / totalFiles) * 55 : 75,
      });
    },
  );
  for (const { entry, path } of files) {
    const file = downloadedFiles.get(entry.id);
    if (!file) throw new Error("A folder file was not downloaded.");
    sources.push({ file, path });
  }
  downloadedFiles.clear();

  throwIfAborted(signal);
  const archive = await createBrowserZip({
    sources,
    signal,
    workerName: "aeralyth-folder-zip",
    errorMessage: "The folder ZIP archive could not be created.",
    maxOutputBytes: MAX_FOLDER_ARCHIVE_OUTPUT_BYTES,
    onProgress: (progress) => {
      const compressionPercentage = progress.totalBytes
        ? (progress.processedBytes / progress.totalBytes) * 25
        : 25;
      onProgress?.({
        label: progress.currentPath
          ? `Compressing ${progress.currentPath}`
          : "Compressing folder…",
        percentage: Math.min(99, 75 + compressionPercentage),
      });
    },
  });
  throwIfAborted(signal);
  if (archive.size > MAX_FOLDER_ARCHIVE_OUTPUT_BYTES) {
    throw new Error("The ZIP archive exceeds the 160 MB browser safety limit.");
  }
  if (needsVault && !vault.isUnlocked()) {
    throw new DOMException(
      "The vault locked before the ZIP download completed.",
      "AbortError",
    );
  }
  triggerBlobDownload(archive, `${archiveRoot}.zip`);
  onProgress?.({ label: "ZIP download ready", percentage: 100 });
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

async function readLegacyArchiveFile(
  entry: FolderArchiveEntry,
  resolvedName: string,
  signal?: AbortSignal,
): Promise<File> {
  const response = await fetch(
    `/api/files/${encodeURIComponent(entry.id)}/download?version=${encodeURIComponent(entry.contentVersion)}`,
    { signal, cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(`Could not download ${resolvedName} (${response.status}).`);
  }
  const blob = await response.blob();
  return new File([blob], normalizeArchiveSegment(resolvedName), {
    type: blob.type || entry.mimeType || "application/octet-stream",
    lastModified: parseArchiveTimestamp(entry.updatedAt),
  });
}

async function readEncryptedArchiveFile({
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
}): Promise<File> {
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
  const blob = await readEncryptedFileBlob({
    plan,
    manifest,
    client,
    signal,
  });
  return new File([blob], normalizeArchiveSegment(manifest.name), {
    type: manifest.mimeType ?? "application/octet-stream",
    lastModified: manifest.lastModified,
  });
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
