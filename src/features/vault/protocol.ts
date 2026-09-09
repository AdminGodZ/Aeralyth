import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import {
  detectedCryptoConcurrency,
  mapWithConcurrency,
} from "@/features/vault/bounded-async";

export const VAULT_FORMAT_VERSION = 1;
export const VAULT_SHARE_ENVELOPE_VERSION = 2;
export const VAULT_SHARE_DIRECTORY_VERSION = 1;
export const MAX_SHARE_WRAPPERS = 100_000;
export const VAULT_SUITE_ID = 1;
export const VAULT_AAD_SCHEMA_ID = 1;
export const VAULT_CRYPTO_CHUNK_BYTES = 4 * 1024 * 1024;
export const VAULT_MAX_CIPHERTEXT_BYTES = 2_415_919_104;

const PROTOCOL_HASH_CONCURRENCY = detectedCryptoConcurrency(16);

export const ARGON2ID_PROFILE = Object.freeze({
  algorithm: "argon2id13",
  operations: 3,
  memoryBytes: 256 * 1024 * 1024,
  outputBytes: 32,
});

export type VaultEntryType = "file" | "folder";

export type VaultKdf = {
  algorithm: string;
  salt: string;
  operations: number;
  memoryBytes: number;
  outputBytes: number;
};

export type VaultUnlockMaterial = {
  formatVersion: number;
  vaultVersion: number;
  kdf: VaultKdf;
  passwordWrapper: { id: string; ciphertext: string };
  recoveryWrapper: { salt: string; id: string; ciphertext: string };
  identity: {
    keyVersion: number;
    x25519PublicKey: string;
    ed25519PublicKey: string;
    fingerprintSha256: string;
    privateRecordId: string;
    privateCiphertext: string;
  };
  accountState: VaultAccountStateManifest | null;
};

export type VaultAccountStateManifest = {
  recordId: string;
  version: number;
  ciphertextBytes: number;
};

export type VaultSetupPayload = {
  formatVersion: number;
  kdf: VaultKdf;
  passwordWrapper: { id: string; ciphertext: string };
  recoveryWrapper: { salt: string; id: string; ciphertext: string };
  identity: {
    keyVersion: number;
    x25519PublicKey: string;
    ed25519PublicKey: string;
    fingerprintSha256: string;
    privateRecordId: string;
    privateCiphertext: string;
  };
  accountStateRecordId: string;
  encryptedAccountState: string;
};

export type VaultRewrapPayload = Omit<
  VaultSetupPayload,
  "formatVersion" | "identity"
> & {
  expectedVaultVersion: number;
  recovery: boolean;
  proofSignature: string;
};

export type VaultPasswordRewrapPayload = {
  expectedVaultVersion: number;
  kdf: VaultKdf;
  passwordWrapper: { id: string; ciphertext: string };
  proofSignature: string;
};

export type VaultWrapperRecord = {
  formatVersion: number;
  wrapperId: Uint8Array;
  kind: 1 | 2 | 3 | 4;
  nodeId: string;
  parentNodeId: string | null;
  generationId: Uint8Array | null;
  shareId: string | null;
  epoch: number | null;
  recordVersion: number;
  ciphertext: Uint8Array;
  aadSchemaId: number;
};

export type VaultBootstrapRecord = {
  formatVersion: number;
  suiteId: number;
  aadSchemaId: number;
  nodeId: string;
  generationNumber: number;
  generationId: Uint8Array;
  manifestIv: Uint8Array;
  wrapperIds: Uint8Array[];
  ciphertextLength: number;
  signerKeyVersion: number;
  recordVersion: number;
  previousRecordHash: Uint8Array | null;
  manifestHash: Uint8Array;
  wrapperHashes: Uint8Array[];
  ciphertextMerkleRoot: Uint8Array;
};

export type VaultShareDirectoryRecord = {
  formatVersion: number;
  suiteId: number;
  aadSchemaId: number;
  nodeId: string;
  recordVersion: number;
  recordHash: Uint8Array;
  generationNumber: number;
  generationId: Uint8Array;
  signerKeyVersion: number;
  wrapperSetRoot: Uint8Array;
  wrapperCount: number;
};

export type VaultManifest = {
  name: string;
  mimeType: string | null;
  entryType: VaultEntryType;
  plaintextBytes: number;
  paddedBytes: number;
  lastModified: number;
  parentId: string | null;
  chunkCount: number;
  generationId: Uint8Array;
  createdAt: number;
};

