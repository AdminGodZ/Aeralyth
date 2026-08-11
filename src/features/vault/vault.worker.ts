import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import bs58check from "bs58check";
import sodium from "libsodium-wrappers-sumo";

import {
  detectedCryptoConcurrency,
  mapWithConcurrency,
} from "@/features/vault/bounded-async";
import {
  decodeBootstrap,
  decodeManifest,
  decodeShareDirectory,
  decodeShareEnvelope,
  decodeWrapper,
  encodeBootstrap,
  encodeManifest,
  encodeShareDirectory,
  encodeShareEnvelope,
  encodeWrapper,
} from "@/features/vault/cbor";
import {
  ARGON2ID_PROFILE,
  assertArgon2idProfile,
  chunkNonce,
  ciphertextLeafHash,
  concatBytes,
  encodeChunkAad,
  encodeRecordAad,
  encodeVaultRewrapProof,
  encryptedLength,
  equalBytes,
  fromBase64Url,
  merkleRootFromLeaves,
  padmeLength,
  randomBytes,
  randomPrefixedId,
  sha256,
  toArrayBuffer,
  toBase64Url,
  utf8,
  VAULT_AAD_SCHEMA_ID,
  VAULT_CRYPTO_CHUNK_BYTES,
  VAULT_FORMAT_VERSION,
  VAULT_SHARE_DIRECTORY_VERSION,
  VAULT_SHARE_ENVELOPE_VERSION,
  VAULT_SUITE_ID,
  type VaultActiveShareContext,
  type VaultBootstrapRecord,
  type VaultDownloadPlan,
  type VaultKdf,
  type VaultManifest,
  type VaultPublicIdentity,
  type VaultRewrapPayload,
  type VaultSetupPayload,
  type VaultShareDirectoryRecord,
  type VaultShareEnvelopeRecord,
  type VaultShareNodeSnapshot,
  type VaultUnlockMaterial,
  type VaultWrapperRecord,
  verifyWrapperSetProof,
  wipe,
  wrapperSetRoot,
  zeroNonce,
} from "@/features/vault/protocol";
import type {
  VaultDecryptedChunk,
  VaultDecryptionStart,
  VaultEncryptedChunk,
  VaultEncryptionComplete,
  VaultEncryptionInput,
  VaultEncryptionStart,
  VaultOpenPlanResult,
  VaultRecoveryResult,
  VaultSetupResult,
  VaultShareDirectoryInput,
  VaultShareDirectoryResult,
  VaultShareMaterialInput,
  VaultShareMaterialResult,
  VaultShareRotationInput,
  VaultUnlockResult,
  VaultWorkerRequest,
  VaultWorkerResponse,
  VaultWorkerResult,
} from "@/features/vault/vault-messages";

type WorkerScope = {
  onmessage: ((event: MessageEvent<VaultWorkerRequest>) => void) | null;
  postMessage(message: VaultWorkerResponse, transfer?: Transferable[]): void;
};

type IdentitySecrets = {
  keyVersion: number;
  x25519PublicKey: Uint8Array;
  x25519PrivateKey: Uint8Array;
  ed25519PublicKey: Uint8Array;
  ed25519PrivateKey: Uint8Array;
  fingerprint: Uint8Array;
};

type EncryptionSession = {
  id: string;
  nodeId: string;
  parentId: string | null;
  nodeKey: CryptoKey;
  contentKey: CryptoKey | null;
  generationNumber: number;
  generationId: Uint8Array;
  recordVersion: number;
  previousRecordHash: Uint8Array | null;
  manifest: VaultManifest;
  ciphertextLength: number;
  chunkCount: number;
  encryptedChunks: number;
  consumedPlaintext: number;
  leaves: Uint8Array[];
  ownerWrapper: Uint8Array;
};

type DecryptionSession = {
  id: string;
  nodeId: string;
  contentKey: CryptoKey;
  generationNumber: number;
  generationId: Uint8Array;
  manifest: VaultManifest;
  ciphertextLength: number;
  chunkCount: number;
  decryptedChunks: number;
  leaves: Uint8Array[];
  expectedMerkleRoot: Uint8Array;
};

type OpenedPlan = {
  manifest: VaultManifest;
  nodeKey: CryptoKey | null;
  contentKey: CryptoKey | null;
};

const scope = globalThis as unknown as WorkerScope;
let rootKey: CryptoKey | null = null;
let identity: IdentitySecrets | null = null;
const nodeKeys = new Map<string, CryptoKey>();
const encryptionSessions = new Map<string, EncryptionSession>();
const decryptionSessions = new Map<string, DecryptionSession>();
const SHARE_WRAPPER_CRYPTO_CONCURRENCY = detectedCryptoConcurrency(16);
const SHARE_HASH_CRYPTO_CONCURRENCY = detectedCryptoConcurrency(16);
const SHARE_ENVELOPE_CRYPTO_CONCURRENCY = detectedCryptoConcurrency(8, 2);
const SHARE_SIDECAR_CRYPTO_CONCURRENCY = SHARE_WRAPPER_CRYPTO_CONCURRENCY;
const hpkeSuite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

scope.onmessage = (event) => {
  const request = event.data;
  void dispatch(request)
    .then(({ result, transfer = [] }) => {
      scope.postMessage({ id: request.id, ok: true, result }, transfer);
    })
    .catch((failure: unknown) => {
      const error = normalizeError(failure);
      scope.postMessage({
        id: request.id,
        ok: false,
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
      });
    });
};

async function dispatch(
  request: VaultWorkerRequest,
): Promise<{ result: VaultWorkerResult; transfer?: Transferable[] }> {
  await sodium.ready;

  switch (request.type) {
    case "preflight":
      await preflightArgon2id();
      return { result: { type: "preflight", supported: true } };
    case "setup":
      return {
        result: { type: "setup", result: await setupVault(request.password) },
      };
    case "unlock":
      return {
        result: {
          type: "unlock",
          result: await unlockVault(request.password, request.material),
        },
      };
    case "recover":
      return {
        result: {
          type: "recover",
          result: await recoverVault(
            request.recoveryCode,
            request.newPassword,
            request.material,
          ),
        },
      };
    case "lock":
      lockVault();
      return { result: { type: "lock" } };
    case "openPlan":
      return {
        result: { type: "openPlan", result: await openPlan(request.plan) },
      };
    case "startEncryption":
      return {
        result: {
          type: "startEncryption",
          result: await startEncryption(request.input),
        },
      };
    case "encryptChunk": {
      const encrypted = await encryptChunk(
        request.sessionId,
        request.chunkIndex,
        new Uint8Array(request.plaintext),
      );
      return {
        result: { type: "encryptChunk", result: encrypted },
        transfer: [encrypted.ciphertext],
      };
    }
    case "finalizeEncryption":
      return {
        result: {
          type: "finalizeEncryption",
          result: await finalizeEncryption(request.sessionId),
        },
      };
    case "createShareDirectory":
      return {
        result: {
          type: "createShareDirectory",
          result: await createShareDirectory(request.input),
        },
      };
    case "startDecryption":
      return {
        result: {
          type: "startDecryption",
          result: await startDecryption(request.plan),
        },
      };
    case "decryptChunk": {
      const decrypted = await decryptChunk(
        request.sessionId,
        request.chunkIndex,
        new Uint8Array(request.ciphertext),
      );
      return {
        result: { type: "decryptChunk", result: decrypted },
        transfer: [decrypted.plaintext],
      };
    }
    case "finalizeDecryption":
      await finalizeDecryption(request.sessionId);
      return { result: { type: "finalizeDecryption" } };
    case "createShareMaterial":
      return {
        result: {
          type: "createShareMaterial",
          result: await createShareMaterial(request.input),
        },
      };
    case "rotateShareMaterial":
      return {
        result: {
          type: "rotateShareMaterial",
          result: await rotateShareMaterial(request.input),
        },
      };
  }
}

