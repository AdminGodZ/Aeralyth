import {
  archivePercentage,
  readEncryptedArchiveFileStream,
  readLegacyArchiveFileStream,
} from "@/features/archive/archive-file-streams";
import {
  claimArchivePath,
  createStreamingZipDestination,
  normalizeArchiveSegment,
  parseArchiveTimestamp,
  triggerBlobDownload,
} from "@/features/archive/browser-archive";
import { archiveCompressionLevel } from "@/features/archive/compression-policy";
import { createAnimationFrameProgressCoalescer } from "@/features/uploads/progress-coalescer";
import type {
  VaultDownloadPlan,
  VaultManifest,
} from "@/features/vault/protocol";
import { getVaultDownloadPlan } from "@/features/vault/vault-api";
import type { VaultCryptoClient } from "@/features/vault/vault-client";
import { throwIfAborted } from "@/lib/abort";
import type {
  RepositoryArchiveEntry,
  RepositoryArchiveManifest,
  RepositoryArchiveManifestPage,
  RepositoryEntry,
  RepositorySummary,
} from "@/lib/api";

const ABORT_MESSAGE = "The repository download was canceled.";

const MAX_REPOSITORY_ARCHIVE_ENTRIES = 50_000;
const MAX_REPOSITORY_ARCHIVE_PAGE_ENTRIES = 1_000;
const MAX_REPOSITORY_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

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
  throwIfAborted(signal, ABORT_MESSAGE);
  const progress = onProgress
    ? createAnimationFrameProgressCoalescer(onProgress)
    : null;
  const reportProgress = (
    value: RepositoryArchiveProgress,
    immediate = false,
  ) => progress?.publish(value, immediate);
  reportProgress({ label: "Reading repository tree…", percentage: null }, true);
  let manifestPage = await requestRepositoryArchiveManifestPage(
    repository.id,
    signal,
  );
  const manifestSummary = manifestPage;
  const namesById = new Map<string, string>([
    [repository.root.id, repositoryName],
  ]);
  const pathsById = new Map<string, string>();
  const needsVault = manifestSummary.totalEncryptedEntries > 0;
  let completedFiles = 0;
  let completedEntries = 0;
  let completedBytes = 0;
  const seenEntryIds = new Set<string>();
  const totalFiles = manifestSummary.totalFiles;
  let decryptedNames = 0;

  if (needsVault && vault.state !== "unlocked") {
    vault.requestUnlock();
    throw new Error("Unlock the vault, then choose Download ZIP again.");
  }
  if (needsVault && !vault.client) {
    throw new Error("The encrypted vault is not ready yet.");
  }

  const archiveRoot = `${normalizeArchiveSegment(repositoryName)}-${normalizeArchiveSegment(repository.defaultBranch)}`;
  const claimedPaths = new Set<string>();
  claimArchivePath(claimedPaths, archiveRoot);
  const destination = await createStreamingZipDestination({
    totalSourceBytes: manifestSummary.totalBytes,
  });

  try {
    await destination.zipWriter.add(`${archiveRoot}/`, undefined, {
      directory: true,
      lastModDate: new Date(parseArchiveTimestamp(repository.updatedAt)),
      signal,
    });
    while (true) {
      for (const entry of manifestPage.entries) {
        throwIfAborted(signal, ABORT_MESSAGE);
        if (seenEntryIds.has(entry.id)) {
          throw new Error(
            "The repository archive manifest contains duplicate entries.",
          );
        }
        seenEntryIds.add(entry.id);
        completedEntries += 1;
        if (entry.e2eeState !== "encrypted") {
          namesById.set(entry.id, entry.name);
        }
        let encrypted:
          | { manifest: VaultManifest; plan: VaultDownloadPlan }
          | undefined;
        if (entry.e2eeState === "encrypted") {
          // Parent keys can be required to open children, so pages and entries
          // remain in the stable parent-first order returned by the server.
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          const plan = await getVaultDownloadPlan(entry.id, signal);
          const vaultManifest = await vault.openNode(entry.id, plan, signal);
          throwIfAborted(signal, ABORT_MESSAGE);
          if (
            vaultManifest.entryType !== entry.entryType ||
            vaultManifest.parentId !== entry.parentId
          ) {
            throw new Error(
              "The encrypted repository metadata is inconsistent.",
            );
          }
          namesById.set(entry.id, vaultManifest.name);
          decryptedNames += 1;
          reportProgress({
            label: `Decrypting ${decryptedNames} of ${manifestSummary.totalEncryptedEntries} names…`,
            percentage: manifestSummary.totalEncryptedEntries
              ? (decryptedNames / manifestSummary.totalEncryptedEntries) * 20
              : 20,
          });
          encrypted = { manifest: vaultManifest, plan };
        }

        const path = buildArchivePath({
          entry,
          pathsById,
          namesById,
          rootFolderId: repository.root.id,
          archiveRoot,
        });
        pathsById.set(entry.id, path);
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

        const resolvedName = namesById.get(entry.id) ?? "repository file";
        reportProgress({
          label: `Archiving ${resolvedName}…`,
          percentage: archivePercentage(
            completedBytes,
            manifestSummary.totalBytes,
          ),
        });
        const source = encrypted
          ? readEncryptedArchiveFileStream({
              entry,
              ...encrypted,
              client: vault.client,
              signal,
              subject: "repository",
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
                manifestSummary.totalBytes,
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
            manifestSummary.totalBytes,
          ),
        });
      }

      if (!manifestPage.hasMore || !manifestPage.nextCursor) break;
      // Fetch only the next bounded page after the current page has been
      // consumed, avoiding a second whole-tree manifest allocation while the
      // path indexes retain only the strings required by later descendants.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      manifestPage = await requestRepositoryArchiveManifestPage(
        repository.id,
        signal,
        manifestPage.nextCursor,
      );
      requireMatchingManifestPage(manifestSummary, manifestPage);
    }

    if (
      completedEntries !== manifestSummary.totalEntries ||
      completedFiles !== manifestSummary.totalFiles ||
      completedBytes !== manifestSummary.totalBytes
    ) {
      throw new Error("The repository archive manifest is incomplete.");
    }
    throwIfAborted(signal, ABORT_MESSAGE);
    const archive = await destination.close();
    throwIfAborted(signal, ABORT_MESSAGE);
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