export type VaultNodeRecord = {
  bootstrapCbor: Uint8Array;
  bootstrapSignature: Uint8Array;
  encryptedManifest: Uint8Array;
  wrappers: Uint8Array[];
};

export type VaultMetadataPlan = {
  nodeId: string;
  entryType: VaultEntryType;
  generationNumber: number;
  generationId: string;
  ciphertextLength: number;
  cryptoChunkBytes: number;
  chunkCount: number;
  ciphertextMerkleRoot: string;
  bootstrapCbor: string;
  bootstrapSignature: string;
  encryptedManifest: string;
  wrappers: string[];
  signerKeyVersion: number;
  signerEd25519PublicKey: string;
  recordVersion: number;
  recordHash: string;
  share: VaultShareDownloadMaterial | null;
};

export type VaultDownloadPlan = VaultMetadataPlan & {
  downloadUrl: string | null;
};

export type VaultMetadataReference = {
  nodeId: string;
  parentId: string | null;
  recordVersion: number;
  recordHash: string;
  generationId: string;
};

export type VaultShareDownloadMaterial = {
  shareId: string;
  epoch: number;
  rootNodeId: string;
  senderId: string;
  recipientId: string;
  recordVersion: number;
  previousRecordHash: string | null;
  envelopeCbor: string;
  envelopeSignature: string;
  envelopeHash: string;
  senderKeyVersion: number;
  senderX25519PublicKey: string;
  senderEd25519PublicKey: string;
  senderFingerprintSha256: string;
  recipientKeyVersion: number;
  authorizationVersion: string;
  wrapperProofs: Array<{
    leafIndex: number;
    proof: string;
  } | null>;
  directory: {
    canonicalCbor: string;
    signature: string;
    wrapperProofs: Array<{
      leafIndex: number;
      proof: string;
    }>;
  } | null;
};

export type VaultPublicIdentity = {
  userId: string;
  username: string;
  keyVersion: number;
  x25519PublicKey: string;
  ed25519PublicKey: string;
  fingerprintSha256: string;
  trustStatus: "unverified" | "accepted" | "changed";
};

export type VaultShareNodeSnapshot = {
  nodeId: string;
  parentId: string | null;
  depth: number;
  entryType: VaultEntryType;
  generationNumber: number;
  generationId: string | null;
  recordVersion: number;
  recordHash: string;
};

export type VaultSharePreparationPlan = {
  snapshot: VaultShareNodeSnapshot;
  metadata: VaultMetadataPlan;
};

export type VaultActiveShareContext = {
  shareId: string;
  epoch: number;
  wrapperId: string;
  ciphertext: string;
};

export type VaultShareEnvelopeRecord = {
  formatVersion: number;
  suiteId: number;
  envelopeId: Uint8Array;
  shareId: string;
  epoch: number;
  senderId: string;
  senderKeyVersion: number;
  recipientId: string;
  recipientKeyVersion: number;
  nodeId: string;
  permissions: 1;
  generationScope: number | null;
  recordVersion: number;
  previousRecordHash: Uint8Array | null;
  encapsulatedKey: Uint8Array;
  ciphertext: Uint8Array;
  aadSchemaId: number;
  wrapperHashes: Uint8Array[];
  wrapperSetRoot: Uint8Array | null;
  wrapperCount: number;
};

export type VaultShareContextMaterial = {
  shareId: string;
  epoch: number;
  epochKey: Uint8Array;
};

const WEB_CRYPTO_RANDOM_BYTES_LIMIT = 65_536;

export function assertArgon2idProfile(kdf: VaultKdf): void {
  if (
    kdf.algorithm !== ARGON2ID_PROFILE.algorithm ||
    kdf.operations !== ARGON2ID_PROFILE.operations ||
    kdf.memoryBytes !== ARGON2ID_PROFILE.memoryBytes ||
    kdf.outputBytes !== ARGON2ID_PROFILE.outputBytes
  ) {
    throw new Error("The server returned an unsupported vault KDF profile.");
  }
}

export function fillRandomBytes(output: Uint8Array): Uint8Array {
  for (
    let offset = 0;
    offset < output.length;
    offset += WEB_CRYPTO_RANDOM_BYTES_LIMIT
  ) {
    crypto.getRandomValues(
      output.subarray(offset, offset + WEB_CRYPTO_RANDOM_BYTES_LIMIT),
    );
  }
  return output;
}

export function randomBytes(length: number): Uint8Array {
  return fillRandomBytes(new Uint8Array(length));
}

export function randomPrefixedId(prefix: string): string {
  return `${prefix}${toBase64Url(randomBytes(18))}`;
}

