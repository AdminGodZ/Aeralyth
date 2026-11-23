import { ONE_PASSWORD_AUTH_VERSION } from "@/features/auth/account-password";
import { getAccountAuthInfo, loginAccount } from "@/features/auth/auth-api";
import type {
  VaultDownloadPlan,
  VaultManifest,
  VaultMetadataPlan,
  VaultMetadataReference,
} from "@/features/vault/protocol";
import {
  getUnlockMaterial,
  getVaultDownloadPlan,
  VaultApiError,
} from "@/features/vault/vault-api";
import {
  VaultCryptoClient,
  VaultWorkerError,
  type VaultWorkerPort,
} from "@/features/vault/vault-client";
import { VaultMetadataResolver } from "@/features/vault/vault-metadata-resolver";
import type { FileEntry, FolderBreadcrumb } from "@/lib/api";

/** A file or folder as the tools present it, with its decrypted name. */
export type VaultEntry = {
  id: string;
  name: string;
  type: "file" | "folder";
  parentId: string | null;
  /** Plaintext bytes for files; null for folders. */
  size: number | null;
  mimeType: string | null;
  createdAt: string;
  updatedAt: string;
  state: "active" | "trashed";
  shared: boolean;
  owner: string | null;
  encrypted: boolean;
  /** Set when the name could not be decrypted. */
  unreadable?: string;
  /** The listing's identity for this revision, used to resolve replacements. */
  record: {
    version: number;
    hash: string;
    generationId: string;
  } | null;
};

export type FolderListing = {
  folderId: string | null;
  /** "/" for the root; null when the listing is not a folder view. */
  path: string | null;
  entries: VaultEntry[];
  truncated: boolean;
};

export type ListView = "files" | "shared" | "trash" | "recent" | "favorites";

export type SessionConfig = {
  username: string;
  password(): Promise<string>;
  startWorker(): VaultWorkerPort;
  log(message: string): void;
};

type Connection = {
  client: VaultCryptoClient;
  csrfToken: string;
  username: string;
  signedInAt: number;
};

type FilesPage = {
  entries: FileEntry[];
  currentFolderId: string | null;
  breadcrumbs: FolderBreadcrumb[];
  nextCursor: string | null;
  hasMore: boolean;
  metadataPlans?: VaultMetadataPlan[];
};

const PAGE_SIZE = 100;
const DEFAULT_MAX_ENTRIES = 2_000;
// Sessions signed in with "remember" last 30 days; sign in again well before.
const SESSION_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const API_RETRY_ATTEMPTS = 4;

export class AeralythSession {
  private readonly resolver = new VaultMetadataResolver();
  private readonly nodeOpenFlights = new Map<string, Promise<VaultManifest>>();
  private client: VaultCryptoClient | null = null;
  private connection: Connection | null = null;
  private connecting: Promise<Connection> | null = null;
  private unlocked = false;
  private sessionExpired = false;

  constructor(private readonly config: SessionConfig) {}

  /** Called by the API fetch for every response; a 401 ends the session. */
  noteApiResponse(status: number, path: string): void {
    if (status === 401 && !path.startsWith("/api/auth/")) {
      this.sessionExpired = true;
    }
  }

