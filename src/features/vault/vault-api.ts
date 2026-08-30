import { WeightedSemaphore } from "@/features/vault/bounded-async";
import type {
  VaultAccountStateManifest,
  VaultActiveShareContext,
  VaultDownloadPlan,
  VaultMetadataPlan,
  VaultMetadataReference,
  VaultNodeRecord,
  VaultPasswordRewrapPayload,
  VaultPublicIdentity,
  VaultRewrapPayload,
  VaultSetupPayload,
  VaultShareNodeSnapshot,
  VaultSharePreparationPlan,
  VaultUnlockMaterial,
} from "@/features/vault/protocol";
import { fromBase64Url, toArrayBuffer } from "@/features/vault/protocol";
import {
  encodeCreateSharePublication,
  encodeFolderBatchPublication,
  encodeNodePublication,
  encodePublishEpochPublication,
  encodeShareDirectoryPublication,
  VAULT_PUBLICATION_CONTENT_TYPE,
} from "@/features/vault/vault-wire";

export type VaultStatus = {
  mode: "off" | "migrate" | "required";
  configured: boolean;
  vaultVersion: number | null;
  migration: {
    legacyNodes: number;
    incompleteNodes: number;
    readyForRequired: boolean;
  };
};

export type VaultMigrationNode = {
  nodeId: string;
  parentId: string | null;
  entryType: "file" | "folder";
  name: string;
  mimeType: string | null;
  plaintextBytes: number;
  lastModified: number;
  downloadUrl: string | null;
};

export type VaultMigrationClaim = {
  node: VaultMigrationNode | null;
  migration: VaultStatus["migration"];
};

export type VaultUploadPlan = {
  uploadId: string;
  nodeId: string;
  mode: "none" | "single" | "multipart";
  partSizeBytes: number | null;
};

export type VaultUploadUrl = {
  url: string;
  contentLength: number;
};

export type VaultPartUploadUrl = VaultUploadUrl & {
  partNumber: number;
};

export type VaultPublishResponse = {
  nodeId: string;
  generationNumber: number;
  generationId: string;
  recordVersion: number;
  recordHash: string;
  shareSyncRequired: boolean;
};

export type VaultShareSyncJob = {
  nodeId: string;
  contextCacheKey?: string;
  entryType: "file" | "folder";
  generationNumber: number;
  generationId: string;
  recordVersion: number;
  recordHash: string;
};

export type VaultCompletedPart = {
  partNumber: number;
  etag: string;
  checksumSha256: string;
};

export type VaultSharePayload = {
  shareId: string;
  rootNodeId: string;
  recipientId: string;
  recipientKeyVersion: number;
  wrappers: Uint8Array[];
  envelopes: Array<{
    canonicalCbor: Uint8Array;
    signature: Uint8Array;
  }>;
  ownerEpochKey: { wrapperId: Uint8Array; ciphertext: Uint8Array };
};

export type VaultShareMutation = {
  shareId: string;
  activeEpoch: number;
  recordHash: string;
  limitation: string;
};

export type VaultOwnedShare = {
  shareId: string;
  rootNodeId: string;
  activeEpoch: number;
  pendingEpoch: number | null;
  pendingRevokedRecipientId: string | null;
  status: "active" | "rotating";
  recipients: Array<{
    userId: string;
    username: string;
    keyVersion: number;
  }>;
};

export type VaultOwnedSharePage = {
  shares: VaultOwnedShare[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type VaultEpochRotationPlan = {
  shareId: string;
  pendingEpoch: number;
  fenceSnapshotHash: string;
  nodes: VaultShareNodeSnapshot[];
  retainedRecipients: Array<{
    userId: string;
    keyVersion: number;
    x25519PublicKey: string;
    ed25519PublicKey: string;
    fingerprintSha256: string;
  }>;
  recordVersion: number;
  previousRecordHash: string;
};

export type FileTreeMutation = "trash" | "restore" | "delete";

type FileTreeMutationResponse = {
  status: "trashed" | "restored" | "deleted";
  fileId: string;
};

export class VaultApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter: string | null = null,
  ) {
    super(message);
    this.name = "VaultApiError";
  }
}