async function preflightArgon2id(): Promise<void> {
  const salt = randomBytes(16);
  let result: Uint8Array | null = null;
  try {
    result = sodium.crypto_pwhash(
      ARGON2ID_PROFILE.outputBytes,
      "aeralyth-device-preflight-v1",
      salt,
      ARGON2ID_PROFILE.operations,
      ARGON2ID_PROFILE.memoryBytes,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
    if (result.length !== ARGON2ID_PROFILE.outputBytes) {
      throw new Error("Argon2id preflight returned an invalid key.");
    }
  } catch {
    throw vaultError(
      "UNSUPPORTED_DEVICE",
      "This device cannot allocate the 256 MiB required by the vault KDF.",
    );
  } finally {
    wipe(salt, result);
  }
}

async function setupVault(password: string): Promise<VaultSetupResult> {
  validatePassword(password);
  await preflightArgon2id();
  lockVault();

  const rootMaterial = randomBytes(32);
  const recoveryMaterial = randomBytes(32);
  const kdfSalt = randomBytes(16);
  const recoverySalt = randomBytes(16);
  const passwordWrapperId = randomBytes(16);
  const recoveryWrapperId = randomBytes(16);
  const identityRecordId = randomBytes(16);
  const accountStateRecordId = randomBytes(16);
  let passwordKeyMaterial: Uint8Array | null = null;
  let importedRoot: CryptoKey | null = null;

  try {
    passwordKeyMaterial = derivePasswordMaterial(password, kdfSalt);
    const passwordBase = await importHkdf(passwordKeyMaterial);
    const recoveryBase = await importHkdf(recoveryMaterial);
    const [passwordCiphertext, recoveryCiphertext] = await Promise.all([
      wrapRootMaterial(
        rootMaterial,
        passwordBase,
        "password-root",
        passwordWrapperId,
        passwordWrapperId,
        1,
      ),
      wrapRootMaterial(
        rootMaterial,
        recoveryBase,
        "recovery-root",
        concatBytes(recoverySalt, recoveryWrapperId),
        recoveryWrapperId,
        1,
      ),
    ]);

    importedRoot = await importHkdf(rootMaterial);
    const x25519 = sodium.crypto_box_keypair();
    const ed25519 = sodium.crypto_sign_keypair();
    const [fingerprint, privateCiphertext, accountStateCiphertext] =
      await Promise.all([
        sha256(concatBytes(x25519.publicKey, ed25519.publicKey)),
        encryptRootRecord(
          importedRoot,
          "identity-private",
          identityRecordId,
          1,
          concatBytes(x25519.privateKey, ed25519.privateKey),
        ),
        encryptRootRecord(
          importedRoot,
          "account-state",
          accountStateRecordId,
          1,
          utf8('{"formatVersion":1,"nodeKeyVersion":1}'),
        ),
      ]);
    identity = {
      keyVersion: 1,
      x25519PublicKey: x25519.publicKey,
      x25519PrivateKey: x25519.privateKey,
      ed25519PublicKey: ed25519.publicKey,
      ed25519PrivateKey: ed25519.privateKey,
      fingerprint,
    };
    rootKey = importedRoot;

    const kdf: VaultKdf = {
      algorithm: ARGON2ID_PROFILE.algorithm,
      salt: toBase64Url(kdfSalt),
      operations: ARGON2ID_PROFILE.operations,
      memoryBytes: ARGON2ID_PROFILE.memoryBytes,
      outputBytes: ARGON2ID_PROFILE.outputBytes,
    };
    const payload: VaultSetupPayload = {
      formatVersion: VAULT_FORMAT_VERSION,
      kdf,
      passwordWrapper: {
        id: toBase64Url(passwordWrapperId),
        ciphertext: toBase64Url(passwordCiphertext),
      },
      recoveryWrapper: {
        salt: toBase64Url(recoverySalt),
        id: toBase64Url(recoveryWrapperId),
        ciphertext: toBase64Url(recoveryCiphertext),
      },
      identity: {
        keyVersion: 1,
        x25519PublicKey: toBase64Url(x25519.publicKey),
        ed25519PublicKey: toBase64Url(ed25519.publicKey),
        fingerprintSha256: toBase64Url(fingerprint),
        privateRecordId: toBase64Url(identityRecordId),
        privateCiphertext: toBase64Url(privateCiphertext),
      },
      accountStateRecordId: toBase64Url(accountStateRecordId),
      encryptedAccountState: toBase64Url(accountStateCiphertext),
    };

    return {
      payload,
      recoveryCode: bs58check.encode(recoveryMaterial),
    };
  } catch (error) {
    if (!rootKey) {
      lockVault();
    }
    throw error;
  } finally {
    wipe(
      rootMaterial,
      recoveryMaterial,
      passwordKeyMaterial,
      kdfSalt,
      recoverySalt,
      passwordWrapperId,
      recoveryWrapperId,
      identityRecordId,
      accountStateRecordId,
    );
  }
}

async function unlockVault(
  password: string,
  material: VaultUnlockMaterial,
): Promise<VaultUnlockResult> {
  assertUnlockMaterial(material);
  lockVault();
  const salt = fromBase64Url(material.kdf.salt);
  const wrapperId = fromBase64Url(material.passwordWrapper.id);
  let passwordMaterial: Uint8Array | null = null;
  let rootMaterial: Uint8Array | null = null;

  try {
    passwordMaterial = derivePasswordMaterial(password, salt);
    const passwordBase = await importHkdf(passwordMaterial);
    rootMaterial = await unwrapRootMaterial(
      fromBase64Url(material.passwordWrapper.ciphertext),
      passwordBase,
      "password-root",
      wrapperId,
      wrapperId,
      material.vaultVersion,
    );
    await installUnlockedMaterial(rootMaterial, material);
    return {
      vaultVersion: material.vaultVersion,
      identityFingerprint: material.identity.fingerprintSha256,
    };
  } catch (error) {
    lockVault();
    if (error instanceof DOMException && error.name === "OperationError") {
      throw vaultError("INVALID_PASSWORD", "The vault password is incorrect.");
    }
    throw error;
  } finally {
    wipe(salt, wrapperId, passwordMaterial, rootMaterial);
  }
}

async function recoverVault(
  recoveryCode: string,
  newPassword: string,
  material: VaultUnlockMaterial,
): Promise<VaultRecoveryResult> {
  assertUnlockMaterial(material);
  validatePassword(newPassword);
  let recoveryMaterial: Uint8Array;
  try {
    recoveryMaterial = bs58check.decode(recoveryCode.trim());
  } catch {
    throw vaultError("INVALID_RECOVERY_CODE", "The recovery key is invalid.");
  }
  if (recoveryMaterial.length !== 32) {
    wipe(recoveryMaterial);
    throw vaultError("INVALID_RECOVERY_CODE", "The recovery key is invalid.");
  }

  const wrapperId = fromBase64Url(material.recoveryWrapper.id);
  let rootMaterial: Uint8Array | null = null;
  try {
    const recoveryBase = await importHkdf(recoveryMaterial);
    rootMaterial = await unwrapRootMaterial(
      fromBase64Url(material.recoveryWrapper.ciphertext),
      recoveryBase,
      "recovery-root",
      concatBytes(fromBase64Url(material.recoveryWrapper.salt), wrapperId),
      wrapperId,
      material.vaultVersion,
    );
    await installUnlockedMaterial(rootMaterial, material);
    const payload = await buildRewrapPayload(
      newPassword,
      rootMaterial,
      material.vaultVersion,
      true,
    );
    return payload;
  } catch (error) {
    lockVault();
    if (error instanceof DOMException && error.name === "OperationError") {
      throw vaultError("INVALID_RECOVERY_CODE", "The recovery key is invalid.");
    }
    throw error;
  } finally {
    wipe(recoveryMaterial, wrapperId, rootMaterial);
  }
}

async function buildRewrapPayload(
  password: string,
  rootMaterial: Uint8Array,
  currentVaultVersion: number,
  recovery: boolean,
): Promise<VaultRecoveryResult> {
  const newVersion = currentVaultVersion + 1;
  const kdfSalt = randomBytes(16);
  const recoverySalt = randomBytes(16);
  const passwordWrapperId = randomBytes(16);
  const recoveryWrapperId = randomBytes(16);
  const accountStateRecordId = randomBytes(16);
  const newRecoveryMaterial = randomBytes(32);
  let passwordMaterial: Uint8Array | null = null;

  try {
    passwordMaterial = derivePasswordMaterial(password, kdfSalt);
    const passwordBase = await importHkdf(passwordMaterial);
    const recoveryBase = await importHkdf(newRecoveryMaterial);
    const activeRoot = requireRootKey();
    const unsignedPayload: Omit<VaultRewrapPayload, "proofSignature"> = {
      expectedVaultVersion: currentVaultVersion,
      recovery,
      kdf: {
        algorithm: ARGON2ID_PROFILE.algorithm,
        salt: toBase64Url(kdfSalt),
        operations: ARGON2ID_PROFILE.operations,
        memoryBytes: ARGON2ID_PROFILE.memoryBytes,
        outputBytes: ARGON2ID_PROFILE.outputBytes,
      },
      passwordWrapper: {
        id: toBase64Url(passwordWrapperId),
        ciphertext: toBase64Url(
          await wrapRootMaterial(
            rootMaterial,
            passwordBase,
            "password-root",
            passwordWrapperId,
            passwordWrapperId,
            newVersion,
          ),
        ),
      },
      recoveryWrapper: {
        salt: toBase64Url(recoverySalt),
        id: toBase64Url(recoveryWrapperId),
        ciphertext: toBase64Url(
          await wrapRootMaterial(
            rootMaterial,
            recoveryBase,
            "recovery-root",
            concatBytes(recoverySalt, recoveryWrapperId),
            recoveryWrapperId,
            newVersion,
          ),
        ),
      },
      accountStateRecordId: toBase64Url(accountStateRecordId),
      encryptedAccountState: toBase64Url(
        await encryptRootRecord(
          activeRoot,
          "account-state",
          accountStateRecordId,
          newVersion,
          utf8('{"formatVersion":1,"nodeKeyVersion":1}'),
        ),
      ),
    };
    const proof = encodeVaultRewrapProof(unsignedPayload);
    const proofSignature = sodium.crypto_sign_detached(
      proof,
      requireIdentity().ed25519PrivateKey,
    );
    const payload: VaultRewrapPayload = {
      ...unsignedPayload,
      proofSignature: toBase64Url(proofSignature),
    };
    wipe(proof, proofSignature);
    return {
      payload,
      recoveryCode: bs58check.encode(newRecoveryMaterial),
    };
  } finally {
    wipe(
      kdfSalt,
      recoverySalt,
      passwordWrapperId,
      recoveryWrapperId,
      accountStateRecordId,
      newRecoveryMaterial,
      passwordMaterial,
    );
  }
}

async function installUnlockedMaterial(
  rootMaterial: Uint8Array,
  material: VaultUnlockMaterial,
): Promise<void> {
  const importedRoot = await importHkdf(rootMaterial);
  const privateRecordId = fromBase64Url(material.identity.privateRecordId);
  const privateBytes = await decryptRootRecord(
    importedRoot,
    "identity-private",
    privateRecordId,
    material.identity.keyVersion,
    fromBase64Url(material.identity.privateCiphertext),
  );
  if (privateBytes.length !== 96) {
    wipe(privateBytes, privateRecordId);
    throw new Error("The encrypted identity record is invalid.");
  }
  const x25519PrivateKey = privateBytes.slice(0, 32);
  const ed25519PrivateKey = privateBytes.slice(32);
  const x25519PublicKey = fromBase64Url(material.identity.x25519PublicKey);
  const ed25519PublicKey = fromBase64Url(material.identity.ed25519PublicKey);
  const fingerprint = await sha256(
    concatBytes(x25519PublicKey, ed25519PublicKey),
  );
  const expectedFingerprint = fromBase64Url(
    material.identity.fingerprintSha256,
  );
  if (!equalBytes(fingerprint, expectedFingerprint)) {
    wipe(
      privateBytes,
      privateRecordId,
      x25519PrivateKey,
      ed25519PrivateKey,
      x25519PublicKey,
      ed25519PublicKey,
      fingerprint,
      expectedFingerprint,
    );
    throw new Error("The identity fingerprint does not match its public keys.");
  }
  const derivedX25519PublicKey =
    sodium.crypto_scalarmult_base(x25519PrivateKey);
  const derivedEd25519PublicKey =
    sodium.crypto_sign_ed25519_sk_to_pk(ed25519PrivateKey);
  if (
    !equalBytes(derivedX25519PublicKey, x25519PublicKey) ||
    !equalBytes(derivedEd25519PublicKey, ed25519PublicKey)
  ) {
    wipe(derivedX25519PublicKey, derivedEd25519PublicKey);
    throw new Error(
      "The encrypted identity private keys do not match their public keys.",
    );
  }
  wipe(derivedX25519PublicKey, derivedEd25519PublicKey);

  if (material.accountStateRecordId && material.encryptedAccountState) {
    const accountStateId = fromBase64Url(material.accountStateRecordId);
    const accountState = await decryptRootRecord(
      importedRoot,
      "account-state",
      accountStateId,
      material.vaultVersion,
      fromBase64Url(material.encryptedAccountState),
    );
    wipe(accountStateId, accountState);
  }

  rootKey = importedRoot;
  identity = {
    keyVersion: material.identity.keyVersion,
    x25519PublicKey,
    x25519PrivateKey,
    ed25519PublicKey,
    ed25519PrivateKey,
    fingerprint,
  };
  wipe(privateBytes, privateRecordId, expectedFingerprint);
}

function lockVault(): void {
  if (identity) {
    wipe(
      identity.x25519PublicKey,
      identity.x25519PrivateKey,
      identity.ed25519PublicKey,
      identity.ed25519PrivateKey,
      identity.fingerprint,
    );
  }
  identity = null;
  rootKey = null;
  nodeKeys.clear();
  encryptionSessions.clear();
  decryptionSessions.clear();
}

async function decryptShareContexts(
  contexts: VaultActiveShareContext[],
): Promise<Array<[string, { epoch: number; key: CryptoKey }]>> {
  const root = requireRootKey();
  const loadedEntries = await mapWithConcurrency(
    contexts,
    SHARE_SIDECAR_CRYPTO_CONCURRENCY,
    async (context) => {
      if (context.epoch < 1 || !/^shr_[A-Za-z0-9_-]+$/u.test(context.shareId)) {
        throw new Error("The server returned an invalid active share context.");
      }
      const wrapperId = fromBase64Url(context.wrapperId);
      if (wrapperId.length !== 16) {
        throw new Error("The owner share wrapper is invalid.");
      }
      const raw = await decryptDerivedRecord(
        root,
        wrapperId,
        shareOwnerPurpose(context.shareId, context.epoch),
        toBase64Url(wrapperId),
        context.epoch,
        fromBase64Url(context.ciphertext),
      );
      try {
        if (raw.length !== 32) {
          throw new Error("The share epoch key is invalid.");
        }
        return [
          context.shareId,
          { epoch: context.epoch, key: await importHkdf(raw) },
        ] as const;
      } finally {
        wipe(wrapperId, raw);
      }
    },
  );
  const loaded = new Map(loadedEntries);
  if (loaded.size !== contexts.length) {
    throw new Error("The active share context set contains duplicates.");
  }
  return Array.from(loaded);
}

async function startEncryption(
  input: VaultEncryptionInput,
): Promise<VaultEncryptionStart> {
  const nodeId = input.nodeId ?? randomPrefixedId("fil_");
  validateNodeId(nodeId);
  const generationNumber = input.generationNumber ?? 1;
  const recordVersion = input.recordVersion ?? 1;
  const generationId = randomBytes(16);
  const previousRecordHash = input.previousRecordHash
    ? fromBase64Url(input.previousRecordHash)
    : null;
  if ((recordVersion === 1) !== (previousRecordHash === null)) {
    throw new Error("The node record chain is invalid.");
  }
  if (input.parentId && !nodeKeys.has(input.parentId)) {
    throw vaultError(
      "PARENT_KEY_REQUIRED",
      `Unlock the parent folder first:${input.parentId}`,
    );
  }

  const nodeMaterial = randomBytes(32);
  const nodeKey = await importHkdf(nodeMaterial);
  const paddedBytes =
    input.entryType === "file" ? padmeLength(input.plaintextBytes) : 0;
  const layout =
    input.entryType === "file"
      ? encryptedLength(paddedBytes)
      : { chunkCount: 0, ciphertextBytes: 0 };
  const contentKey =
    input.entryType === "file"
      ? await deriveAesKey(
          nodeKey,
          generationId,
          `aeralyth/content/v1/${nodeId}/${generationNumber}`,
        )
      : null;
  const wrapperId = randomBytes(16);
  const wrapperKind = input.parentId ? 2 : 1;
  const wrappingKey = input.parentId
    ? (nodeKeys.get(input.parentId) ?? null)
    : requireRootKey();
  if (!wrappingKey) {
    wipe(nodeMaterial, generationId, wrapperId, previousRecordHash);
    throw vaultError("PARENT_KEY_REQUIRED", "The parent folder is locked.");
  }
  const wrapperPurpose = nodeWrapperPurpose(wrapperKind, nodeId);
  const wrapperCiphertext = await encryptDerivedRecord(
    wrappingKey,
    wrapperId,
    wrapperPurpose,
    toBase64Url(wrapperId),
    recordVersion,
    nodeMaterial,
  );
  const ownerWrapper = encodeWrapper({
    formatVersion: VAULT_FORMAT_VERSION,
    wrapperId,
    kind: wrapperKind,
    nodeId,
    parentNodeId: input.parentId,
    generationId: null,
    shareId: null,
    epoch: null,
    recordVersion,
    ciphertext: wrapperCiphertext,
    aadSchemaId: VAULT_AAD_SCHEMA_ID,
  });
  const manifest: VaultManifest = {
    name: normalizeName(input.name),
    mimeType: input.mimeType?.slice(0, 255) || null,
    entryType: input.entryType,
    plaintextBytes: input.entryType === "file" ? input.plaintextBytes : 0,
    paddedBytes,
    lastModified: Math.max(0, Math.trunc(input.lastModified)),
    parentId: input.parentId,
    chunkCount: layout.chunkCount,
    generationId: new Uint8Array(generationId),
    createdAt: Date.now(),
  };
  const sessionId = randomPrefixedId("ves_");
  encryptionSessions.set(sessionId, {
    id: sessionId,
    nodeId,
    parentId: input.parentId,
    nodeKey,
    contentKey,
    generationNumber,
    generationId,
    recordVersion,
    previousRecordHash,
    manifest,
    ciphertextLength: layout.ciphertextBytes,
    chunkCount: layout.chunkCount,
    encryptedChunks: 0,
    consumedPlaintext: 0,
    leaves: [],
    ownerWrapper,
  });
  nodeKeys.set(nodeId, nodeKey);
  wipe(nodeMaterial);

  return {
    sessionId,
    nodeId,
    generationNumber,
    generationId: toBase64Url(generationId),
    recordVersion,
    paddedBytes,
    ciphertextLength: layout.ciphertextBytes,
    chunkCount: layout.chunkCount,
  };
}

async function encryptChunk(
  sessionId: string,
  chunkIndex: number,
  plaintext: Uint8Array,
): Promise<VaultEncryptedChunk> {
  const session = requireEncryptionSession(sessionId);
  if (
    !session.contentKey ||
    chunkIndex !== session.encryptedChunks ||
    chunkIndex >= session.chunkCount
  ) {
    wipe(plaintext);
    throw new Error(
      "Encryption chunks must be submitted exactly once and in order.",
    );
  }
  const expectedPaddedLength = Math.min(
    VAULT_CRYPTO_CHUNK_BYTES,
    session.manifest.paddedBytes - chunkIndex * VAULT_CRYPTO_CHUNK_BYTES,
  );
  const remainingPlaintext =
    session.manifest.plaintextBytes - session.consumedPlaintext;
  const expectedSourceLength = Math.min(
    expectedPaddedLength,
    Math.max(0, remainingPlaintext),
  );
  if (plaintext.length !== expectedSourceLength) {
    wipe(plaintext);
    throw new Error("The plaintext chunk has an unexpected length.");
  }
  const padded = new Uint8Array(expectedPaddedLength);
  padded.set(plaintext);
  if (expectedSourceLength < expectedPaddedLength) {
    crypto.getRandomValues(padded.subarray(expectedSourceLength));
  }
  const aad = encodeChunkAad({
    nodeId: session.nodeId,
    generationNumber: session.generationNumber,
    generationId: session.generationId,
    chunkIndex,
    plaintextLength: expectedPaddedLength,
  });
  try {
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(chunkNonce(chunkIndex)),
          additionalData: toArrayBuffer(aad),
          tagLength: 128,
        },
        session.contentKey,
        toArrayBuffer(padded),
      ),
    );
    session.leaves.push(await ciphertextLeafHash(chunkIndex, ciphertext));
    session.encryptedChunks += 1;
    session.consumedPlaintext += plaintext.length;
    return {
      ciphertext: ciphertext.buffer,
      ciphertextBytes: ciphertext.length,
    };
  } finally {
    wipe(plaintext, padded, aad);
  }
}