  /** Signs in and unlocks the vault once; later calls reuse the session. */
  async connect(): Promise<Connection> {
    const current = this.connection;
    if (
      current &&
      this.unlocked &&
      !this.sessionExpired &&
      Date.now() - current.signedInAt < SESSION_REFRESH_MS
    ) {
      return current;
    }
    this.connecting ??= this.establish().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * Runs one operation against a ready session. Reads are repeated once when
   * the API session ran out underneath them; writes report it instead, since
   * part of the write may already have landed.
   */
  async run<T>(
    operation: (connection: Connection) => Promise<T>,
    { repeatable }: { repeatable: boolean },
  ): Promise<T> {
    const connection = await this.connect();
    try {
      return await operation(connection);
    } catch (failure) {
      const expired =
        failure instanceof VaultApiError && failure.status === 401;
      if (!expired && !this.sessionExpired) throw failure;
      this.sessionExpired = true;
      if (!repeatable) {
        throw new Error(
          "The Aeralyth session expired during this change, so it may be incomplete. Check the folder, then retry what is missing.",
        );
      }
      return operation(await this.connect());
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connection = null;
    this.unlocked = false;
    await client?.close().catch(() => undefined);
  }

  private getClient(): VaultCryptoClient {
    if (this.client) return this.client;
    const client = new VaultCryptoClient((failure) => {
      if (this.client !== client) return;
      this.config.log(`The vault worker stopped: ${failure.message}`);
      this.client = null;
      this.connection = null;
      this.unlocked = false;
      this.resolver.clear();
      this.nodeOpenFlights.clear();
    }, this.config.startWorker);
    this.client = client;
    return client;
  }

  private async establish(): Promise<Connection> {
    const client = this.getClient();
    const password = await this.config.password();
    const username = this.config.username.trim();
    const authInfo = await getAccountAuthInfo(username);
    const credential =
      authInfo.authVersion === ONE_PASSWORD_AUTH_VERSION
        ? await client.deriveAuthCredential(username, password, authInfo.salt)
        : null;
    let login: Awaited<ReturnType<typeof loginAccount>>;
    try {
      login = await loginAccount({
        username,
        ...(credential ? { credential } : { legacyPassword: password }),
        remember: true,
      });
    } catch (failure) {
      throw new Error(
        `Signing in to Aeralyth as “${username}” failed: ${messageOf(failure)}`,
      );
    }
    this.sessionExpired = false;
    if (!login.user.vaultConfigured) {
      throw new Error(
        "This account has no vault yet. Sign in to Aeralyth in a browser once to create it and save the recovery key, then try again.",
      );
    }
    if (!this.unlocked) {
      const material = await getUnlockMaterial();
      try {
        await client.unlock(password, material);
      } catch (failure) {
        if (
          failure instanceof VaultWorkerError &&
          failure.code === "INVALID_PASSWORD"
        ) {
          throw new Error(
            "Signed in, but the vault did not unlock with this password. If the vault still has a separate password, sign in once in the browser to finish moving to one password.",
          );
        }
        throw failure;
      }
      this.unlocked = true;
      this.config.log(`Signed in as ${login.user.username}; vault unlocked.`);
    }
    this.connection = {
      client,
      csrfToken: login.csrfToken,
      username: login.user.username,
      signedInAt: Date.now(),
    };
    return this.connection;
  }

  /** Opens a node's signed record, unlocking ancestors it is wrapped by. */
  openNode(
    connection: Connection,
    nodeId: string,
    plan?: VaultDownloadPlan,
    signal?: AbortSignal,
  ): Promise<VaultManifest> {
    const key = plan ? `${nodeId}:${plan.recordHash}` : nodeId;
    const existing = this.nodeOpenFlights.get(key);
    if (existing) return existing;
    const operation = (async () => {
      const nodePlan = plan ?? (await getVaultDownloadPlan(nodeId, signal));
      let manifest: VaultManifest;
      try {
        manifest = (await connection.client.openPlan(nodePlan)).manifest;
      } catch (failure) {
        const parentId = requiredParentId(failure);
        if (!parentId) throw failure;
        await this.openNode(connection, parentId, undefined, signal);
        manifest = (await connection.client.openPlan(nodePlan)).manifest;
      }
      this.resolver.remember({
        status: "ready",
        nodeId,
        recordHash: nodePlan.recordHash,
        manifest,
      });
      return manifest;
    })();
    this.nodeOpenFlights.set(key, operation);
    const clear = () => {
      if (this.nodeOpenFlights.get(key) === operation) {
        this.nodeOpenFlights.delete(key);
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  /** Lists a folder (or a whole view) with every name decrypted. */
  async list(
    connection: Connection,
    {
      folderId,
      view = "files",
      signal,
      maxEntries = DEFAULT_MAX_ENTRIES,
    }: {
      folderId: string | null;
      view?: ListView;
      signal?: AbortSignal;
      maxEntries?: number;
    },
  ): Promise<FolderListing> {
    const entries: VaultEntry[] = [];
    let cursor: string | null = null;
    let path: string | null = null;
    let truncated = false;
    do {
      const search = new URLSearchParams({
        view,
        limit: String(PAGE_SIZE),
        ...(folderId ? { folder: folderId } : {}),
        ...(cursor ? { cursor } : {}),
        ...(view === "files" || view === "shared"
          ? { includePlans: "true" }
          : {}),
      });
      // Each cursor comes from the page before it.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const page = await apiJson<FilesPage>(`/api/files?${search}`, signal);
      const names = await this.decryptNames(
        connection,
        [
          ...page.entries.flatMap((entry) => {
            const reference = entryReference(entry);
            return reference ? [reference] : [];
          }),
          ...(path === null ? breadcrumbReferences(page.breadcrumbs) : []),
        ],
        page.metadataPlans,
        signal,
      );
      if (path === null && (view === "files" || view === "shared")) {
        path = `/${page.breadcrumbs
          .map((crumb) => nameOf(crumb.id, crumb.name, names))
          .join("/")}`;
      }
      for (const entry of page.entries) {
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
        entries.push(toVaultEntry(entry, names.get(entry.id)));
      }
      cursor = page.hasMore ? page.nextCursor : null;
      if (page.hasMore && !cursor) {
        throw new Error("The folder listing could not be continued.");
      }
      if (cursor && entries.length >= maxEntries) {
        truncated = true;
        cursor = null;
      }
    } while (cursor);
    entries.sort(
      (left, right) =>
        Number(right.type === "folder") - Number(left.type === "folder") ||
        left.name.localeCompare(right.name, "en", { numeric: true }),
    );
    return { folderId, path, entries, truncated };
  }

  /** Describes one node by id, with its decrypted manifest. */
  async describe(
    connection: Connection,
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<{ plan: VaultDownloadPlan; manifest: VaultManifest }> {
    const plan = await getVaultDownloadPlan(nodeId, signal);
    const manifest = await this.openNode(connection, nodeId, plan, signal);
    return { plan, manifest };
  }

  forgetMetadata(): void {
    this.resolver.clear();
  }

  private async decryptNames(
    connection: Connection,
    references: VaultMetadataReference[],
    plans: VaultMetadataPlan[] | undefined,
    signal?: AbortSignal,
  ): Promise<Map<string, VaultManifest | string>> {
    const names = new Map<string, VaultManifest | string>();
    if (references.length === 0) return names;
    const results = await this.resolver.resolve(
      references,
      {
        csrfToken: connection.csrfToken,
        client: connection.client,
        openNode: (nodeId, plan, nodeSignal) =>
          this.openNode(connection, nodeId, plan, nodeSignal),
      },
      { signal, ...(plans ? { plans } : {}) },
    );
    for (const result of results) {
      names.set(
        result.nodeId,
        result.status === "ready" ? result.manifest : result.error,
      );
    }
    return names;
  }
}

export function entryReference(
  entry: Pick<
    FileEntry,
    | "id"
    | "parentId"
    | "vaultRecordHash"
    | "vaultRecordVersion"
    | "vaultGenerationId"
  >,
): VaultMetadataReference | null {
  if (
    entry.vaultRecordHash === null ||
    entry.vaultRecordVersion === null ||
    entry.vaultGenerationId === null
  ) {
    return null;
  }
  return {
    nodeId: entry.id,
    parentId: entry.parentId,
    recordVersion: entry.vaultRecordVersion,
    recordHash: entry.vaultRecordHash,
    generationId: entry.vaultGenerationId,
  };
}

function breadcrumbReferences(
  breadcrumbs: FolderBreadcrumb[],
): VaultMetadataReference[] {
  return breadcrumbs.flatMap((crumb, index) =>
    crumb.vaultRecordHash !== null &&
    crumb.vaultRecordVersion !== null &&
    crumb.vaultGenerationId !== null
      ? [
          {
            nodeId: crumb.id,
            parentId: index > 0 ? breadcrumbs[index - 1].id : null,
            recordVersion: crumb.vaultRecordVersion,
            recordHash: crumb.vaultRecordHash,
            generationId: crumb.vaultGenerationId,
          },
        ]
      : [],
  );
}

function nameOf(
  id: string,
  fallback: string,
  names: Map<string, VaultManifest | string>,
): string {
  const resolved = names.get(id);
  return resolved && typeof resolved !== "string" ? resolved.name : fallback;
}

function toVaultEntry(
  entry: FileEntry,
  resolved: VaultManifest | string | undefined,
): VaultEntry {
  const manifest = resolved && typeof resolved !== "string" ? resolved : null;
  const encrypted = entry.e2eeState === "encrypted";
  const record =
    entry.vaultRecordHash !== null &&
    entry.vaultRecordVersion !== null &&
    entry.vaultGenerationId !== null
      ? {
          version: entry.vaultRecordVersion,
          hash: entry.vaultRecordHash,
          generationId: entry.vaultGenerationId,
        }
      : null;
  return {
    id: entry.id,
    name:
      manifest?.name ??
      (encrypted ? `(encrypted item ${entry.id})` : entry.name),
    type: entry.entryType,
    parentId: entry.parentId,
    size:
      entry.entryType === "folder"
        ? null
        : (manifest?.plaintextBytes ?? (encrypted ? null : entry.sizeBytes)),
    mimeType: manifest?.mimeType ?? null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    state: entry.state,
    shared: entry.shared,
    owner: entry.ownerUsername,
    encrypted,
    ...(encrypted && !manifest
      ? {
          unreadable:
            typeof resolved === "string"
              ? resolved
              : "The encrypted name is not available.",
        }
      : {}),
    record,
  };
}

/** GETs an API path as JSON, waiting out 429 and 503 answers a few times. */
export async function apiJson<T>(
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const response = await fetch(path, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (response.ok) return (await response.json()) as T;
    const retryAfter = response.headers.get("Retry-After");
    const message = (await response.text()).trim();
    if (
      (response.status === 429 || response.status === 503) &&
      attempt < API_RETRY_ATTEMPTS
    ) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await delay(retryDelay(retryAfter, attempt), signal);
      continue;
    }
    throw new VaultApiError(
      message || `Aeralyth answered ${response.status}.`,
      response.status,
      retryAfter,
    );
  }
}

function retryDelay(retryAfter: string | null, attempt: number): number {
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(10_000, seconds * 1000);
  }
  return Math.min(4_000, 250 * 2 ** attempt);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function requiredParentId(error: unknown): string | null {
  if (
    !(error instanceof VaultWorkerError) ||
    error.code !== "PARENT_KEY_REQUIRED"
  ) {
    return null;
  }
  const separator = error.message.lastIndexOf(":");
  const parentId = separator >= 0 ? error.message.slice(separator + 1) : "";
  return parentId || null;
}

export function messageOf(failure: unknown): string {
  return failure instanceof Error && failure.message
    ? failure.message
    : String(failure);
}