const VAULT_RECURSIVE_OPERATION_ATTEMPTS = 4;
const VAULT_RECURSIVE_OPERATION_RETRY_BASE_MS = 250;
const vaultRecursiveOperationSlots = new WeightedSemaphore(1);

async function runVaultRecursiveOperation<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const release = await vaultRecursiveOperationSlots.acquire(1, signal);
  try {
    let lastError: unknown;
    for (
      let attempt = 0;
      attempt < VAULT_RECURSIVE_OPERATION_ATTEMPTS;
      attempt += 1
    ) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (
          signal?.aborted ||
          !(error instanceof VaultApiError) ||
          ![429, 503].includes(error.status) ||
          attempt + 1 >= VAULT_RECURSIVE_OPERATION_ATTEMPTS
        ) {
          throw error;
        }
        await waitForVaultCapacity(
          vaultCapacityRetryDelay(error, attempt),
          signal,
        );
      }
    }
    throw lastError;
  } finally {
    release();
  }
}

function vaultCapacityRetryDelay(error: VaultApiError, attempt: number) {
  const retryAfter = error.retryAfter?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1_000);
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.max(0, retryAt - Date.now());
    }
  }
  return Math.min(
    2_000,
    VAULT_RECURSIVE_OPERATION_RETRY_BASE_MS * 2 ** attempt,
  );
}

function waitForVaultCapacity(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function getVaultStatus(signal?: AbortSignal): Promise<VaultStatus> {
  return vaultRequest("/api/vault", { signal });
}

export function mutateFileTree(
  entryId: string,
  mutation: FileTreeMutation,
  csrfToken: string,
  signal?: AbortSignal,
): Promise<FileTreeMutationResponse> {
  return runVaultRecursiveOperation(async () => {
    const response = await fetch(
      `/api/files/${encodeURIComponent(entryId)}/${mutation}`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrf_token: csrfToken }),
        signal,
      },
    );
    if (!response.ok) {
      throw new VaultApiError(
        (await response.text()) || "The file operation failed.",
        response.status,
        response.headers.get("retry-after"),
      );
    }

    const payload =
      (await response.json()) as Partial<FileTreeMutationResponse>;
    const expectedStatus =
      mutation === "trash"
        ? "trashed"
        : mutation === "restore"
          ? "restored"
          : "deleted";
    if (payload.fileId !== entryId || payload.status !== expectedStatus) {
      throw new Error("The file operation returned an invalid response.");
    }
    return payload as FileTreeMutationResponse;
  }, signal);
}

export function getUnlockMaterial(
  signal?: AbortSignal,
): Promise<VaultUnlockMaterial> {
  return vaultRequest("/api/vault/unlock-material", { signal });
}

