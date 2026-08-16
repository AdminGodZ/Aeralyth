import type {
  VaultActiveShareContext,
  VaultDownloadPlan,
  VaultNodeRecord,
  VaultPublicIdentity,
  VaultRewrapPayload,
  VaultSetupPayload,
  VaultShareNodeSnapshot,
  VaultUnlockMaterial,
} from "@/features/vault/protocol";
import { fromBase64Url, toArrayBuffer } from "@/features/vault/protocol";
import {
  encodeCreateSharePublication,
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
  existingParts: Array<{
    partNumber: number;
    etag: string;
    checksumSha256: string | null;
  }>;
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

export class VaultApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VaultApiError";
  }
}

export function getVaultStatus(signal?: AbortSignal): Promise<VaultStatus> {
  return vaultRequest("/api/vault", { signal });
}

export function getUnlockMaterial(
  signal?: AbortSignal,
): Promise<VaultUnlockMaterial> {
  return vaultRequest("/api/vault/unlock-material", { signal });
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
  return vaultBinaryMutation(
    `/api/vault/uploads/${encodeURIComponent(uploadId)}/publish`,
    csrfToken,
    encodeNodePublication(parts, record),
    signal,
  );
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
  await vaultBinaryMutation(
    `/api/vault/share-sync-jobs/${encodeURIComponent(job.nodeId)}`,
    csrfToken,
    encodeShareDirectoryPublication(payload),
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
  return vaultRequest(
    `/api/vault/nodes/${encodeURIComponent(nodeId)}/download-plan`,
    { signal },
  );
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
  return vaultRequest(
    `/api/vault/nodes/${encodeURIComponent(nodeId)}/share-plan`,
    { signal },
  );
}

export function getActiveShareContexts(
  nodeId: string,
  signal?: AbortSignal,
): Promise<VaultActiveShareContext[]> {
  return vaultRequest(
    `/api/vault/nodes/${encodeURIComponent(nodeId)}/share-contexts`,
    { signal },
  );
}

export function createVaultShare(
  csrfToken: string,
  payload: VaultSharePayload,
  signal?: AbortSignal,
): Promise<VaultShareMutation> {
  return vaultBinaryMutation(
    "/api/vault/shares",
    csrfToken,
    encodeCreateSharePublication(payload),
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
  return vaultMutation(
    `/api/vault/shares/${encodeURIComponent(shareId)}/epochs`,
    csrfToken,
    { revokedRecipientId },
    signal,
  );
}

export function getPendingVaultEpochRotation(
  shareId: string,
  signal?: AbortSignal,
): Promise<VaultEpochRotationPlan> {
  return vaultRequest(
    `/api/vault/shares/${encodeURIComponent(shareId)}/epochs/pending`,
    { signal },
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
  return vaultBinaryMutation(
    `/api/vault/shares/${encodeURIComponent(shareId)}/epochs/${epoch}/publish`,
    csrfToken,
    encodePublishEpochPublication({
      ...payload,
      fenceSnapshotHash: fromBase64Url(payload.fenceSnapshotHash),
    }),
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
    );
  }
  if (allowEmpty || response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