export async function requestRepositoryArchiveManifest(
  repositoryId: string,
  signal?: AbortSignal,
): Promise<RepositoryArchiveManifest> {
  let page = await requestRepositoryArchiveManifestPage(repositoryId, signal);
  const summary = page;
  const entries: RepositoryArchiveEntry[] = [];
  const seenIds = new Set<string>();

  while (true) {
    for (const entry of page.entries) {
      if (seenIds.has(entry.id)) {
        throw new Error("The repository archive manifest is invalid.");
      }
      seenIds.add(entry.id);
      entries.push(entry);
    }
    if (!page.hasMore || !page.nextCursor) break;
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    page = await requestRepositoryArchiveManifestPage(
      repositoryId,
      signal,
      page.nextCursor,
    );
    requireMatchingManifestPage(summary, page);
  }

  if (
    entries.length !== summary.totalEntries ||
    entries.filter((entry) => entry.entryType === "file").length !==
      summary.totalFiles ||
    entries
      .filter((entry) => entry.entryType === "file")
      .reduce((total, entry) => total + entry.sizeBytes, 0) !==
      summary.totalBytes
  ) {
    throw new Error("The repository archive manifest is invalid.");
  }

  return {
    repository: summary.repository,
    entries,
    totalBytes: summary.totalBytes,
  };
}

export async function requestRepositoryArchiveManifestPage(
  repositoryId: string,
  signal?: AbortSignal,
  cursor?: string,
): Promise<RepositoryArchiveManifestPage> {
  const query = cursor ? `?${new URLSearchParams({ cursor }).toString()}` : "";
  const response = await fetch(
    `/api/repositories/${encodeURIComponent(repositoryId)}/archive-manifest${query}`,
    { signal, cache: "no-cache" },
  );
  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new Error(
      message || `Repository ZIP preparation failed (${response.status}).`,
    );
  }
  const value =
    (await response.json()) as Partial<RepositoryArchiveManifestPage>;
  if (
    !value.repository ||
    value.repository.id !== repositoryId ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_REPOSITORY_ARCHIVE_PAGE_ENTRIES ||
    !value.entries.every(isRepositoryArchiveEntry) ||
    new Set(value.entries.map((entry) => entry.id)).size !==
      value.entries.length ||
    !Number.isSafeInteger(value.snapshotVersion) ||
    (value.snapshotVersion ?? -1) < 0 ||
    !Number.isSafeInteger(value.totalEntries) ||
    (value.totalEntries ?? -1) < 0 ||
    (value.totalEntries ?? 0) > MAX_REPOSITORY_ARCHIVE_ENTRIES ||
    !Number.isSafeInteger(value.totalFiles) ||
    (value.totalFiles ?? -1) < 0 ||
    (value.totalFiles ?? 0) > (value.totalEntries ?? -1) ||
    !Number.isSafeInteger(value.totalEncryptedEntries) ||
    (value.totalEncryptedEntries ?? -1) < 0 ||
    (value.totalEncryptedEntries ?? 0) > (value.totalEntries ?? -1) ||
    !Number.isSafeInteger(value.totalBytes) ||
    (value.totalBytes ?? -1) < 0 ||
    (value.totalBytes ?? 0) > MAX_REPOSITORY_ARCHIVE_BYTES ||
    typeof value.hasMore !== "boolean" ||
    (value.hasMore
      ? typeof value.nextCursor !== "string" || !value.nextCursor
      : value.nextCursor !== null)
  ) {
    throw new Error("The repository archive manifest is invalid.");
  }
  return value as RepositoryArchiveManifestPage;
}

function requireMatchingManifestPage(
  first: RepositoryArchiveManifestPage,
  next: RepositoryArchiveManifestPage,
): void {
  if (
    next.repository.id !== first.repository.id ||
    next.snapshotVersion !== first.snapshotVersion ||
    next.totalEntries !== first.totalEntries ||
    next.totalFiles !== first.totalFiles ||
    next.totalBytes !== first.totalBytes ||
    next.totalEncryptedEntries !== first.totalEncryptedEntries
  ) {
    throw new Error("The repository changed during ZIP preparation.");
  }
}

export function buildArchivePath({
  entry,
  pathsById,
  namesById,
  rootFolderId,
  archiveRoot,
}: {
  entry: RepositoryEntry;
  pathsById: Map<string, string>;
  namesById: Map<string, string>;
  rootFolderId: string;
  archiveRoot: string;
}): string {
  const segment = normalizeArchiveSegment(
    namesById.get(entry.id) ?? entry.name,
  );
  if (entry.parentId === rootFolderId) {
    return `${archiveRoot}/${segment}`;
  }
  const parentPath = entry.parentId ? pathsById.get(entry.parentId) : null;
  if (parentPath) return `${parentPath}/${segment}`;

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