async function finalizeEncryption(
  sessionId: string,
): Promise<VaultEncryptionComplete> {
  const session = requireEncryptionSession(sessionId);
  const activeIdentity = requireIdentity();
  if (
    session.encryptedChunks !== session.chunkCount ||
    session.consumedPlaintext !== session.manifest.plaintextBytes
  ) {
    throw new Error("Not all plaintext chunks were encrypted.");
  }

  const manifestPlaintext = encodeManifest(session.manifest);
  const manifestKey = await deriveAesKey(
    session.nodeKey,
    session.generationId,
    `aeralyth/manifest/v1/${session.nodeId}/${session.recordVersion}`,
  );
  const manifestAad = encodeRecordAad(
    "manifest",
    session.nodeId,
    session.recordVersion,
  );
  const encryptedManifest = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(zeroNonce()),
        additionalData: toArrayBuffer(manifestAad),
        tagLength: 128,
      },
      manifestKey,
      toArrayBuffer(manifestPlaintext),
    ),
  );
  const canonicalWrappers = [session.ownerWrapper];
  const decodedWrappers = canonicalWrappers.map(decodeWrapper);
  const wrapperHashes = await Promise.all(canonicalWrappers.map(sha256));
  const bootstrap: VaultBootstrapRecord = {
    formatVersion: VAULT_FORMAT_VERSION,
    suiteId: VAULT_SUITE_ID,
    aadSchemaId: VAULT_AAD_SCHEMA_ID,
    nodeId: session.nodeId,
    generationNumber: session.generationNumber,
    generationId: session.generationId,
    manifestIv: zeroNonce(),
    wrapperIds: decodedWrappers.map((wrapper) => wrapper.wrapperId),
    ciphertextLength: session.ciphertextLength,
    signerKeyVersion: activeIdentity.keyVersion,
    recordVersion: session.recordVersion,
    previousRecordHash: session.previousRecordHash,
    manifestHash: await sha256(encryptedManifest),
    wrapperHashes,
    ciphertextMerkleRoot: await merkleRootFromLeaves(session.leaves),
  };
  const bootstrapCbor = encodeBootstrap(bootstrap);
  const signature = sodium.crypto_sign_detached(
    bootstrapCbor,
    activeIdentity.ed25519PrivateKey,
  );
  const complete: VaultEncryptionComplete = {
    nodeId: session.nodeId,
    generationNumber: session.generationNumber,
    generationId: toBase64Url(session.generationId),
    recordVersion: session.recordVersion,
    ciphertextLength: session.ciphertextLength,
    chunkCount: session.chunkCount,
    record: {
      bootstrapCbor: toBase64Url(bootstrapCbor),
      bootstrapSignature: toBase64Url(signature),
      encryptedManifest: toBase64Url(encryptedManifest),
      wrappers: canonicalWrappers.map(toBase64Url),
    },
  };
  encryptionSessions.delete(sessionId);
  wipe(
    manifestPlaintext,
    manifestAad,
    encryptedManifest,
    ...wrapperHashes,
    bootstrapCbor,
    signature,
    ...session.leaves,
  );
  return complete;
}