export function toBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  const blockSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + blockSize),
    );
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new Error("Invalid base64url value.");
  }
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function concatBytes(...values: Uint8Array[]): Uint8Array {
  const length = values.reduce((total, value) => total + value.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;

  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }

  return output;
}

export function encodeVaultRewrapProof(
  payload: Omit<VaultRewrapPayload, "proofSignature">,
): Uint8Array {
  assertArgon2idProfile(payload.kdf);
  const accountStateRecordId = fromBase64Url(payload.accountStateRecordId);
  const fields = [
    utf8("aeralyth/vault-rewrap-proof/v1"),
    encodeUnsigned64(VAULT_FORMAT_VERSION),
    encodeUnsigned64(payload.expectedVaultVersion),
    Uint8Array.of(payload.recovery ? 1 : 0),
    encodeLengthPrefixed(utf8(payload.kdf.algorithm)),
    encodeLengthPrefixed(fromBase64Url(payload.kdf.salt)),
    encodeUnsigned64(payload.kdf.operations),
    encodeUnsigned64(payload.kdf.memoryBytes),
    encodeUnsigned64(payload.kdf.outputBytes),
    encodeLengthPrefixed(fromBase64Url(payload.passwordWrapper.id)),
    encodeLengthPrefixed(fromBase64Url(payload.passwordWrapper.ciphertext)),
    encodeLengthPrefixed(fromBase64Url(payload.recoveryWrapper.salt)),
    encodeLengthPrefixed(fromBase64Url(payload.recoveryWrapper.id)),
    encodeLengthPrefixed(fromBase64Url(payload.recoveryWrapper.ciphertext)),
    Uint8Array.of(1),
    encodeLengthPrefixed(accountStateRecordId),
    encodeLengthPrefixed(fromBase64Url(payload.encryptedAccountState)),
  ];
  try {
    return concatBytes(...fields);
  } finally {
    wipe(accountStateRecordId, ...fields.slice(4));
  }
}

export function encodeVaultPasswordRewrapProof(
  payload: Omit<VaultPasswordRewrapPayload, "proofSignature">,
): Uint8Array {
  assertArgon2idProfile(payload.kdf);
  const fields = [
    utf8("aeralyth/vault-password-rewrap-proof/v1"),
    encodeUnsigned64(VAULT_FORMAT_VERSION),
    encodeUnsigned64(payload.expectedVaultVersion),
    encodeLengthPrefixed(utf8(payload.kdf.algorithm)),
    encodeLengthPrefixed(fromBase64Url(payload.kdf.salt)),
    encodeUnsigned64(payload.kdf.operations),
    encodeUnsigned64(payload.kdf.memoryBytes),
    encodeUnsigned64(payload.kdf.outputBytes),
    encodeLengthPrefixed(fromBase64Url(payload.passwordWrapper.id)),
    encodeLengthPrefixed(fromBase64Url(payload.passwordWrapper.ciphertext)),
  ];
  try {
    return concatBytes(...fields);
  } finally {
    wipe(...fields.slice(3));
  }
}

function encodeUnsigned64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid unsigned protocol integer.");
  }
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, BigInt(value), false);
  return output;
}

function encodeLengthPrefixed(value: Uint8Array): Uint8Array {
  return concatBytes(encodeUnsigned64(value.length), value);
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function wipe(...values: Array<Uint8Array | null | undefined>): void {
  for (const value of values) {
    value?.fill(0);
  }
}

export function chunkNonce(chunkIndex: number): Uint8Array {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error("Invalid encryption chunk index.");
  }
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  const high = Math.floor(chunkIndex / 0x1_0000_0000);
  const low = chunkIndex >>> 0;
  view.setUint32(4, high, false);
  view.setUint32(8, low, false);
  return nonce;
}

export function zeroNonce(): Uint8Array {
  return new Uint8Array(12);
}

export function encodeChunkAad(input: {
  nodeId: string;
  generationNumber: number;
  generationId: Uint8Array;
  chunkIndex: number;
  plaintextLength: number;
}): Uint8Array {
  const node = utf8(input.nodeId);
  if (node.length > 96 || input.generationId.length !== 16) {
    throw new Error("Invalid chunk AAD fields.");
  }
  const fixed = new Uint8Array(2 + node.length + 8 + 16 + 8 + 4 + 2);
  const view = new DataView(fixed.buffer);
  let offset = 0;
  view.setUint16(offset, VAULT_AAD_SCHEMA_ID, false);
  offset += 2;
  fixed.set(node, offset);
  offset += node.length;
  view.setBigUint64(offset, BigInt(input.generationNumber), false);
  offset += 8;
  fixed.set(input.generationId, offset);
  offset += 16;
  view.setBigUint64(offset, BigInt(input.chunkIndex), false);
  offset += 8;
  view.setUint32(offset, input.plaintextLength, false);
  offset += 4;
  view.setUint16(offset, node.length, false);
  return fixed;
}