export async function getVaultAccountState(
  manifest: VaultAccountStateManifest,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch("/api/vault/account-state", {
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) {
    throw new VaultApiError(
      (await response.text()) || "The vault account state is unavailable.",
      response.status,
    );
  }
  if (
    response.headers.get("x-vault-account-state-record-id") !==
      manifest.recordId ||
    Number(response.headers.get("x-vault-account-state-version")) !==
      manifest.version
  ) {
    throw new Error("The vault account-state revision changed.");
  }
  const ciphertext = new Uint8Array(await response.arrayBuffer());
  if (ciphertext.length !== manifest.ciphertextBytes) {
    throw new Error("The vault account-state length changed.");
  }
  return ciphertext;
}

export function setupVault(
  csrfToken: string,
  payload: VaultSetupPayload,
  signal?: AbortSignal,
): Promise<{ vaultVersion: number }> {
  return vaultMutation("/api/vault/setup", csrfToken, payload, signal);
}

export function rewrapVault(
  csrfToken: string,
  payload: VaultRewrapPayload,
  signal?: AbortSignal,
): Promise<{ vaultVersion: number }> {
  return vaultMutation("/api/vault/rewrap", csrfToken, payload, signal);
}

export function rewrapVaultPassword(
  csrfToken: string,
  payload: VaultPasswordRewrapPayload,
  signal?: AbortSignal,
): Promise<{ vaultVersion: number }> {
  return vaultMutation(
    "/api/vault/rewrap-password",
    csrfToken,
    payload,
    signal,
  );
}

export function initVaultUpload(
  csrfToken: string,
  payload: {
    nodeId: string;
    parentId: string | null;
    entryType: "file" | "folder";
    generationNumber: number;
    generationId: string;
    ciphertextLength: number;
    chunkCount: number;
    migration?: boolean;
  },
  signal?: AbortSignal,
): Promise<VaultUploadPlan> {
  return vaultMutation("/api/vault/uploads", csrfToken, payload, signal);
}

export function claimVaultMigration(
  csrfToken: string,
  signal?: AbortSignal,
): Promise<VaultMigrationClaim> {
  return vaultMutation("/api/vault/migrations/claim", csrfToken, {}, signal);
}

export function getVaultContentUrl(
  csrfToken: string,
  uploadId: string,
  checksumSha256: string,
  signal?: AbortSignal,
): Promise<VaultUploadUrl> {
  return vaultMutation(
    `/api/vault/uploads/${encodeURIComponent(uploadId)}/content-url`,
    csrfToken,
    { checksumSha256 },
    signal,
  );
}

export function getVaultPartUrl(
  csrfToken: string,
  uploadId: string,
  partNumber: number,
  checksumSha256: string,
  signal?: AbortSignal,
): Promise<VaultUploadUrl> {
  return vaultMutation(
    `/api/vault/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`,
    csrfToken,
    { checksumSha256 },
    signal,
  );
}

export function getVaultPartUrls(
  csrfToken: string,
  uploadId: string,
  parts: Array<{ partNumber: number; checksumSha256: string }>,
  signal?: AbortSignal,
): Promise<{ parts: VaultPartUploadUrl[] }> {
  return vaultMutation(
    `/api/vault/uploads/${encodeURIComponent(uploadId)}/parts`,
    csrfToken,
    { parts },
    signal,
  );
}

export function publishVaultUpload(
  csrfToken: string,
  uploadId: string,
  parts: VaultCompletedPart[],
  record: VaultNodeRecord,
  signal?: AbortSignal,
): Promise<VaultPublishResponse> {
  const payload = encodeNodePublication(parts, record);
  return runVaultRecursiveOperation(
    () =>
      vaultBinaryMutation(
        `/api/vault/uploads/${encodeURIComponent(uploadId)}/publish`,
        csrfToken,
        payload,
        signal,
      ),
    signal,
  );
}

export async function publishVaultFoldersBatch(
  csrfToken: string,
  records: VaultNodeRecord[],
  signal?: AbortSignal,
): Promise<{ folders: VaultPublishResponse[] }> {
  const payload = encodeFolderBatchPublication(records);
  return runVaultRecursiveOperation(async () => {
    try {
      return await vaultBinaryMutation(
        "/api/vault/folders/batch",
        csrfToken,
        payload,
        signal,
      );
    } catch (error) {
      if (signal?.aborted || error instanceof VaultApiError) throw error;
      return vaultBinaryMutation(
        "/api/vault/folders/batch",
        csrfToken,
        payload,
        signal,
      );
    }
  }, signal);
}

export function getShareSyncJobs(
  signal?: AbortSignal,
): Promise<{ jobs: VaultShareSyncJob[] }> {
  return vaultRequest("/api/vault/share-sync-jobs", { signal });
}

export async function publishShareDirectory(
  csrfToken: string,
  job: VaultShareSyncJob,
  payload: {
    directoryCbor: Uint8Array;
    directorySignature: Uint8Array;
    wrappers: Uint8Array[];
  } | null,
  signal?: AbortSignal,
): Promise<void> {
  const publication = encodeShareDirectoryPublication(payload);
  await runVaultRecursiveOperation(
    () =>
      vaultBinaryMutation(
        `/api/vault/share-sync-jobs/${encodeURIComponent(job.nodeId)}`,
        csrfToken,
        publication,
        signal,
      ),
    signal,
  );
}

export async function abortVaultUpload(
  csrfToken: string,
  uploadId: string,
): Promise<void> {
  await vaultRequest(
    `/api/vault/uploads/${encodeURIComponent(uploadId)}`,
    {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    },
    true,
  );
}

export function getVaultDownloadPlan(
  nodeId: string,
  signal?: AbortSignal,
): Promise<VaultDownloadPlan> {
  return runVaultRecursiveOperation(
    () =>
      vaultRequest(
        `/api/vault/nodes/${encodeURIComponent(nodeId)}/download-plan`,
        { signal },
      ),
    signal,
  );
}

export function getVaultMetadataPlans(
  csrfToken: string,
  nodeIds: readonly string[],
  continuation?: number,
  signal?: AbortSignal,
  purpose?: "sharePreparation",
): Promise<{ plans: VaultMetadataPlan[]; continuation?: number }> {
  return runVaultRecursiveOperation(
    () =>
      vaultMutation(
        "/api/vault/nodes/metadata-plans",
        csrfToken,
        {
          nodeIds,
          ...(continuation === undefined ? {} : { continuation }),
          ...(purpose ? { purpose } : {}),
        },
        signal,
      ),
    signal,
  );
}

export async function getVaultSharePreparationPlans(
  csrfToken: string,
  nodes: readonly VaultShareNodeSnapshot[],
  signal?: AbortSignal,
): Promise<VaultSharePreparationPlan[]> {
  const plans = new Map<string, VaultMetadataPlan>();
  for (let offset = 0; offset < nodes.length; offset += 100) {
    const page = nodes.slice(offset, offset + 100);
    let continuation: number | undefined;
    do {
      const response = await getVaultMetadataPlans(
        csrfToken,
        page.map((node) => node.nodeId),
        continuation,
        signal,
        "sharePreparation",
      );
      for (const plan of response.plans) plans.set(plan.nodeId, plan);
      continuation = response.continuation;
    } while (continuation !== undefined);
  }
  return nodes.map((snapshot) => {
    const metadata = plans.get(snapshot.nodeId);
    if (
      !metadata ||
      metadata.recordVersion !== snapshot.recordVersion ||
      metadata.recordHash !== snapshot.recordHash ||
      metadata.generationId !== snapshot.generationId
    ) {
      throw new Error("The share-preparation metadata snapshot changed.");
    }
    return { snapshot, metadata };
  });
}

export async function getVaultFolderMetadataReferences(
  folderId: string,
  view: "files" | "shared",
  signal?: AbortSignal,
): Promise<VaultMetadataReference[]> {
  const response = await runVaultRecursiveOperation(
    () =>
      vaultRequest<{ entries?: unknown }>(
        `/api/files?${new URLSearchParams({
          view,
          folder: folderId,
          sort: "name",
          direction: "asc",
          limit: "100",
        })}`,
        { signal },
      ),
    signal,
  );
  if (!Array.isArray(response.entries)) {
    throw new Error("The folder metadata prefetch response is invalid.");
  }
  return response.entries.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const entry = value as Record<string, unknown>;
    if (
      entry.e2eeState !== "encrypted" ||
      typeof entry.id !== "string" ||
      !(typeof entry.parentId === "string" || entry.parentId === null) ||
      typeof entry.vaultRecordVersion !== "number" ||
      typeof entry.vaultRecordHash !== "string" ||
      typeof entry.vaultGenerationId !== "string"
    ) {
      return [];
    }
    return [
      {
        nodeId: entry.id,
        parentId: entry.parentId,
        recordVersion: entry.vaultRecordVersion,
        recordHash: entry.vaultRecordHash,
        generationId: entry.vaultGenerationId,
      },
    ];
  });
}