async function createShareDirectory(
  input: VaultShareDirectoryInput,
): Promise<VaultShareDirectoryResult> {
  const activeIdentity = requireIdentity();
  const nodeKey = nodeKeys.get(input.nodeId);
  if (!nodeKey) {
    throw vaultError(
      "NODE_KEY_REQUIRED",
      `Unlock the node before synchronizing its share directory:${input.nodeId}`,
    );
  }
  if (
    input.shareContexts.length < 1 ||
    input.shareContexts.length > 4096 ||
    !Number.isSafeInteger(input.recordVersion) ||
    input.recordVersion < 1 ||
    !Number.isSafeInteger(input.generationNumber) ||
    input.generationNumber < 1
  ) {
    throw new Error("The share-directory request is invalid.");
  }
  const generationId = fromBase64Url(input.generationId);
  const recordHash = fromBase64Url(input.recordHash);
  if (generationId.length !== 16 || recordHash.length !== 32) {
    throw new Error("The share-directory record binding is invalid.");
  }
  const contexts = await decryptShareContexts(input.shareContexts);
  const wrappersByShare = await mapWithConcurrency(
    contexts,
    SHARE_SIDECAR_CRYPTO_CONCURRENCY,
    async ([shareId, value]) => {
      const context = { shareId, epoch: value.epoch, epochKey: value.key };
      const metadata = createShareWrapperFromNode(
        input.nodeId,
        input.recordVersion,
        input.generationNumber,
        generationId,
        nodeKey,
        context,
        4,
      );
      if (input.entryType === "folder") return [await metadata];
      return Promise.all([
        metadata,
        createShareWrapperFromNode(
          input.nodeId,
          input.recordVersion,
          input.generationNumber,
          generationId,
          nodeKey,
          context,
          3,
        ),
      ]);
    },
  );
  const wrappers = wrappersByShare.flat();
  const wrapperHashes = await mapWithConcurrency(
    wrappers,
    SHARE_SIDECAR_CRYPTO_CONCURRENCY,
    sha256,
  );
  const wrapperRoot = await wrapperSetRoot(wrapperHashes);
  const directory: VaultShareDirectoryRecord = {
    formatVersion: VAULT_SHARE_DIRECTORY_VERSION,
    suiteId: VAULT_SUITE_ID,
    aadSchemaId: VAULT_AAD_SCHEMA_ID,
    nodeId: input.nodeId,
    recordVersion: input.recordVersion,
    recordHash,
    generationNumber: input.generationNumber,
    generationId,
    signerKeyVersion: activeIdentity.keyVersion,
    wrapperSetRoot: wrapperRoot,
    wrapperCount: wrappers.length,
  };
  const canonical = encodeShareDirectory(directory);
  const signature = sodium.crypto_sign_detached(
    canonical,
    activeIdentity.ed25519PrivateKey,
  );
  const result = {
    directoryCbor: toBase64Url(canonical),
    directorySignature: toBase64Url(signature),
    wrappers: wrappers.map(toBase64Url),
  };
  wipe(
    generationId,
    recordHash,
    wrapperRoot,
    canonical,
    signature,
    ...wrapperHashes,
    ...wrappers,
  );
  return result;
}

async function openPlan(plan: VaultDownloadPlan): Promise<VaultOpenPlanResult> {
  const { manifest } = await openAndVerifyPlan(plan);
  return { manifest };
}

async function startDecryption(
  plan: VaultDownloadPlan,
): Promise<VaultDecryptionStart> {
  const opened = await openAndVerifyPlan(plan);
  if (opened.manifest.entryType !== "file") {
    throw new Error("Folders do not have encrypted content streams.");
  }
  const contentKey =
    opened.contentKey ??
    (opened.nodeKey
      ? await deriveAesKey(
          opened.nodeKey,
          opened.manifest.generationId,
          `aeralyth/content/v1/${plan.nodeId}/${plan.generationNumber}`,
        )
      : null);
  if (!contentKey) throw new Error("The shared generation key is unavailable.");
  const sessionId = randomPrefixedId("vds_");
  decryptionSessions.set(sessionId, {
    id: sessionId,
    nodeId: plan.nodeId,
    contentKey,
    generationNumber: plan.generationNumber,
    generationId: opened.manifest.generationId,
    manifest: opened.manifest,
    ciphertextLength: plan.ciphertextLength,
    chunkCount: plan.chunkCount,
    decryptedChunks: 0,
    leaves: [],
    expectedMerkleRoot: fromBase64Url(plan.ciphertextMerkleRoot),
  });
  return { sessionId, manifest: opened.manifest };
}

