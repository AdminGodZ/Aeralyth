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
  RepositoryArchiveEntry,
  RepositoryArchiveManifest,
  RepositoryEntry,
  RepositorySummary,
} from "@/lib/api";

const FILE_DOWNLOAD_CONCURRENCY = 4;
const MAX_REPOSITORY_ARCHIVE_ENTRIES = 50_000;
const MAX_REPOSITORY_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_REPOSITORY_ARCHIVE_OUTPUT_BYTES = 160 * 1024 * 1024;

export type RepositoryArchiveProgress = {
  label: string;
  percentage: number | null;
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

export async function downloadRepositoryArchive({
  repository,
  repositoryName,
  vault,
  signal,
  onProgress,
}: {
  repository: RepositorySummary;
  repositoryName: string;
  vault: VaultArchiveAccess;
  signal?: AbortSignal;
  onProgress?(progress: RepositoryArchiveProgress): void;
}): Promise<void> {
  throwIfAborted(signal);
  onProgress?.({ label: "Reading repository tree…", percentage: null });
  const manifest = await requestRepositoryArchiveManifest(
    repository.id,
    signal,
  );
  const entriesById = new Map(
    manifest.entries.map((entry) => [entry.id, entry]),
  );
  const namesById = new Map<string, string>([
    [repository.root.id, repositoryName],
  ]);
  const downloadedFiles = new Map<string, File>();
  let encryptedDownloadBatch: Array<{
    entry: RepositoryArchiveEntry;
    manifest: VaultManifest;
    plan: VaultDownloadPlan;
  }> = [];
  const encryptedEntries = manifest.entries.filter(
    (entry) => entry.e2eeState === "encrypted",
  );
  const needsVault = encryptedEntries.length > 0;
  let completedFiles = 0;
  const totalFiles = manifest.entries.filter(
    (entry) => entry.entryType === "file",
  ).length;
  let decryptedNames = 0;
  const flushEncryptedDownloads = async () => {
    if (encryptedDownloadBatch.length === 0) return;
    const batch = encryptedDownloadBatch;
    encryptedDownloadBatch = [];
    await mapWithConcurrency(
      batch,
      FILE_DOWNLOAD_CONCURRENCY,
      async ({ entry, manifest: vaultManifest, plan }) => {
        throwIfAborted(signal);
        onProgress?.({
          label: `Downloading ${vaultManifest.name}…`,
          percentage: encryptedEntries.length
            ? (decryptedNames / encryptedEntries.length) * 20
            : 20,
        });
        const file = await readEncryptedArchiveFile({
          entry,
          manifest: vaultManifest,
          plan,
          client: vault.client,
          signal,
        });
        if (file.size !== vaultManifest.plaintextBytes) {
          throw new Error(
            `The downloaded size of ${vaultManifest.name} changed.`,
          );
        }
        downloadedFiles.set(entry.id, file);
        completedFiles += 1;
      },
    );
  };

  if (needsVault && vault.state !== "unlocked") {
    vault.requestUnlock();
    throw new Error("Unlock the vault, then choose Download ZIP again.");
  }
  if (needsVault && !vault.client) {
    throw new Error("The encrypted vault is not ready yet.");
  }

  for (const entry of manifest.entries) {
    if (entry.e2eeState !== "encrypted") {
      namesById.set(entry.id, entry.name);
    }
  }
  for (const [index, entry] of encryptedEntries.entries()) {
    throwIfAborted(signal);
    // Repository nodes share one vault worker and parent-key cache. Children
    // can require a parent key, so this resolution is intentionally ordered.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const plan = await getVaultDownloadPlan(entry.id, signal);
    const vaultManifest = await vault.openNode(entry.id, plan, signal);
    throwIfAborted(signal);
    if (
      vaultManifest.entryType !== entry.entryType ||
      vaultManifest.parentId !== entry.parentId
    ) {
      throw new Error("The encrypted repository metadata is inconsistent.");
    }
    namesById.set(entry.id, vaultManifest.name);
    decryptedNames = index + 1;
    onProgress?.({
      label: `Decrypting ${index + 1} of ${encryptedEntries.length} names…`,
      percentage: encryptedEntries.length
        ? ((index + 1) / encryptedEntries.length) * 20
        : 20,
    });
    if (entry.entryType === "file") {
      encryptedDownloadBatch.push({ entry, manifest: vaultManifest, plan });
      if (encryptedDownloadBatch.length >= FILE_DOWNLOAD_CONCURRENCY) {
        // Keep plan/wrapper metadata bounded while preserving four-way file I/O.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await flushEncryptedDownloads();
      }
    }
  }
  await flushEncryptedDownloads();

  const archiveRoot = `${normalizeArchiveSegment(repositoryName)}-${normalizeArchiveSegment(repository.defaultBranch)}`;
  const sources: FolderZipSource[] = [
    {
      directory: true,
      lastModified: parseArchiveTimestamp(repository.updatedAt),
      path: archiveRoot,
    },
  ];
  const claimedPaths = new Set<string>();
  claimArchivePath(claimedPaths, archiveRoot);
  const files: Array<{ entry: RepositoryArchiveEntry; path: string }> = [];

  for (const entry of manifest.entries) {
    const path = buildArchivePath({
      entry,
      entriesById,
      namesById,
      rootFolderId: repository.root.id,
      archiveRoot,
    });
    claimArchivePath(claimedPaths, path);
    if (entry.entryType === "folder") {
      sources.push({
        directory: true,
        lastModified: parseArchiveTimestamp(entry.updatedAt),
        path,
      });
      continue;
    }
    files.push({ entry, path });
  }

  await mapWithConcurrency(
    files.filter(({ entry }) => entry.e2eeState !== "encrypted"),
    FILE_DOWNLOAD_CONCURRENCY,
    async ({ entry }) => {
      throwIfAborted(signal);
      onProgress?.({
        label: `Downloading ${namesById.get(entry.id) ?? "repository file"}…`,
        percentage: totalFiles ? 20 + (completedFiles / totalFiles) * 55 : 75,
      });
      const file = await readLegacyArchiveFile(
        entry,
        namesById.get(entry.id),
        signal,
      );
      if (file.size !== entry.sizeBytes) {
        throw new Error(
          `The downloaded size of ${namesById.get(entry.id) ?? "a repository file"} changed.`,
        );
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
    if (!file) throw new Error("A repository file was not downloaded.");
    sources.push({ file, path });
  }
  downloadedFiles.clear();

  throwIfAborted(signal);
  const archive = await createBrowserZip({
    sources,
    signal,
    workerName: "aeralyth-repository-zip",
    errorMessage: "The repository ZIP archive could not be created.",
    maxOutputBytes: MAX_REPOSITORY_ARCHIVE_OUTPUT_BYTES,
    onProgress: (progress) => {
      const compressionPercentage = progress.totalBytes
        ? (progress.processedBytes / progress.totalBytes) * 25
        : 25;
      onProgress?.({
        label: progress.currentPath
          ? `Compressing ${progress.currentPath}`
          : "Compressing repository…",
        percentage: Math.min(99, 75 + compressionPercentage),
      });
    },
  });
  throwIfAborted(signal);
  if (archive.size > MAX_REPOSITORY_ARCHIVE_OUTPUT_BYTES) {
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

export async function requestRepositoryArchiveManifest(
  repositoryId: string,
  signal?: AbortSignal,
): Promise<RepositoryArchiveManifest> {
  const response = await fetch(
    `/api/repositories/${encodeURIComponent(repositoryId)}/archive-manifest`,
    { signal, cache: "no-store" },
  );
  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new Error(
      message || `Repository ZIP preparation failed (${response.status}).`,
    );
  }
  const value = (await response.json()) as Partial<RepositoryArchiveManifest>;
  if (
    !value.repository ||
    value.repository.id !== repositoryId ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_REPOSITORY_ARCHIVE_ENTRIES ||
    !value.entries.every(isRepositoryArchiveEntry) ||
    new Set(value.entries.map((entry) => entry.id)).size !==
      value.entries.length ||
    !Number.isSafeInteger(value.totalBytes) ||
    (value.totalBytes ?? -1) < 0 ||
    (value.totalBytes ?? 0) > MAX_REPOSITORY_ARCHIVE_BYTES ||
    value.entries
      .filter((entry) => entry.entryType === "file")
      .reduce((total, entry) => total + entry.sizeBytes, 0) !== value.totalBytes
  ) {
    throw new Error("The repository archive manifest is invalid.");
  }
  return value as RepositoryArchiveManifest;
}

async function readLegacyArchiveFile(
  entry: RepositoryArchiveEntry,
  resolvedName: string | undefined,
  signal?: AbortSignal,
): Promise<File> {
  const response = await fetch(
    `/api/files/${encodeURIComponent(entry.id)}/download?version=${encodeURIComponent(entry.contentVersion)}`,
    { signal, cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(
      `Could not download ${resolvedName ?? "a repository file"} (${response.status}).`,
    );
  }
  const blob = await response.blob();
  return new File([blob], normalizeArchiveSegment(resolvedName ?? entry.name), {
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
  entry: RepositoryArchiveEntry;
  manifest: VaultManifest | undefined;
  plan: VaultDownloadPlan | undefined;
  client: VaultCryptoClient | null;
  signal?: AbortSignal;
}): Promise<File> {
  if (!manifest || !plan || !client) {
    throw new Error("The encrypted repository is not unlocked.");
  }
  if (
    plan.nodeId !== entry.id ||
    plan.generationId !== toBase64Url(manifest.generationId) ||
    plan.generationId !== entry.vaultGenerationId ||
    plan.recordHash !== entry.vaultRecordHash
  ) {
    throw new Error("The encrypted repository changed during ZIP preparation.");
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

export function buildArchivePath({
  entry,
  entriesById,
  namesById,
  rootFolderId,
  archiveRoot,
}: {
  entry: RepositoryEntry;
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
      throw new Error("The repository folder tree contains a cycle.");
    }
    visited.add(current.id);
    segments.unshift(
      normalizeArchiveSegment(namesById.get(current.id) ?? current.name),
    );
    if (current.parentId === rootFolderId) {
      return [archiveRoot, ...segments].join("/");
    }
    if (!current.parentId) {
      break;
    }
    current = entriesById.get(current.parentId);
  }

  throw new Error("A repository entry is outside the repository root.");
}

export { normalizeArchiveSegment } from "@/features/archive/browser-archive";

function isRepositoryArchiveEntry(
  value: unknown,
): value is RepositoryArchiveEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RepositoryArchiveEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    (typeof entry.mimeType === "string" || entry.mimeType === null) &&
    (entry.entryType === "file" || entry.entryType === "folder") &&
    (typeof entry.parentId === "string" || entry.parentId === null) &&
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
    new DOMException("The repository download was canceled.", "AbortError")
  );
}
