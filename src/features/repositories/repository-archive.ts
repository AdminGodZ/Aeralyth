import type {
  FolderZipSource,
  FolderZipWorkerResponse,
} from "@/features/dashboard/folder-zip-messages";
import { readEncryptedFileBlob } from "@/features/vault/encrypted-download";
import type { VaultManifest } from "@/features/vault/protocol";
import { getVaultDownloadPlan } from "@/features/vault/vault-api";
import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type {
  RepositoryArchiveManifest,
  RepositoryEntry,
  RepositorySummary,
} from "@/lib/api";

export type RepositoryArchiveProgress = {
  label: string;
  percentage: number | null;
};

type VaultArchiveAccess = {
  state: string;
  client: VaultCryptoClient | null;
  requestUnlock(): void;
  openNode(nodeId: string): Promise<VaultManifest>;
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
  onProgress?.({ label: "Reading repository tree…", percentage: null });
  const manifest = await requestArchiveManifest(repository.id, signal);
  const entriesById = new Map(
    manifest.entries.map((entry) => [entry.id, entry]),
  );
  const namesById = new Map<string, string>([
    [repository.root.id, repositoryName],
  ]);
  const encryptedManifests = new Map<string, VaultManifest>();
  const encryptedEntries = manifest.entries.filter(
    (entry) => entry.e2eeState === "encrypted",
  );

  if (encryptedEntries.length > 0 && vault.state !== "unlocked") {
    vault.requestUnlock();
    throw new Error("Unlock the vault, then choose Download ZIP again.");
  }
  if (encryptedEntries.length > 0 && !vault.client) {
    throw new Error("The encrypted vault is not ready yet.");
  }

  for (const entry of manifest.entries) {
    if (entry.e2eeState !== "encrypted") {
      namesById.set(entry.id, entry.name);
    }
  }
  for (const [index, entry] of encryptedEntries.entries()) {
    // Repository nodes share one vault worker and parent-key cache. Children
    // can require a parent key, so this resolution is intentionally ordered.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const vaultManifest = await vault.openNode(entry.id);
    if (vaultManifest.entryType !== entry.entryType) {
      throw new Error("The encrypted repository metadata is inconsistent.");
    }
    encryptedManifests.set(entry.id, vaultManifest);
    namesById.set(entry.id, vaultManifest.name);
    onProgress?.({
      label: `Decrypting ${index + 1} of ${encryptedEntries.length} names…`,
      percentage: encryptedEntries.length
        ? ((index + 1) / encryptedEntries.length) * 20
        : 20,
    });
  }

  const archiveRoot = `${normalizeArchiveSegment(repositoryName)}-${normalizeArchiveSegment(repository.defaultBranch)}`;
  const sources: FolderZipSource[] = [
    {
      directory: true,
      lastModified: parseTimestamp(repository.updatedAt),
      path: archiveRoot,
    },
  ];
  const files: Array<{ entry: RepositoryEntry; path: string }> = [];
  let completedFiles = 0;

  for (const entry of manifest.entries) {
    const path = buildArchivePath({
      entry,
      entriesById,
      namesById,
      rootFolderId: repository.root.id,
      archiveRoot,
    });
    if (entry.entryType === "folder") {
      sources.push({
        directory: true,
        lastModified: parseTimestamp(entry.updatedAt),
        path,
      });
      continue;
    }
    files.push({ entry, path });
  }

  const fileSources = await mapWithConcurrency(
    files,
    4,
    async ({ entry, path }) => {
      onProgress?.({
        label: `Downloading ${namesById.get(entry.id) ?? "repository file"}…`,
        percentage: files.length
          ? 20 + (completedFiles / files.length) * 55
          : 75,
      });
      const file =
        entry.e2eeState === "encrypted"
          ? await readEncryptedArchiveFile({
              entry,
              manifest: encryptedManifests.get(entry.id),
              client: vault.client,
              signal,
            })
          : await readLegacyArchiveFile(entry, namesById.get(entry.id), signal);
      completedFiles += 1;
      onProgress?.({
        label: `Downloaded ${completedFiles} of ${files.length} files…`,
        percentage: files.length
          ? 20 + (completedFiles / files.length) * 55
          : 75,
      });
      return { file, path } satisfies FolderZipSource;
    },
  );
  sources.push(...fileSources);

  const archive = await createArchive(sources, signal, (progress) => {
    const compressionPercentage = progress.totalBytes
      ? (progress.processedBytes / progress.totalBytes) * 25
      : 25;
    onProgress?.({
      label: progress.currentPath
        ? `Compressing ${progress.currentPath}`
        : "Compressing repository…",
      percentage: Math.min(99, 75 + compressionPercentage),
    });
  });
  triggerBlobDownload(archive, `${archiveRoot}.zip`);
  onProgress?.({ label: "ZIP download ready", percentage: 100 });
}