async function decryptChunk(
  sessionId: string,
  chunkIndex: number,
  ciphertext: Uint8Array,
): Promise<VaultDecryptedChunk> {
  const session = decryptionSessions.get(sessionId);
  if (
    !session ||
    chunkIndex !== session.decryptedChunks ||
    chunkIndex >= session.chunkCount
  ) {
    wipe(ciphertext);
    throw new Error(
      "Ciphertext chunks must be submitted exactly once and in order.",
    );
  }
  const expectedPlaintextLength = Math.min(
    VAULT_CRYPTO_CHUNK_BYTES,
    session.manifest.paddedBytes - chunkIndex * VAULT_CRYPTO_CHUNK_BYTES,
  );
  if (ciphertext.length !== expectedPlaintextLength + 16) {
    wipe(ciphertext);
    throw new Error("The ciphertext chunk has an invalid length.");
  }
  session.leaves.push(await ciphertextLeafHash(chunkIndex, ciphertext));
  const aad = encodeChunkAad({
    nodeId: session.nodeId,
    generationNumber: session.generationNumber,
    generationId: session.generationId,
    chunkIndex,
    plaintextLength: expectedPlaintextLength,
  });
  try {
    const padded = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(chunkNonce(chunkIndex)),
          additionalData: toArrayBuffer(aad),
          tagLength: 128,
        },
        session.contentKey,
        toArrayBuffer(ciphertext),
      ),
    );
    const offset = chunkIndex * VAULT_CRYPTO_CHUNK_BYTES;
    const usefulLength = Math.max(
      0,
      Math.min(padded.length, session.manifest.plaintextBytes - offset),
    );
    const plaintext = padded.slice(0, usefulLength);
    wipe(padded);
    session.decryptedChunks += 1;
    return { plaintext: plaintext.buffer, plaintextBytes: plaintext.length };
  } catch (error) {
    decryptionSessions.delete(sessionId);
    throw vaultError(
      "AUTHENTICATION_FAILED",
      "Encrypted file authentication failed.",
      error,
    );
  } finally {
    wipe(ciphertext, aad);
  }
}

async function finalizeDecryption(sessionId: string): Promise<void> {
  const session = decryptionSessions.get(sessionId);
  if (!session || session.decryptedChunks !== session.chunkCount) {
    throw new Error("Not all ciphertext chunks were decrypted.");
  }
  const actualRoot = await merkleRootFromLeaves(session.leaves);
  decryptionSessions.delete(sessionId);
  if (!equalBytes(actualRoot, session.expectedMerkleRoot)) {
    wipe(actualRoot, session.expectedMerkleRoot, ...session.leaves);
    throw vaultError(
      "AUTHENTICATION_FAILED",
      "The encrypted file Merkle root is invalid.",
    );
  }
  wipe(actualRoot, session.expectedMerkleRoot, ...session.leaves);
}

async function openAndVerifyPlan(plan: VaultDownloadPlan): Promise<OpenedPlan> {
  requireRootKey();
  const bootstrapBytes = fromBase64Url(plan.bootstrapCbor);
  const signature = fromBase64Url(plan.bootstrapSignature);
  const bootstrap = decodeBootstrap(bootstrapBytes);
  const publicKey = fromBase64Url(plan.signerEd25519PublicKey);
  if (
    !sodium.crypto_sign_verify_detached(signature, bootstrapBytes, publicKey)
  ) {
    throw vaultError(
      "AUTHENTICATION_FAILED",
      "The node record signature is invalid.",
    );
  }
  const signedHash = await sha256(concatBytes(bootstrapBytes, signature));
  if (
    bootstrap.formatVersion !== VAULT_FORMAT_VERSION ||
    bootstrap.suiteId !== VAULT_SUITE_ID ||
    bootstrap.aadSchemaId !== VAULT_AAD_SCHEMA_ID ||
    bootstrap.nodeId !== plan.nodeId ||
    bootstrap.generationNumber !== plan.generationNumber ||
    bootstrap.recordVersion !== plan.recordVersion ||
    bootstrap.ciphertextLength !== plan.ciphertextLength ||
    bootstrap.signerKeyVersion !== plan.signerKeyVersion ||
    plan.cryptoChunkBytes !== VAULT_CRYPTO_CHUNK_BYTES ||
    (bootstrap.recordVersion === 1) !==
      (bootstrap.previousRecordHash === null) ||
    !equalBytes(bootstrap.manifestIv, zeroNonce()) ||
    !equalBytes(bootstrap.generationId, fromBase64Url(plan.generationId)) ||
    !equalBytes(
      bootstrap.ciphertextMerkleRoot,
      fromBase64Url(plan.ciphertextMerkleRoot),
    ) ||
    !equalBytes(signedHash, fromBase64Url(plan.recordHash))
  ) {
    throw vaultError(
      "AUTHENTICATION_FAILED",
      "The node record head is inconsistent.",
    );
  }
  const encryptedManifest = fromBase64Url(plan.encryptedManifest);
  if (!equalBytes(await sha256(encryptedManifest), bootstrap.manifestHash)) {
    throw vaultError(
      "AUTHENTICATION_FAILED",
      "The encrypted manifest commitment is invalid.",
    );
  }
  const wrapperBytes = plan.wrappers.map(fromBase64Url);
  const wrappers: VaultWrapperRecord[] = [];
  for (let index = 0; index < wrapperBytes.length; index += 1) {
    const wrapper = decodeWrapper(wrapperBytes[index]);
    wrappers.push(wrapper);
  }

  let nodeKey: CryptoKey | null = null;
  let manifestKey: CryptoKey | null = null;
  let contentKey: CryptoKey | null = null;
  if (plan.share) {
    const shared = await openSharedKeys(plan, wrappers, wrapperBytes);
    manifestKey = shared.manifestKey;
    contentKey = shared.contentKey;
  } else {
    if (
      wrapperBytes.length !== bootstrap.wrapperIds.length ||
      wrapperBytes.length !== bootstrap.wrapperHashes.length
    ) {
      throw vaultError(
        "AUTHENTICATION_FAILED",
        "The wrapper commitment count is invalid.",
      );
    }
    const computedWrapperHashes = await mapWithConcurrency(
      wrapperBytes,
      SHARE_HASH_CRYPTO_CONCURRENCY,
      sha256,
    );
    for (let index = 0; index < wrappers.length; index += 1) {
      const wrapper = wrappers[index];
      if (
        wrapper.nodeId !== plan.nodeId ||
        wrapper.recordVersion !== plan.recordVersion ||
        !equalBytes(wrapper.wrapperId, bootstrap.wrapperIds[index]) ||
        !equalBytes(
          computedWrapperHashes[index],
          bootstrap.wrapperHashes[index],
        )
      ) {
        throw vaultError(
          "AUTHENTICATION_FAILED",
          "A node-key wrapper commitment is invalid.",
        );
      }
    }
    nodeKey = nodeKeys.get(plan.nodeId) ?? null;
  }
  if (!plan.share && !nodeKey) {
    const ownerWrapper = wrappers.find(
      (wrapper) => wrapper.kind === 1 || wrapper.kind === 2,
    );
    if (!ownerWrapper) {
      throw vaultError(
        "AUTHENTICATION_FAILED",
        "No owner node-key wrapper is available.",
      );
    }
    const wrappingKey =
      ownerWrapper.kind === 1
        ? requireRootKey()
        : ownerWrapper.parentNodeId
          ? (nodeKeys.get(ownerWrapper.parentNodeId) ?? null)
          : null;
    if (!wrappingKey) {
      throw vaultError(
        "PARENT_KEY_REQUIRED",
        `Unlock the parent folder first:${ownerWrapper.parentNodeId ?? ""}`,
      );
    }
    const purpose = nodeWrapperPurpose(ownerWrapper.kind, ownerWrapper.nodeId);
    const raw = await decryptDerivedRecord(
      wrappingKey,
      ownerWrapper.wrapperId,
      purpose,
      toBase64Url(ownerWrapper.wrapperId),
      ownerWrapper.recordVersion,
      ownerWrapper.ciphertext,
    );
    try {
      if (raw.length !== 32)
        throw new Error("The node key has an invalid length.");
      nodeKey = await importHkdf(raw);
      nodeKeys.set(plan.nodeId, nodeKey);
    } finally {
      wipe(raw);
    }
  }
  if (!plan.share) {
    if (!nodeKey) throw new Error("The owner node key is unavailable.");
    manifestKey = await deriveAesKey(
      nodeKey,
      bootstrap.generationId,
      `aeralyth/manifest/v1/${plan.nodeId}/${plan.recordVersion}`,
    );
  }
  if (!manifestKey) throw new Error("The manifest key is unavailable.");
  const manifestAad = encodeRecordAad(
    "manifest",
    plan.nodeId,
    plan.recordVersion,
  );
  let manifestPlaintext: Uint8Array;
  try {
    manifestPlaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(zeroNonce()),
          additionalData: toArrayBuffer(manifestAad),
          tagLength: 128,
        },
        manifestKey,
        toArrayBuffer(encryptedManifest),
      ),
    );
  } catch (error) {
    throw vaultError(
      "AUTHENTICATION_FAILED",
      "The encrypted manifest is invalid.",
      error,
    );
  }
  const manifest = decodeManifest(manifestPlaintext);
  const validManifestLayout =
    manifest.entryType === "folder"
      ? manifest.plaintextBytes === 0 &&
        manifest.paddedBytes === 0 &&
        manifest.chunkCount === 0 &&
        plan.ciphertextLength === 0
      : validFileManifestLayout(manifest, plan.ciphertextLength);
  if (
    manifest.entryType !== plan.entryType ||
    manifest.chunkCount !== plan.chunkCount ||
    !validManifestLayout ||
    !equalBytes(manifest.generationId, bootstrap.generationId)
  ) {
    throw vaultError(
      "AUTHENTICATION_FAILED",
      "The manifest does not match the node head.",
    );
  }
  wipe(
    bootstrapBytes,
    signature,
    publicKey,
    signedHash,
    encryptedManifest,
    manifestAad,
    manifestPlaintext,
    ...wrapperBytes,
  );
  return { manifest, nodeKey, contentKey };
}

