import type {
  VaultActiveShareContext,
  VaultDownloadPlan,
  VaultEntryType,
  VaultManifest,
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

export type VaultWorkerRequest =
  | { id: number; type: "preflight" }
  | {
      id: number;
      type: "deriveAuthCredential";
      username: string;
      password: string;
      salt: string;
    }
  | { id: number; type: "setup"; password: string }
  | {
      id: number;
      type: "unlock";
      password: string;
      material: VaultUnlockMaterial;
    }
  | {
      id: number;
      type: "resume";
      sessionId: string;
      sessionBinding: string;
      material: VaultUnlockMaterial;
    }
  | {
      id: number;
      type: "persistSession";
      sessionId: string;
      sessionBinding: string;
      expiresAt: number;
      vaultVersion: number;
    }
  | {
      id: number;
      type: "extendSession";
      sessionId: string;
      expiresAt: number;
    }
  | {
      id: number;
      type: "recover";
      recoveryCode: string;
      newPassword: string;
      material: VaultUnlockMaterial;
    }
  | {
      id: number;
      type: "rewrapPassword";
      currentPassword: string;
      newPassword: string;
      material: VaultUnlockMaterial;
    }
  | { id: number; type: "lock" }
  | {
      id: number;
      type: "openPlan";
      plan: VaultMetadataPlan;
    }
  | {
      id: number;
      type: "getCachedMetadata";
      references: VaultMetadataReference[];
    }
  | {
      id: number;
      type: "openMetadataPlans";
      plans: VaultMetadataPlan[];
      concurrency: number;
      priorityCount: number;
    }
  | {
      id: number;
      type: "cancelMetadataOperation";
      operationId: number;
    }
  | {
      id: number;
      type: "startEncryption";
      input: VaultEncryptionInput;
    }
  | {
      id: number;
      type: "encryptChunk";
      sessionId: string;
      chunkIndex: number;
      plaintext: ArrayBuffer;
    }
  | {
      id: number;
      type: "finalizeEncryption";
      sessionId: string;
    }
  | {
      id: number;
      type: "abortEncryption";
      sessionId: string;
      nodeId: string;
    }
  | {
      id: number;
      type: "createShareDirectory";
      input: VaultShareDirectoryInput;
    }
  | {
      id: number;
      type: "clearShareContextCache";
      cacheKey: string;
    }
  | {
      id: number;
      type: "startDecryption";
      plan: VaultDownloadPlan;
    }
  | {
      id: number;
      type: "decryptChunk";
      sessionId: string;
      chunkIndex: number;
      ciphertext: ArrayBuffer;
    }
  | {
      id: number;
      type: "finalizeDecryption";
      sessionId: string;
    }
  | {
      id: number;
      type: "abortDecryption";
      sessionId: string;
    }
  | {
      id: number;
      type: "createShareMaterial";
      input: VaultShareMaterialInput;
    }
  | {
      id: number;
      type: "rotateShareMaterial";
      input: VaultShareRotationInput;
    };

export type VaultEncryptionInput = {
  nodeId?: string;
  parentId: string | null;
  entryType: VaultEntryType;
  name: string;
  mimeType: string | null;
  plaintextBytes: number;
  lastModified: number;
  generationNumber?: number;
  recordVersion?: number;
  previousRecordHash?: string | null;
};

export type VaultEncryptionStart = {
  sessionId: string;
  nodeId: string;
  generationNumber: number;
  generationId: string;
  recordVersion: number;
  paddedBytes: number;
  ciphertextLength: number;
  chunkCount: number;
};

export type VaultEncryptedChunk = {
  ciphertext: ArrayBuffer;
  ciphertextBytes: number;
};

export type VaultEncryptionComplete = {
  nodeId: string;
  generationNumber: number;
  generationId: string;
  recordVersion: number;
  ciphertextLength: number;
  chunkCount: number;
  record: VaultNodeRecord;
};

export type VaultShareDirectoryInput = {
  nodeId: string;
  entryType: VaultEntryType;
  generationNumber: number;
  generationId: string;
  recordVersion: number;
  recordHash: string;
  shareContexts: VaultActiveShareContext[];
  shareContextCacheKey?: string;
};

export type VaultShareDirectoryResult = {
  directoryCbor: Uint8Array;
  directorySignature: Uint8Array;
  wrappers: Uint8Array[];
};

export type VaultOpenPlanResult = {
  manifest: VaultManifest;
};

export type VaultMetadataOpenResult =
  | {
      status: "ready";
      nodeId: string;
      recordHash: string;
      manifest: VaultManifest;
    }
  | {
      status: "unavailable";
      nodeId: string;
      recordHash: string;
      error: string;
      code?: string;
    };

export type VaultCachedMetadataResult = Extract<
  VaultMetadataOpenResult,
  { status: "ready" }
>;

export type VaultShareMaterialProgress = {
  completedNodes: number;
  totalNodes: number;
};

export type VaultWorkerProgress =
  | {
      type: "openMetadataPlans";
      results: VaultMetadataOpenResult[];
    }
  | (VaultShareMaterialProgress & {
      type: "shareMaterial";
      nodeId: string;
      wrappers: Uint8Array[];
    });

export type VaultDecryptionStart = VaultOpenPlanResult & {
  sessionId: string;
};

export type VaultDecryptedChunk = {
  plaintext: ArrayBuffer;
  plaintextBytes: number;
};

export type VaultSetupResult = {
  payload: VaultSetupPayload;
  recoveryCode: string;
};

export type VaultUnlockResult = {
  vaultVersion: number;
  identityFingerprint: string;
};

export type VaultResumeResult =
  | { resumed: true; expiresAt: number }
  | { resumed: false };

export type VaultRecoveryResult = {
  payload: VaultRewrapPayload;
  recoveryCode: string;
};

export type VaultPasswordRewrapResult = {
  payload: VaultPasswordRewrapPayload;
};

export type VaultShareMaterialInput = {
  shareId: string;
  rootNodeId: string;
  senderId: string;
  recipient: VaultPublicIdentity;
  nodes: VaultShareNodeSnapshot[];
  plans: VaultSharePreparationPlan[];
};

export type VaultShareRotationInput = {
  shareId: string;
  rootNodeId: string;
  senderId: string;
  epoch: number;
  recordVersion: number;
  previousRecordHash: string;
  recipients: Array<{
    userId: string;
    keyVersion: number;
    x25519PublicKey: string;
  }>;
  nodes: VaultShareNodeSnapshot[];
  plans: VaultSharePreparationPlan[];
};

export type VaultShareMaterialResult = {
  wrappers: Uint8Array[];
  envelopes: Array<{ canonicalCbor: Uint8Array; signature: Uint8Array }>;
  ownerEpochKey: { wrapperId: Uint8Array; ciphertext: Uint8Array };
};

export type VaultWorkerResult =
  | { type: "preflight"; supported: true }
  | { type: "deriveAuthCredential"; credential: string }
  | { type: "setup"; result: VaultSetupResult }
  | { type: "unlock"; result: VaultUnlockResult }
  | { type: "resume"; result: VaultResumeResult }
  | { type: "persistSession" }
  | { type: "extendSession" }
  | { type: "recover"; result: VaultRecoveryResult }
  | { type: "rewrapPassword"; result: VaultPasswordRewrapResult }
  | { type: "lock" }
  | { type: "openPlan"; result: VaultOpenPlanResult }
  | { type: "getCachedMetadata"; results: VaultCachedMetadataResult[] }
  | { type: "openMetadataPlans"; results: VaultMetadataOpenResult[] }
  | { type: "cancelMetadataOperation" }
  | { type: "startEncryption"; result: VaultEncryptionStart }
  | { type: "encryptChunk"; result: VaultEncryptedChunk }
  | { type: "finalizeEncryption"; result: VaultEncryptionComplete }
  | { type: "abortEncryption" }
  | { type: "createShareDirectory"; result: VaultShareDirectoryResult }
  | { type: "clearShareContextCache" }
  | { type: "startDecryption"; result: VaultDecryptionStart }
  | { type: "decryptChunk"; result: VaultDecryptedChunk }
  | { type: "finalizeDecryption" }
  | { type: "abortDecryption" }
  | { type: "createShareMaterial"; result: VaultShareMaterialResult }
  | { type: "rotateShareMaterial"; result: VaultShareMaterialResult };

export type VaultWorkerResponse =
  | { id: number; ok: true; result: VaultWorkerResult }
  | { id: number; ok: true; progress: VaultWorkerProgress }
  | { id: number; ok: false; error: string; code?: string };