export function getVaultIdentity(
  username: string,
  signal?: AbortSignal,
): Promise<VaultPublicIdentity> {
  return vaultRequest(`/api/vault/identities/${encodeURIComponent(username)}`, {
    signal,
  });
}

export async function trustVaultIdentity(
  csrfToken: string,
  identity: VaultPublicIdentity,
  signal?: AbortSignal,
): Promise<void> {
  await vaultMutation(
    `/api/vault/identities/${encodeURIComponent(identity.userId)}/trust`,
    csrfToken,
    {
      keyVersion: identity.keyVersion,
      fingerprintSha256: identity.fingerprintSha256,
    },
    signal,
  );
}

export function getVaultSharePlan(
  nodeId: string,
  signal?: AbortSignal,
): Promise<{ nodes: VaultShareNodeSnapshot[] }> {
  return runVaultRecursiveOperation(
    () =>
      vaultRequest(
        `/api/vault/nodes/${encodeURIComponent(nodeId)}/share-plan`,
        { signal },
      ),
    signal,
  );
}

export function getActiveShareContexts(
  nodeId: string,
  signal?: AbortSignal,
): Promise<VaultActiveShareContext[]> {
  return runVaultRecursiveOperation(
    () =>
      vaultRequest(
        `/api/vault/nodes/${encodeURIComponent(nodeId)}/share-contexts`,
        { signal },
      ),
    signal,
  );
}