async function createShareMaterial(
  input: VaultShareMaterialInput,
): Promise<VaultShareMaterialResult> {
  await validateShareIdentity(input.recipient);
  return buildShareMaterial({
    shareId: input.shareId,
    rootNodeId: input.rootNodeId,
    senderId: input.senderId,
    epoch: 1,
    recordVersion: 1,
    previousRecordHash: null,
    recipients: [
      {
        userId: input.recipient.userId,
        keyVersion: input.recipient.keyVersion,
        x25519PublicKey: input.recipient.x25519PublicKey,
      },
    ],
    nodes: input.nodes,
  });
}

async function rotateShareMaterial(
  input: VaultShareRotationInput,
): Promise<VaultShareMaterialResult> {
  return buildShareMaterial({
    ...input,
    previousRecordHash: fromBase64Url(input.previousRecordHash),
  });
}

async function buildShareMaterial(input: {
  shareId: string;
  rootNodeId: string;
  senderId: string;
  epoch: number;
  recordVersion: number;
  previousRecordHash: Uint8Array | null;
  recipients: Array<{
    userId: string;
    keyVersion: number;
    x25519PublicKey: string;
  }>;
  nodes: VaultShareNodeSnapshot[];
}): Promise<VaultShareMaterialResult> {
  const root = requireRootKey();
  if (!/^shr_[A-Za-z0-9_-]{4,92}$/u.test(input.shareId) || input.epoch < 1) {
    throw new Error("The share ID or epoch is invalid.");
  }
  const epochMaterial = randomBytes(32);
  const epochKey = await importHkdf(epochMaterial);
  const wrapperId = randomBytes(16);
  try {
    const wrappers = await createSubtreeShareWrappers(
      input.nodes,
      input.shareId,
      input.epoch,
      epochKey,
    );
    const wrapperHashes = await mapWithConcurrency(
      wrappers,
      SHARE_HASH_CRYPTO_CONCURRENCY,
      sha256,
    );
    const wrapperRoot = await wrapperSetRoot(wrapperHashes);
    const envelopes = await mapWithConcurrency(
      input.recipients,
      SHARE_ENVELOPE_CRYPTO_CONCURRENCY,
      (recipient) =>
        createHpkeEnvelope({
          shareId: input.shareId,
          rootNodeId: input.rootNodeId,
          senderId: input.senderId,
          epoch: input.epoch,
          recordVersion: input.recordVersion,
          previousRecordHash: input.previousRecordHash,
          recipient,
          wrapperSetRoot: wrapperRoot,
          wrapperCount: wrapperHashes.length,
          epochMaterial,
        }),
    );
    const ownerCiphertext = await encryptDerivedRecord(
      root,
      wrapperId,
      shareOwnerPurpose(input.shareId, input.epoch),
      toBase64Url(wrapperId),
      input.epoch,
      epochMaterial,
    );
    return {
      wrappers: wrappers.map(toBase64Url),
      envelopes,
      ownerEpochKey: {
        wrapperId: toBase64Url(wrapperId),
        ciphertext: toBase64Url(ownerCiphertext),
      },
    };
  } finally {
    wipe(epochMaterial, wrapperId);
  }
}

async function createSubtreeShareWrappers(
  nodes: VaultShareNodeSnapshot[],
  shareId: string,
  epoch: number,
  epochKey: CryptoKey,
): Promise<Uint8Array[]> {
  const ordered = [...nodes].sort((left, right) =>
    left.nodeId.localeCompare(right.nodeId),
  );
  const tasks: Array<{
    node: VaultShareNodeSnapshot;
    nodeKey: CryptoKey;
    generationId: Uint8Array;
    kind: 3 | 4;
  }> = [];
  for (const node of ordered) {
    const nodeKey = nodeKeys.get(node.nodeId);
    if (!nodeKey) {
      throw vaultError(
        "NODE_KEY_REQUIRED",
        `Unlock every node in the shared subtree first:${node.nodeId}`,
      );
    }
    const generationId = node.generationId
      ? fromBase64Url(node.generationId)
      : new Uint8Array(16);
    if (generationId.length !== 16) {
      throw new Error("A share generation ID is invalid.");
    }
    tasks.push({ node, nodeKey, generationId, kind: 4 });
    if (node.entryType === "file") {
      tasks.push({ node, nodeKey, generationId, kind: 3 });
    }
  }
  const context = { shareId, epoch, epochKey };
  return mapWithConcurrency(
    tasks,
    SHARE_WRAPPER_CRYPTO_CONCURRENCY,
    ({ node, nodeKey, generationId, kind }) =>
      createShareWrapperFromNode(
        node.nodeId,
        node.recordVersion,
        node.generationNumber,
        generationId,
        nodeKey,
        context,
        kind,
      ),
  );
}

async function createShareWrapperFromNode(
  nodeId: string,
  recordVersion: number,
  generationNumber: number,
  generationId: Uint8Array,
  nodeKey: CryptoKey,
  context: { shareId: string; epoch: number; epochKey: CryptoKey },
  kind: 3 | 4,
): Promise<Uint8Array> {
  const keyMaterial = await deriveKeyMaterial(
    nodeKey,
    generationId,
    kind === 3
      ? `aeralyth/content/v1/${nodeId}/${generationNumber}`
      : `aeralyth/manifest/v1/${nodeId}/${recordVersion}`,
  );
  const wrapperId = randomBytes(16);
  try {
    const purpose = shareWrapperPurpose(
      context.shareId,
      context.epoch,
      nodeId,
      kind,
    );
    const ciphertext = await encryptDerivedRecord(
      context.epochKey,
      wrapperId,
      purpose,
      toBase64Url(wrapperId),
      recordVersion,
      keyMaterial,
    );
    return encodeWrapper({
      formatVersion: VAULT_FORMAT_VERSION,
      wrapperId,
      kind,
      nodeId,
      parentNodeId: null,
      generationId: kind === 3 ? generationId : null,
      shareId: context.shareId,
      epoch: context.epoch,
      recordVersion,
      ciphertext,
      aadSchemaId: VAULT_AAD_SCHEMA_ID,
    });
  } finally {
    wipe(keyMaterial, wrapperId);
  }
}

async function createHpkeEnvelope(input: {
  shareId: string;
  rootNodeId: string;
  senderId: string;
  epoch: number;
  recordVersion: number;
  previousRecordHash: Uint8Array | null;
  recipient: { userId: string; keyVersion: number; x25519PublicKey: string };
  wrapperSetRoot: Uint8Array;
  wrapperCount: number;
  epochMaterial: Uint8Array;
}): Promise<{ canonicalCbor: string; signature: string }> {
  const activeIdentity = requireIdentity();
  const envelopeId = randomBytes(16);
  const [recipientPublic, senderPrivate] = await Promise.all([
    hpkeSuite.kem.importKey(
      "raw",
      toArrayBuffer(fromBase64Url(input.recipient.x25519PublicKey)),
      true,
    ),
    hpkeSuite.kem.importKey(
      "raw",
      toArrayBuffer(activeIdentity.x25519PrivateKey),
      false,
    ),
  ]);
  const info = hpkeInfo(
    input.shareId,
    input.epoch,
    input.rootNodeId,
    envelopeId,
  );
  const aad = encodeRecordAad(
    `share-envelope-${input.shareId}-${input.epoch}`,
    toBase64Url(envelopeId),
    input.recordVersion,
  );
  const sender = await hpkeSuite.createSenderContext({
    recipientPublicKey: recipientPublic,
    senderKey: senderPrivate,
    info: toArrayBuffer(info),
  });
  const ciphertext = new Uint8Array(
    await sender.seal(toArrayBuffer(input.epochMaterial), toArrayBuffer(aad)),
  );
  const encapsulatedKey = new Uint8Array(sender.enc);
  if (encapsulatedKey.length !== 32 || ciphertext.length !== 48) {
    throw new Error("The HPKE suite returned invalid envelope material.");
  }
  const envelope: VaultShareEnvelopeRecord = {
    formatVersion: VAULT_SHARE_ENVELOPE_VERSION,
    suiteId: VAULT_SUITE_ID,
    envelopeId,
    shareId: input.shareId,
    epoch: input.epoch,
    senderId: input.senderId,
    senderKeyVersion: activeIdentity.keyVersion,
    recipientId: input.recipient.userId,
    recipientKeyVersion: input.recipient.keyVersion,
    nodeId: input.rootNodeId,
    permissions: 1,
    generationScope: null,
    recordVersion: input.recordVersion,
    previousRecordHash: input.previousRecordHash,
    encapsulatedKey,
    ciphertext,
    aadSchemaId: VAULT_AAD_SCHEMA_ID,
    wrapperHashes: [],
    wrapperSetRoot: input.wrapperSetRoot,
    wrapperCount: input.wrapperCount,
  };
  const canonical = encodeShareEnvelope(envelope);
  const signature = sodium.crypto_sign_detached(
    canonical,
    activeIdentity.ed25519PrivateKey,
  );
  wipe(envelopeId, info, aad, encapsulatedKey, ciphertext);
  return {
    canonicalCbor: toBase64Url(canonical),
    signature: toBase64Url(signature),
  };
}