export function encodeRecordAad(
  purpose: string,
  recordId: string,
  recordVersion: number,
): Uint8Array {
  const purposeBytes = utf8(purpose);
  const idBytes = utf8(recordId);
  const output = new Uint8Array(
    2 + 2 + purposeBytes.length + 2 + idBytes.length + 8,
  );
  const view = new DataView(output.buffer);
  let offset = 0;
  view.setUint16(offset, VAULT_AAD_SCHEMA_ID, false);
  offset += 2;
  view.setUint16(offset, purposeBytes.length, false);
  offset += 2;
  output.set(purposeBytes, offset);
  offset += purposeBytes.length;
  view.setUint16(offset, idBytes.length, false);
  offset += 2;
  output.set(idBytes, offset);
  offset += idBytes.length;
  view.setBigUint64(offset, BigInt(recordVersion), false);
  return output;
}

export function padmeLength(plaintextBytes: number): number {
  if (!Number.isSafeInteger(plaintextBytes) || plaintextBytes < 0) {
    throw new Error("Invalid plaintext length.");
  }
  const minimum = Math.max(plaintextBytes, 1, 4096);
  const exponent = Math.floor(Math.log2(minimum));
  const significantBits = Math.max(1, Math.floor(Math.log2(exponent)));
  const quantum = 2 ** Math.max(0, exponent - significantBits);
  return Math.ceil(minimum / quantum) * quantum;
}

export function encryptedLength(paddedBytes: number): {
  chunkCount: number;
  ciphertextBytes: number;
} {
  if (!Number.isSafeInteger(paddedBytes) || paddedBytes < 4096) {
    throw new Error("Invalid padded payload length.");
  }
  const chunkCount = Math.ceil(paddedBytes / VAULT_CRYPTO_CHUNK_BYTES);
  return {
    chunkCount,
    ciphertextBytes: paddedBytes + chunkCount * 16,
  };
}

export function ciphertextChunkLength(
  ciphertextBytes: number,
  chunkCount: number,
  chunkIndex: number,
): number {
  if (chunkIndex < 0 || chunkIndex >= chunkCount) {
    throw new Error("Invalid ciphertext chunk index.");
  }
  if (chunkIndex < chunkCount - 1) {
    return VAULT_CRYPTO_CHUNK_BYTES + 16;
  }
  return ciphertextBytes - (chunkCount - 1) * (VAULT_CRYPTO_CHUNK_BYTES + 16);
}

export async function sha256(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", asBufferSource(value)),
  );
}

export async function sha256Parts(
  ...values: readonly Uint8Array[]
): Promise<Uint8Array> {
  const hasher = nobleSha256.create();
  let digested = false;
  try {
    for (const value of values) hasher.update(value);
    const digest = hasher.digest();
    digested = true;
    return digest;
  } finally {
    if (!digested) hasher.destroy();
  }
}

export async function shareAuthorizationVersion(input: {
  shareId: string;
  epoch: number;
  recipientId: string;
  recipientKeyVersion: number;
  shareRecordVersion: number;
  envelopeHash: Uint8Array;
}): Promise<Uint8Array> {
  const shareId = utf8(input.shareId);
  const recipientId = utf8(input.recipientId);
  return sha256Parts(
    utf8("aeralyth/share-authorization/v1"),
    encodeUnsigned32(shareId.length),
    shareId,
    encodeUnsigned64(input.epoch),
    encodeUnsigned32(recipientId.length),
    recipientId,
    encodeUnsigned64(input.recipientKeyVersion),
    encodeUnsigned64(input.shareRecordVersion),
    encodeUnsigned32(input.envelopeHash.length),
    input.envelopeHash,
  );
}

function encodeUnsigned32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("Invalid unsigned protocol length.");
  }
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

export async function merkleRootFromLeaves(
  leaves: Uint8Array[],
): Promise<Uint8Array> {
  if (leaves.length === 0) {
    return sha256(new Uint8Array());
  }
  let level: Uint8Array[] = leaves.map((leaf) => Uint8Array.from(leaf));
  while (level.length > 1) {
    const next = await mapWithConcurrency(
      Array.from({ length: Math.ceil(level.length / 2) }, (_, index) => index),
      PROTOCOL_HASH_CONCURRENCY,
      async (pairIndex) => {
        const index = pairIndex * 2;
        if (index + 1 === level.length) {
          return level[index];
        }
        return sha256Parts(Uint8Array.of(1), level[index], level[index + 1]);
      },
    );
    level = next;
  }
  return level[0];
}