export function createVaultShare(
  csrfToken: string,
  payload: VaultSharePayload,
  signal?: AbortSignal,
): Promise<VaultShareMutation> {
  const publication = encodeCreateSharePublication(payload);
  return runVaultRecursiveOperation(
    () =>
      vaultBinaryMutation("/api/vault/shares", csrfToken, publication, signal),
    signal,
  );
}

export function getOwnedVaultShares(
  rootNodeId: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<VaultOwnedSharePage> {
  return vaultRequest(
    `/api/vault/shares?${new URLSearchParams({
      rootNodeId,
      ...(cursor ? { cursor } : {}),
    })}`,
    { signal },
  );
}

export function beginVaultEpochRotation(
  csrfToken: string,
  shareId: string,
  revokedRecipientId: string,
  signal?: AbortSignal,
): Promise<VaultEpochRotationPlan> {
  return runVaultRecursiveOperation(
    () =>
      vaultMutation(
        `/api/vault/shares/${encodeURIComponent(shareId)}/epochs`,
        csrfToken,
        { revokedRecipientId },
        signal,
      ),
    signal,
  );
}

export function getPendingVaultEpochRotation(
  shareId: string,
  signal?: AbortSignal,
): Promise<VaultEpochRotationPlan> {
  return runVaultRecursiveOperation(
    () =>
      vaultRequest(
        `/api/vault/shares/${encodeURIComponent(shareId)}/epochs/pending`,
        { signal },
      ),
    signal,
  );
}

export function publishVaultEpochRotation(
  csrfToken: string,
  shareId: string,
  epoch: number,
  payload: {
    fenceSnapshotHash: string;
    wrappers: Uint8Array[];
    envelopes: Array<{
      canonicalCbor: Uint8Array;
      signature: Uint8Array;
    }>;
    ownerEpochKey: { wrapperId: Uint8Array; ciphertext: Uint8Array };
  },
  signal?: AbortSignal,
): Promise<VaultShareMutation> {
  const publication = encodePublishEpochPublication({
    ...payload,
    fenceSnapshotHash: fromBase64Url(payload.fenceSnapshotHash),
  });
  return runVaultRecursiveOperation(
    () =>
      vaultBinaryMutation(
        `/api/vault/shares/${encodeURIComponent(shareId)}/epochs/${epoch}/publish`,
        csrfToken,
        publication,
        signal,
      ),
    signal,
  );
}

export async function abortVaultEpochRotation(
  csrfToken: string,
  shareId: string,
  epoch: number,
): Promise<void> {
  await vaultMutation(
    `/api/vault/shares/${encodeURIComponent(shareId)}/epochs/${epoch}/abort`,
    csrfToken,
    {},
  );
}

async function vaultMutation<T>(
  url: string,
  csrfToken: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return vaultRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(payload),
    signal,
  });
}

async function vaultBinaryMutation<T>(
  url: string,
  csrfToken: string,
  payload: Uint8Array,
  signal?: AbortSignal,
): Promise<T> {
  return vaultRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": VAULT_PUBLICATION_CONTENT_TYPE,
      "X-CSRF-Token": csrfToken,
    },
    body: toArrayBuffer(payload),
    signal,
  });
}

async function vaultRequest<T>(
  url: string,
  init: RequestInit,
  allowEmpty = false,
): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
  });
  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new VaultApiError(
      message || `Vault request failed with status ${response.status}.`,
      response.status,
      response.headers.get("Retry-After"),
    );
  }
  if (allowEmpty || response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