async function openSharedKeys(
  plan: VaultDownloadPlan,
  wrappers: VaultWrapperRecord[],
  wrapperBytes: Uint8Array[],
): Promise<{ manifestKey: CryptoKey; contentKey: CryptoKey | null }> {
  const share = plan.share;
  const activeIdentity = requireIdentity();
  if (!share) throw new Error("Shared key material is missing.");
  const envelopeBytes = fromBase64Url(share.envelopeCbor);
  const envelopeSignature = fromBase64Url(share.envelopeSignature);
  const senderEd25519 = fromBase64Url(share.senderEd25519PublicKey);
  if (
    !sodium.crypto_sign_verify_detached(
      envelopeSignature,
      envelopeBytes,
      senderEd25519,
    )
  ) {
    throw vaultError(
      "AUTHENTICATION_FAILED",
      "The share envelope signature is invalid.",
    );
  }
  const envelope = decodeShareEnvelope(envelopeBytes);
  const senderX25519 = fromBase64Url(share.senderX25519PublicKey);
  const [envelopeHash, senderFingerprint] = await Promise.all([
    sha256(concatBytes(envelopeBytes, envelopeSignature)),
    sha256(concatBytes(senderX25519, senderEd25519)),
  ]);
  const expectedPreviousRecordHash = share.previousRecordHash
    ? fromBase64Url(share.previousRecordHash)
    : null;
  if (
    !equalBytes(envelopeHash, fromBase64Url(share.envelopeHash)) ||
    (envelope.formatVersion !== VAULT_FORMAT_VERSION &&
      envelope.formatVersion !== VAULT_SHARE_ENVELOPE_VERSION) ||
    envelope.shareId !== share.shareId ||
    envelope.epoch !== share.epoch ||
    envelope.senderId !== share.senderId ||
    envelope.recipientId !== share.recipientId ||
    envelope.nodeId !== share.rootNodeId ||
    envelope.senderKeyVersion !== share.senderKeyVersion ||
    envelope.recipientKeyVersion !== activeIdentity.keyVersion ||
    envelope.recipientKeyVersion !== share.recipientKeyVersion ||
    envelope.recordVersion !== share.recordVersion ||
    envelope.generationScope !== null ||
    !nullableEqualBytes(
      envelope.previousRecordHash,
      expectedPreviousRecordHash,
    ) ||
    !equalBytes(
      senderFingerprint,
      fromBase64Url(share.senderFingerprintSha256),
    ) ||
    envelope.aadSchemaId !== VAULT_AAD_SCHEMA_ID ||
    envelope.suiteId !== VAULT_SUITE_ID
  ) {
    throw vaultError(
      "AUTHENTICATION_FAILED",
      "The share envelope scope is invalid.",
    );
  }
  const bootstrap = decodeBootstrap(fromBase64Url(plan.bootstrapCbor));
  const bootstrapCommitments = new Set(
    bootstrap.wrapperHashes.map(toBase64Url),
  );
  const legacyCommitments = new Set(envelope.wrapperHashes.map(toBase64Url));
  const wrapperProofs = share.wrapperProofs ?? [];
  if (
    envelope.formatVersion === VAULT_SHARE_ENVELOPE_VERSION &&
    (envelope.wrapperSetRoot === null ||
      envelope.wrapperCount < 1 ||
      wrapperProofs.length !== wrapperBytes.length)
  ) {
    throw vaultError(
      "AUTHENTICATION_FAILED",
      "The share wrapper commitment is invalid.",
    );
  }
  const directoryMaterial = share.directory;
  const directory = directoryMaterial
    ? decodeShareDirectory(fromBase64Url(directoryMaterial.canonicalCbor))
    : null;
  if (directory && directoryMaterial) {
    const directoryCbor = fromBase64Url(directoryMaterial.canonicalCbor);
    const directorySignature = fromBase64Url(directoryMaterial.signature);
    if (
      !sodium.crypto_sign_verify_detached(
        directorySignature,
        directoryCbor,
        fromBase64Url(plan.signerEd25519PublicKey),
      ) ||
      directory.formatVersion !== VAULT_SHARE_DIRECTORY_VERSION ||
      directory.suiteId !== VAULT_SUITE_ID ||
      directory.aadSchemaId !== VAULT_AAD_SCHEMA_ID ||
      directory.nodeId !== plan.nodeId ||
      directory.recordVersion !== plan.recordVersion ||
      directory.generationNumber !== plan.generationNumber ||
      directory.signerKeyVersion !== plan.signerKeyVersion ||
      directory.wrapperCount < wrapperBytes.length ||
      directoryMaterial.wrapperProofs.length !== wrapperBytes.length ||
      !equalBytes(directory.recordHash, fromBase64Url(plan.recordHash)) ||
      !equalBytes(directory.generationId, fromBase64Url(plan.generationId))
    ) {
      throw vaultError(
        "AUTHENTICATION_FAILED",
        "The share-wrapper directory is invalid.",
      );
    }
  }
  const seenWrapperHashes = new Set<string>();
  const receivedWrapperHashes = await mapWithConcurrency(
    wrapperBytes,
    SHARE_HASH_CRYPTO_CONCURRENCY,
    sha256,
  );
  for (let index = 0; index < receivedWrapperHashes.length; index += 1) {
    const hashBytes = receivedWrapperHashes[index];
    const hash = toBase64Url(hashBytes);
    let committed = bootstrapCommitments.has(hash);
    if (!committed && envelope.formatVersion === VAULT_FORMAT_VERSION) {
      committed = legacyCommitments.has(hash);
    }
    if (!committed && envelope.formatVersion === VAULT_SHARE_ENVELOPE_VERSION) {
      const proof = wrapperProofs[index];
      committed =
        proof !== null &&
        (await verifyWrapperSetProof({
          wrapperHash: hashBytes,
          leafIndex: proof.leafIndex,
          proof: fromBase64Url(proof.proof),
          wrapperCount: envelope.wrapperCount,
          expectedRoot: envelope.wrapperSetRoot as Uint8Array,
        }));
    }
    if (!committed && directory && directoryMaterial) {
      const proof = directoryMaterial.wrapperProofs[index];
      committed = await verifyWrapperSetProof({
        wrapperHash: hashBytes,
        leafIndex: proof.leafIndex,
        proof: fromBase64Url(proof.proof),
        wrapperCount: directory.wrapperCount,
        expectedRoot: directory.wrapperSetRoot,
      });
    }
    if (!committed || seenWrapperHashes.has(hash)) {
      throw vaultError(
        "AUTHENTICATION_FAILED",
        "A share wrapper is not committed.",
      );
    }
    seenWrapperHashes.add(hash);
  }
  if (wrappers.length !== (plan.entryType === "file" ? 2 : 1)) {
    throw vaultError(
      "AUTHENTICATION_FAILED",
      "The share wrapper count is invalid.",
    );
  }
  for (const wrapper of wrappers) {
    if (
      (wrapper.kind !== 3 && wrapper.kind !== 4) ||
      wrapper.formatVersion !== VAULT_FORMAT_VERSION ||
      wrapper.aadSchemaId !== VAULT_AAD_SCHEMA_ID ||
      wrapper.nodeId !== plan.nodeId ||
      wrapper.shareId !== share.shareId ||
      wrapper.epoch !== share.epoch ||
      wrapper.recordVersion !== plan.recordVersion
    ) {
      throw vaultError(
        "AUTHENTICATION_FAILED",
        "A share wrapper has an invalid scope.",
      );
    }
  }
  const [recipientPrivate, senderPublic] = await Promise.all([
    hpkeSuite.kem.importKey(
      "raw",
      toArrayBuffer(activeIdentity.x25519PrivateKey),
      false,
    ),
    hpkeSuite.kem.importKey("raw", toArrayBuffer(senderX25519), true),
  ]);
  const info = hpkeInfo(
    envelope.shareId,
    envelope.epoch,
    envelope.nodeId,
    envelope.envelopeId,
  );
  const aad = encodeRecordAad(
    `share-envelope-${envelope.shareId}-${envelope.epoch}`,
    toBase64Url(envelope.envelopeId),
    envelope.recordVersion,
  );
  const recipient = await hpkeSuite.createRecipientContext({
    recipientKey: recipientPrivate,
    senderPublicKey: senderPublic,
    enc: toArrayBuffer(envelope.encapsulatedKey),
    info: toArrayBuffer(info),
  });
  const epochMaterial = new Uint8Array(
    await recipient.open(
      toArrayBuffer(envelope.ciphertext),
      toArrayBuffer(aad),
    ),
  );
  if (epochMaterial.length !== 32)
    throw new Error("The share epoch key is invalid.");
  const epochKey = await importHkdf(epochMaterial);
  const metadataWrapper = wrappers.find(
    (wrapper) =>
      wrapper.kind === 4 &&
      wrapper.nodeId === plan.nodeId &&
      wrapper.shareId === share.shareId &&
      wrapper.epoch === share.epoch,
  );
  const generationWrapper = wrappers.find(
    (wrapper) =>
      wrapper.kind === 3 &&
      wrapper.nodeId === plan.nodeId &&
      wrapper.shareId === share.shareId &&
      wrapper.epoch === share.epoch &&
      wrapper.generationId !== null &&
      equalBytes(wrapper.generationId, fromBase64Url(plan.generationId)),
  );
  if (!metadataWrapper || (plan.entryType === "file" && !generationWrapper)) {
    throw vaultError(
      "AUTHENTICATION_FAILED",
      "The share wrappers are incomplete.",
    );
  }
  const metadataRaw = await decryptShareWrapper(epochKey, metadataWrapper);
  const generationRaw = generationWrapper
    ? await decryptShareWrapper(epochKey, generationWrapper)
    : null;
  try {
    return {
      manifestKey: await importAesKey(metadataRaw),
      contentKey: generationRaw ? await importAesKey(generationRaw) : null,
    };
  } finally {
    wipe(
      envelopeBytes,
      envelopeSignature,
      senderEd25519,
      senderX25519,
      senderFingerprint,
      expectedPreviousRecordHash,
      envelopeHash,
      info,
      aad,
      epochMaterial,
      metadataRaw,
      generationRaw,
    );
  }
}