async function requestArchiveManifest(
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
    !value.entries.every(isRepositoryEntry) ||
    typeof value.totalBytes !== "number"
  ) {
    throw new Error("The repository archive manifest is invalid.");
  }
  return value as RepositoryArchiveManifest;
}

async function readLegacyArchiveFile(
  entry: RepositoryEntry,
  resolvedName: string | undefined,
  signal?: AbortSignal,
): Promise<File> {
  const response = await fetch(
    `/api/files/${encodeURIComponent(entry.id)}/download`,
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
    lastModified: parseTimestamp(entry.updatedAt),
  });
}

async function readEncryptedArchiveFile({
  entry,
  manifest,
  client,
  signal,
}: {
  entry: RepositoryEntry;
  manifest: VaultManifest | undefined;
  client: VaultCryptoClient | null;
  signal?: AbortSignal;
}): Promise<File> {
  if (!manifest || !client) {
    throw new Error("The encrypted repository is not unlocked.");
  }
  const plan = await getVaultDownloadPlan(entry.id, signal);
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

function createArchive(
  sources: FolderZipSource[],
  signal: AbortSignal | undefined,
  onProgress: (
    progress: Extract<FolderZipWorkerResponse, { type: "progress" }>,
  ) => void,
): Promise<Blob> {
  if (typeof Worker === "undefined") {
    return Promise.reject(
      new Error("This browser cannot create ZIP archives in the background."),
    );
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker("/folder-zip.worker.js", {
      type: "module",
      name: "aeralyth-repository-zip",
    });
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      worker.postMessage({ type: "cancel" });
      cleanup();
      reject(new DOMException("The ZIP download was canceled.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.addEventListener(
      "message",
      (event: MessageEvent<FolderZipWorkerResponse>) => {
        if (event.data.type === "progress") {
          onProgress(event.data);
          return;
        }
        cleanup();
        if (event.data.type === "complete") {
          resolve(event.data.archive);
        } else if (event.data.type === "canceled") {
          reject(
            new DOMException("The ZIP download was canceled.", "AbortError"),
          );
        } else {
          reject(new Error(event.data.message));
        }
      },
    );
    worker.addEventListener("error", () => {
      cleanup();
      reject(new Error("The repository ZIP archive could not be created."));
    });
    worker.postMessage({ type: "compress", sources });
  });
}

async function mapWithConcurrency<Input, Output>(
  values: Input[],
  concurrency: number,
  transform: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= values.length) return;
    output[index] = await transform(values[index], index);
    return runNext();
  }

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), values.length) },
      () => runNext(),
    ),
  );
  return output;
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

export function normalizeArchiveSegment(value: string): string {
  const forbidden = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
  const normalized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || forbidden.has(character)
      ? "_"
      : character;
  })
    .join("")
    .trim()
    .replace(/[. ]+$/u, "")
    .slice(0, 180);
  return normalized && normalized !== "." && normalized !== ".."
    ? normalized
    : "unnamed";
}

function isRepositoryEntry(value: unknown): value is RepositoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RepositoryEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    (typeof entry.mimeType === "string" || entry.mimeType === null) &&
    (entry.entryType === "file" || entry.entryType === "folder") &&
    (typeof entry.parentId === "string" || entry.parentId === null) &&
    typeof entry.sizeBytes === "number" &&
    (entry.e2eeState === "legacy" ||
      entry.e2eeState === "staged" ||
      entry.e2eeState === "encrypted") &&
    typeof entry.updatedAt === "string"
  );
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
