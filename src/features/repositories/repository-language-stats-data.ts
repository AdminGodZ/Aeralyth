import {
  calculateRepositoryLanguages,
  type RepositoryLanguage,
  type RepositoryLanguageFile,
  type RepositoryLanguageGroup,
} from "@/features/repositories/repository-languages";
import type {
  VaultManifest,
  VaultMetadataReference,
} from "@/features/vault/protocol";
import type { VaultMetadataOpenResult } from "@/features/vault/vault-messages";
import type { VaultMetadataResolutionOptions } from "@/features/vault/vault-metadata-resolver";

// This module must stay free of archive/ZIP imports: it is loaded with the
// repository page, while ZIP creation is loaded only on demand.

/** An entry at or below an encrypted node; only the browser can name it. */
export type RepositoryLanguageEntry = {
  id: string;
  parentId: string | null;
  entryType: "file" | "folder";
  name: string | null;
  sizeBytes: number;
  e2eeState: "legacy" | "staged" | "encrypted";
  vaultGenerationId: string | null;
  vaultRecordVersion: number | null;
  vaultRecordHash: string | null;
};

export type RepositoryLanguageStats = {
  repositoryId: string;
  contentVersion: number;
  languageGroups: RepositoryLanguageGroup[];
  encryptedEntries: RepositoryLanguageEntry[];
};

export type RepositoryLanguageResult =
  | { status: "locked" }
  | { status: "ready"; languages: RepositoryLanguage[] };

export type RepositoryLanguageVault = {
  state: string;
  openNode(
    nodeId: string,
    plan?: undefined,
    signal?: AbortSignal,
  ): Promise<VaultManifest>;
  resolveMetadata(
    references: VaultMetadataReference[],
    options?: VaultMetadataResolutionOptions,
  ): Promise<VaultMetadataOpenResult[]>;
};

type CachedLanguageStats = {
  stats: RepositoryLanguageStats;
  languages: RepositoryLanguage[] | null;
};

// Bounds each resolver call so a large encrypted tree never holds every
// metadata plan at once. Parent-first order lets later batches reuse keys.
const METADATA_RESOLUTION_BATCH_SIZE = 1_000;
const LANGUAGE_STATS_CACHE_LIMIT = 32;
const MAX_LANGUAGE_STATS_ENTRIES = 50_000;

const cache = new Map<string, CachedLanguageStats>();
const flights = new Map<
  string,
  {
    promise: Promise<RepositoryLanguageResult>;
    controller: AbortController;
    consumers: number;
  }
>();

export function languageStatsCacheKey(
  repositoryId: string,
  contentVersion: number,
): string {
  return `${repositoryId}\u0000${contentVersion}`;
}

/**
 * Returns the cached result for a repository revision without any work, or
 * null when it still has to be loaded.
 */
export function peekRepositoryLanguages(
  repositoryId: string,
  contentVersion: number | undefined,
  vaultState: string,
): RepositoryLanguageResult | null {
  if (contentVersion === undefined) return null;
  const cached = cache.get(languageStatsCacheKey(repositoryId, contentVersion));
  if (!cached) return null;
  if (requiresVault(cached.stats) && vaultState !== "unlocked") {
    return { status: "locked" };
  }
  return cached.languages
    ? { status: "ready", languages: cached.languages }
    : null;
}

/**
 * Loads the language breakdown once per repository revision. Concurrent
 * callers share one request; the work is canceled when every caller leaves.
 */