function nullableEqualBytes(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  if (left === null || right === null) return left === right;
  return equalBytes(left, right);
}

function validFileManifestLayout(
  manifest: VaultManifest,
  ciphertextLength: number,
): boolean {
  if (
    manifest.plaintextBytes < 0 ||
    manifest.plaintextBytes > manifest.paddedBytes
  ) {
    return false;
  }
  try {
    const layout = encryptedLength(manifest.paddedBytes);
    return (
      layout.chunkCount === manifest.chunkCount &&
      layout.ciphertextBytes === ciphertextLength
    );
  } catch {
    return false;
  }
}

async function decryptShareWrapper(
  epochKey: CryptoKey,
  wrapper: VaultWrapperRecord,
): Promise<Uint8Array> {
  if (wrapper.kind !== 3 && wrapper.kind !== 4) {
    throw new Error("The share wrapper kind is invalid.");
  }
  return decryptDerivedRecord(
    epochKey,
    wrapper.wrapperId,
    shareWrapperPurpose(
      wrapper.shareId ?? "",
      wrapper.epoch ?? 0,
      wrapper.nodeId,
      wrapper.kind,
    ),
    toBase64Url(wrapper.wrapperId),
    wrapper.recordVersion,
    wrapper.ciphertext,
  );
}

async function validateShareIdentity(
  recipient: VaultPublicIdentity,
): Promise<void> {
  const x25519 = fromBase64Url(recipient.x25519PublicKey);
  const ed25519 = fromBase64Url(recipient.ed25519PublicKey);
  if (x25519.length !== 32 || ed25519.length !== 32) {
    throw new Error("The recipient identity keys are invalid.");
  }
  const fingerprint = await sha256(concatBytes(x25519, ed25519));
  if (!equalBytes(fingerprint, fromBase64Url(recipient.fingerprintSha256))) {
    throw new Error("The recipient identity fingerprint is invalid.");
  }
  wipe(x25519, ed25519, fingerprint);
}

function hpkeInfo(
  shareId: string,
  epoch: number,
  rootNodeId: string,
  envelopeId: Uint8Array,
): Uint8Array {
  return utf8(
    `aeralyth/hpke-auth/v1/${shareId}/${epoch}/${rootNodeId}/${toBase64Url(envelopeId)}`,
  );
}

function shareOwnerPurpose(shareId: string, epoch: number): string {
  return `share-epoch-owner-${shareId}-${epoch}`;
}

function shareWrapperPurpose(
  shareId: string,
  epoch: number,
  nodeId: string,
  kind: 3 | 4,
): string {
  return `share-wrapper-${kind}-${shareId}-${epoch}-${nodeId}`;
}

function derivePasswordMaterial(
  password: string,
  salt: Uint8Array,
): Uint8Array {
  return sodium.crypto_pwhash(
    ARGON2ID_PROFILE.outputBytes,
    password,
    salt,
    ARGON2ID_PROFILE.operations,
    ARGON2ID_PROFILE.memoryBytes,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

async function importHkdf(material: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(material),
    "HKDF",
    false,
    ["deriveBits"],
  );
}

async function deriveAesKey(
  base: CryptoKey,
  salt: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  const material = await deriveKeyMaterial(base, salt, info);
  try {
    return await importAesKey(material);
  } finally {
    wipe(material);
  }
}

async function deriveKeyMaterial(
  base: CryptoKey,
  salt: Uint8Array,
  info: string,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: toArrayBuffer(salt),
        info: toArrayBuffer(utf8(info)),
      },
      base,
      256,
    ),
  );
}

async function importAesKey(material: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(material),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function wrapRootMaterial(
  rootMaterial: Uint8Array,
  wrappingBase: CryptoKey,
  purpose: string,
  derivationSalt: Uint8Array,
  wrapperId: Uint8Array,
  version: number,
): Promise<Uint8Array> {
  return encryptDerivedRecord(
    wrappingBase,
    derivationSalt,
    purpose,
    toBase64Url(wrapperId),
    version,
    rootMaterial,
  );
}

async function unwrapRootMaterial(
  ciphertext: Uint8Array,
  wrappingBase: CryptoKey,
  purpose: string,
  derivationSalt: Uint8Array,
  wrapperId: Uint8Array,
  version: number,
): Promise<Uint8Array> {
  return decryptDerivedRecord(
    wrappingBase,
    derivationSalt,
    purpose,
    toBase64Url(wrapperId),
    version,
    ciphertext,
  );
}

async function encryptRootRecord(
  root: CryptoKey,
  purpose: string,
  recordId: Uint8Array,
  version: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  return encryptDerivedRecord(
    root,
    recordId,
    purpose,
    toBase64Url(recordId),
    version,
    plaintext,
  );
}

async function decryptRootRecord(
  root: CryptoKey,
  purpose: string,
  recordId: Uint8Array,
  version: number,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  return decryptDerivedRecord(
    root,
    recordId,
    purpose,
    toBase64Url(recordId),
    version,
    ciphertext,
  );
}

async function encryptDerivedRecord(
  base: CryptoKey,
  salt: Uint8Array,
  purpose: string,
  recordId: string,
  version: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const key = await deriveAesKey(
    base,
    salt,
    `aeralyth/${purpose}/v1/${recordId}/${version}`,
  );
  const aad = encodeRecordAad(purpose, recordId, version);
  try {
    return new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(zeroNonce()),
          additionalData: toArrayBuffer(aad),
          tagLength: 128,
        },
        key,
        toArrayBuffer(plaintext),
      ),
    );
  } finally {
    wipe(aad);
  }
}

async function decryptDerivedRecord(
  base: CryptoKey,
  salt: Uint8Array,
  purpose: string,
  recordId: string,
  version: number,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const key = await deriveAesKey(
    base,
    salt,
    `aeralyth/${purpose}/v1/${recordId}/${version}`,
  );
  const aad = encodeRecordAad(purpose, recordId, version);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(zeroNonce()),
          additionalData: toArrayBuffer(aad),
          tagLength: 128,
        },
        key,
        toArrayBuffer(ciphertext),
      ),
    );
  } finally {
    wipe(aad);
  }
}

function nodeWrapperPurpose(kind: 1 | 2 | 3 | 4, nodeId: string): string {
  return `node-wrapper-${kind}-${nodeId}`;
}

function assertUnlockMaterial(material: VaultUnlockMaterial): void {
  if (
    material.formatVersion !== VAULT_FORMAT_VERSION ||
    material.vaultVersion < 1
  ) {
    throw new Error("The server returned an unsupported vault format.");
  }
  assertArgon2idProfile(material.kdf);
  if (
    fromBase64Url(material.kdf.salt).length !== 16 ||
    fromBase64Url(material.passwordWrapper.id).length !== 16 ||
    fromBase64Url(material.passwordWrapper.ciphertext).length !== 48 ||
    fromBase64Url(material.recoveryWrapper.salt).length !== 16 ||
    fromBase64Url(material.recoveryWrapper.id).length !== 16 ||
    fromBase64Url(material.recoveryWrapper.ciphertext).length !== 48
  ) {
    throw new Error("The server returned invalid vault wrapping material.");
  }
}

function requireRootKey(): CryptoKey {
  if (!rootKey) throw vaultError("VAULT_LOCKED", "Unlock the vault first.");
  return rootKey;
}

function requireIdentity(): IdentitySecrets {
  if (!identity) throw vaultError("VAULT_LOCKED", "Unlock the vault first.");
  return identity;
}

function requireEncryptionSession(sessionId: string): EncryptionSession {
  const session = encryptionSessions.get(sessionId);
  if (!session)
    throw new Error("The encryption session is no longer available.");
  return session;
}

function validatePassword(password: string): void {
  if (password.length < 12 || password.length > 1024) {
    throw new Error("Use a vault password between 12 and 1024 characters.");
  }
}

function validateNodeId(nodeId: string): void {
  if (!/^fil_[A-Za-z0-9_-]{4,92}$/u.test(nodeId)) {
    throw new Error("The vault node ID is invalid.");
  }
}

function normalizeName(name: string): string {
  const normalized = name.normalize("NFC").trim();
  if (!normalized || normalized.length > 1024 || normalized.includes("\0")) {
    throw new Error("The file or folder name is invalid.");
  }
  return normalized;
}

function vaultError(
  code: string,
  message: string,
  cause?: unknown,
): Error & { code: string } {
  const error = new Error(
    message,
    cause === undefined ? undefined : { cause },
  ) as Error & {
    code: string;
  };
  error.code = code;
  return error;
}

function normalizeError(error: unknown): { message: string; code?: string } {
  if (error instanceof Error) {
    const coded = error as Error & { code?: unknown };
    return {
      message: error.message || "Vault operation failed.",
      ...(typeof coded.code === "string" ? { code: coded.code } : {}),
    };
  }
  return { message: "Vault operation failed." };
}