const WRAPPER_LEAF_DOMAIN = utf8("aeralyth/share-wrapper-leaf/v2");
const WRAPPER_BRANCH_DOMAIN = utf8("aeralyth/share-wrapper-branch/v2");
const WRAPPER_ROOT_DOMAIN = utf8("aeralyth/share-wrapper-root/v2");

export async function wrapperSetRoot(
  wrapperHashes: Uint8Array[],
): Promise<Uint8Array> {
  if (wrapperHashes.length === 0 || wrapperHashes.length > MAX_SHARE_WRAPPERS) {
    throw new Error("Invalid share wrapper count.");
  }
  const ordered = wrapperHashes
    .map((hash) => {
      if (hash.length !== 32) throw new Error("Invalid share wrapper hash.");
      return Uint8Array.from(hash);
    })
    .sort(compareBytes);
  for (let index = 1; index < ordered.length; index += 1) {
    if (equalBytes(ordered[index - 1], ordered[index])) {
      throw new Error("Duplicate share wrapper hash.");
    }
  }
  let level = await mapWithConcurrency(
    ordered,
    PROTOCOL_HASH_CONCURRENCY,
    (hash) => sha256Parts(WRAPPER_LEAF_DOMAIN, hash),
  );
  while (level.length > 1) {
    level = await mapWithConcurrency(
      Array.from({ length: Math.ceil(level.length / 2) }, (_, index) => index),
      PROTOCOL_HASH_CONCURRENCY,
      (pairIndex) => {
        const index = pairIndex * 2;
        const right = level[index + 1] ?? level[index];
        return sha256Parts(WRAPPER_BRANCH_DOMAIN, level[index], right);
      },
    );
  }
  return sha256Parts(
    WRAPPER_ROOT_DOMAIN,
    encodeUnsigned64(wrapperHashes.length),
    level[0],
  );
}

export async function verifyWrapperSetProof(input: {
  wrapperHash: Uint8Array;
  leafIndex: number;
  proof: Uint8Array;
  wrapperCount: number;
  expectedRoot: Uint8Array;
}): Promise<boolean> {
  if (
    input.wrapperHash.length !== 32 ||
    input.expectedRoot.length !== 32 ||
    !Number.isSafeInteger(input.leafIndex) ||
    input.leafIndex < 0 ||
    !Number.isSafeInteger(input.wrapperCount) ||
    input.wrapperCount < 1 ||
    input.wrapperCount > MAX_SHARE_WRAPPERS ||
    input.leafIndex >= input.wrapperCount
  ) {
    return false;
  }
  const depth = Math.ceil(Math.log2(input.wrapperCount));
  if (input.proof.length !== depth * 32) return false;

  let index = input.leafIndex;
  let node = await sha256Parts(WRAPPER_LEAF_DOMAIN, input.wrapperHash);
  for (let level = 0; level < depth; level += 1) {
    const sibling = input.proof.subarray(level * 32, (level + 1) * 32);
    node =
      index % 2 === 0
        ? await sha256Parts(WRAPPER_BRANCH_DOMAIN, node, sibling)
        : await sha256Parts(WRAPPER_BRANCH_DOMAIN, sibling, node);
    index = Math.floor(index / 2);
  }
  const root = await sha256Parts(
    WRAPPER_ROOT_DOMAIN,
    encodeUnsigned64(input.wrapperCount),
    node,
  );
  return equalBytes(root, input.expectedRoot);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

export async function ciphertextLeafHash(
  chunkIndex: number,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const index = new Uint8Array(8);
  new DataView(index.buffer).setBigUint64(0, BigInt(chunkIndex), false);
  return sha256Parts(Uint8Array.of(0), index, ciphertext);
}

export function asBufferSource(value: Uint8Array): Uint8Array<ArrayBuffer> {
  if (value.buffer instanceof ArrayBuffer) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return Uint8Array.from(value);
}

export function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const source = asBufferSource(value);
  if (
    source.byteOffset === 0 &&
    source.byteLength === source.buffer.byteLength
  ) {
    return source.buffer;
  }
  return source.buffer.slice(
    source.byteOffset,
    source.byteOffset + source.byteLength,
  );
}