export function loadRepositoryLanguages({
  repositoryId,
  contentVersion,
  vault,
  signal,
}: {
  repositoryId: string;
  contentVersion?: number;
  vault: RepositoryLanguageVault;
  signal: AbortSignal;
}): Promise<RepositoryLanguageResult> {
  const cached = peekRepositoryLanguages(
    repositoryId,
    contentVersion,
    vault.state,
  );
  if (cached) return Promise.resolve(cached);

  const flightKey = `${repositoryId}\u0000${contentVersion ?? "latest"}\u0000${vault.state}`;
  let flight = flights.get(flightKey);
  if (!flight) {
    const controller = new AbortController();
    const promise = computeRepositoryLanguages(
      repositoryId,
      contentVersion,
      vault,
      controller.signal,
    );
    const current = { promise, controller, consumers: 0 };
    flight = current;
    flights.set(flightKey, current);
    const clear = () => {
      if (flights.get(flightKey) === current) flights.delete(flightKey);
    };
    void promise.then(clear, clear);
  }
  const active = flight;
  active.consumers += 1;

  return new Promise<RepositoryLanguageResult>((resolve, reject) => {
    const leave = () => {
      signal.removeEventListener("abort", abort);
      active.consumers -= 1;
      if (active.consumers === 0 && flights.get(flightKey) === active) {
        flights.delete(flightKey);
        active.controller.abort();
      }
    };
    const abort = () => {
      leave();
      reject(
        new DOMException("The language analysis was canceled.", "AbortError"),
      );
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    active.promise.then(
      (value) => {
        if (signal.aborted) return;
        signal.removeEventListener("abort", abort);
        active.consumers -= 1;
        resolve(value);
      },
      (failure: unknown) => {
        if (signal.aborted) return;
        signal.removeEventListener("abort", abort);
        active.consumers -= 1;
        reject(failure);
      },
    );
  });
}

/** Drops results derived from decrypted names, e.g. when the vault locks. */
export function forgetVaultDerivedLanguages(): void {
  for (const [key, cached] of cache) {
    if (requiresVault(cached.stats))
      cache.set(key, { ...cached, languages: null });
  }
}

export function clearRepositoryLanguageCache(): void {
  cache.clear();
  for (const flight of flights.values()) flight.controller.abort();
  flights.clear();
}

async function computeRepositoryLanguages(
  repositoryId: string,
  contentVersion: number | undefined,
  vault: RepositoryLanguageVault,
  signal: AbortSignal,
): Promise<RepositoryLanguageResult> {
  const known =
    contentVersion === undefined
      ? undefined
      : cache.get(languageStatsCacheKey(repositoryId, contentVersion));
  const stats =
    known?.stats ??
    (await requestRepositoryLanguageStats(repositoryId, signal));
  const key = languageStatsCacheKey(stats.repositoryId, stats.contentVersion);
  remember(key, { stats, languages: cache.get(key)?.languages ?? null });

  const needsVault = requiresVault(stats);
  if (needsVault && vault.state !== "unlocked") return { status: "locked" };

  const files = needsVault
    ? await resolveEncryptedLanguageFiles(stats.encryptedEntries, vault, signal)
    : readableLanguageFiles(stats.encryptedEntries);
  const languages = calculateRepositoryLanguages(files, stats.languageGroups);
  if (!signal.aborted) remember(key, { stats, languages });
  return { status: "ready", languages };
}

export async function requestRepositoryLanguageStats(
  repositoryId: string,
  signal?: AbortSignal,
): Promise<RepositoryLanguageStats> {
  // no-cache revalidates with the ETag, so an unchanged tree costs a 304
  // and no subtree walk on the server.
  const response = await fetch(
    `/api/repositories/${encodeURIComponent(repositoryId)}/language-stats`,
    { signal, cache: "no-cache" },
  );
  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new Error(
      message ||
        `Repository languages could not be calculated (${response.status}).`,
    );
  }
  const value = (await response.json()) as Partial<RepositoryLanguageStats>;
  if (
    value.repositoryId !== repositoryId ||
    !Number.isSafeInteger(value.contentVersion) ||
    !Array.isArray(value.languageGroups) ||
    !value.languageGroups.every(isLanguageGroup) ||
    !Array.isArray(value.encryptedEntries) ||
    value.encryptedEntries.length > MAX_LANGUAGE_STATS_ENTRIES ||
    !value.encryptedEntries.every(isLanguageEntry)
  ) {
    throw new Error("The repository language statistics are invalid.");
  }
  return value as RepositoryLanguageStats;
}

/**
 * Resolves encrypted names in batches through the vault metadata resolver
 * (one metadata-plan request per 100 nodes, cache hits need none) instead
 * of one download-plan request per node.
 */
export async function resolveEncryptedLanguageFiles(
  entries: RepositoryLanguageEntry[],
  vault: RepositoryLanguageVault,
  signal: AbortSignal,
): Promise<RepositoryLanguageFile[]> {
  const names = new Map<string, string>();
  const sizes = new Map<string, number>();
  const references: VaultMetadataReference[] = [];
  const unreferenced: RepositoryLanguageEntry[] = [];
  const entriesById = new Map<string, RepositoryLanguageEntry>();

  for (const entry of entries) {
    entriesById.set(entry.id, entry);
    if (entry.e2eeState !== "encrypted") {
      names.set(entry.id, entry.name ?? "");
      continue;
    }
    if (
      entry.vaultGenerationId === null ||
      entry.vaultRecordVersion === null ||
      entry.vaultRecordHash === null
    ) {
      unreferenced.push(entry);
      continue;
    }
    references.push({
      nodeId: entry.id,
      parentId: entry.parentId,
      recordVersion: entry.vaultRecordVersion,
      recordHash: entry.vaultRecordHash,
      generationId: entry.vaultGenerationId,
    });
  }

  const accept = (entry: RepositoryLanguageEntry, manifest: VaultManifest) => {
    if (manifest.entryType !== entry.entryType) {
      throw new Error("The encrypted repository metadata is inconsistent.");
    }
    names.set(entry.id, manifest.name);
    sizes.set(entry.id, manifest.plaintextBytes);
  };

  for (
    let offset = 0;
    offset < references.length;
    offset += METADATA_RESOLUTION_BATCH_SIZE
  ) {
    // Batches stay sequential so parents resolve before their children.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const results = await vault.resolveMetadata(
      references.slice(offset, offset + METADATA_RESOLUTION_BATCH_SIZE),
      { signal },
    );
    for (const result of results) {
      const entry = entriesById.get(result.nodeId);
      if (!entry || result.recordHash !== entry.vaultRecordHash) continue;
      if (result.status !== "ready") {
        throw new Error(
          "The encrypted repository metadata could not be decrypted.",
        );
      }
      accept(entry, result.manifest);
    }
  }
  for (const entry of unreferenced) {
    // Without a published record reference the batched path cannot verify
    // the revision, so these rare nodes keep the per-node open.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    accept(entry, await vault.openNode(entry.id, undefined, signal));
  }
  for (const entry of entries) {
    if (entry.e2eeState === "encrypted" && !names.has(entry.id)) {
      throw new Error(
        "The encrypted repository metadata could not be decrypted.",
      );
    }
  }

  return languageFiles(entries, entriesById, names, sizes);
}

function readableLanguageFiles(
  entries: RepositoryLanguageEntry[],
): RepositoryLanguageFile[] {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const names = new Map(entries.map((entry) => [entry.id, entry.name ?? ""]));
  return languageFiles(entries, entriesById, names, new Map());
}

function languageFiles(
  entries: RepositoryLanguageEntry[],
  entriesById: Map<string, RepositoryLanguageEntry>,
  names: Map<string, string>,
  sizes: Map<string, number>,
): RepositoryLanguageFile[] {
  const files: RepositoryLanguageFile[] = [];
  for (const entry of entries) {
    if (entry.entryType !== "file") continue;
    files.push({
      name: names.get(entry.id) ?? "",
      path: buildLanguagePath(entry, entriesById, names),
      sizeBytes: sizes.get(entry.id) ?? entry.sizeBytes,
    });
  }
  return files;
}

// The server already applied the directory rules to every readable segment
// above the topmost encrypted node, so the walk stops where entries end.
function buildLanguagePath(
  entry: RepositoryLanguageEntry,
  entriesById: Map<string, RepositoryLanguageEntry>,
  names: Map<string, string>,
): string {
  const segments: string[] = [];
  const visited = new Set<string>();
  let current: RepositoryLanguageEntry | undefined = entry;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    segments.unshift(names.get(current.id) ?? "");
    current = current.parentId ? entriesById.get(current.parentId) : undefined;
  }
  return segments.join("/");
}

function requiresVault(stats: RepositoryLanguageStats): boolean {
  return stats.encryptedEntries.some(
    (entry) => entry.e2eeState === "encrypted",
  );
}

function remember(key: string, value: CachedLanguageStats): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > LANGUAGE_STATS_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function isLanguageGroup(value: unknown): value is RepositoryLanguageGroup {
  if (!value || typeof value !== "object") return false;
  const group = value as Partial<RepositoryLanguageGroup>;
  return (
    (group.kind === "extension" || group.kind === "filename") &&
    typeof group.key === "string" &&
    Number.isSafeInteger(group.files) &&
    (group.files ?? -1) >= 0 &&
    Number.isSafeInteger(group.bytes) &&
    (group.bytes ?? -1) >= 0
  );
}

function isLanguageEntry(value: unknown): value is RepositoryLanguageEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RepositoryLanguageEntry>;
  return (
    typeof entry.id === "string" &&
    (typeof entry.parentId === "string" || entry.parentId === null) &&
    (entry.entryType === "file" || entry.entryType === "folder") &&
    (entry.e2eeState === "legacy" ||
      entry.e2eeState === "staged" ||
      entry.e2eeState === "encrypted") &&
    (entry.e2eeState === "encrypted"
      ? entry.name === null
      : typeof entry.name === "string") &&
    Number.isSafeInteger(entry.sizeBytes) &&
    (entry.sizeBytes ?? -1) >= 0 &&
    (typeof entry.vaultGenerationId === "string" ||
      entry.vaultGenerationId === null) &&
    (Number.isSafeInteger(entry.vaultRecordVersion) ||
      entry.vaultRecordVersion === null) &&
    (typeof entry.vaultRecordHash === "string" ||
      entry.vaultRecordHash === null)
  );
}
