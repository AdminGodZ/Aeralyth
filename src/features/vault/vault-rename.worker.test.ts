import { beforeAll, describe, expect, it } from "vitest";

import { decodeBootstrap } from "@/features/vault/cbor";
import {
  concatBytes,
  sha256,
  toBase64Url,
  VAULT_CRYPTO_CHUNK_BYTES,
  type VaultDownloadPlan,
  type VaultNodeRecord,
  type VaultUnlockMaterial,
} from "@/features/vault/protocol";
import type {
  VaultDecryptedChunk,
  VaultDecryptionStart,
  VaultEncryptedChunk,
  VaultEncryptionComplete,
  VaultEncryptionStart,
  VaultOpenPlanResult,
  VaultRenameResult,
  VaultSetupResult,
  VaultWorkerResponse,
} from "@/features/vault/vault-messages";

// The real vault worker runs in this test's global scope: requests go in
// through onmessage and answers come back through postMessage.
type WorkerGlobal = typeof globalThis & {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage: (message: VaultWorkerResponse) => void;
};
const workerScope = globalThis as WorkerGlobal;
const waiting = new Map<number, (message: VaultWorkerResponse) => void>();
let nextRequestId = 1;

class WorkerFailure extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function send<Result>(request: Record<string, unknown>): Promise<Result> {
  const id = nextRequestId;
  nextRequestId += 1;
  return new Promise((resolve, reject) => {
    waiting.set(id, (message) => {
      if (message.ok && "progress" in message) return;
      waiting.delete(id);
      if (!message.ok) {
        reject(new WorkerFailure(message.error, message.code));
        return;
      }
      resolve((message.result as { result?: Result }).result as Result);
    });
    workerScope.onmessage?.({ data: { ...request, id } });
  });
}

const PASSWORD = "correct horse battery staple";
let signer: { keyVersion: number; ed25519PublicKey: string };
let material: VaultUnlockMaterial;

beforeAll(async () => {
  workerScope.postMessage = (message) => waiting.get(message.id)?.(message);
  await import("@/features/vault/vault.worker");
  const setup = await send<VaultSetupResult>({
    type: "setup",
    password: PASSWORD,
  });
  signer = setup.payload.identity;
  material = {
    formatVersion: setup.payload.formatVersion,
    vaultVersion: 1,
    kdf: setup.payload.kdf,
    passwordWrapper: setup.payload.passwordWrapper,
    recoveryWrapper: setup.payload.recoveryWrapper,
    identity: setup.payload.identity,
    accountState: null,
  };
}, 60_000);

async function encryptNode(input: {
  parentId: string | null;
  entryType: "file" | "folder";
  name: string;
  plaintext?: Uint8Array;
  mimeType?: string;
}): Promise<{ complete: VaultEncryptionComplete; ciphertext: Uint8Array[] }> {
  const plaintext = input.plaintext ?? new Uint8Array();
  const started = await send<VaultEncryptionStart>({
    type: "startEncryption",
    input: {
      parentId: input.parentId,
      entryType: input.entryType,
      name: input.name,
      mimeType: input.mimeType ?? null,
      plaintextBytes: plaintext.length,
      lastModified: 1_700_000_000_000,
    },
  });
  const ciphertext: Uint8Array[] = [];
  for (let index = 0; index < started.chunkCount; index += 1) {
    const chunk = plaintext.slice(
      index * VAULT_CRYPTO_CHUNK_BYTES,
      (index + 1) * VAULT_CRYPTO_CHUNK_BYTES,
    );
    const encrypted = await send<VaultEncryptedChunk>({
      type: "encryptChunk",
      sessionId: started.sessionId,
      chunkIndex: index,
      plaintext: chunk.buffer,
    });
    ciphertext.push(new Uint8Array(encrypted.ciphertext));
  }
  const complete = await send<VaultEncryptionComplete>({
    type: "finalizeEncryption",
    sessionId: started.sessionId,
  });
  return { complete, ciphertext };
}

/** The download plan the server would serve for a published record. */
async function planFor(
  node: {
    nodeId: string;
    generationNumber: number;
    generationId: string;
    ciphertextLength: number;
    chunkCount: number;
  },
  entryType: "file" | "folder",
  record: VaultNodeRecord,
): Promise<VaultDownloadPlan> {
  const bootstrap = decodeBootstrap(record.bootstrapCbor);
  return {
    nodeId: node.nodeId,
    entryType,
    generationNumber: node.generationNumber,
    generationId: node.generationId,
    ciphertextLength: node.ciphertextLength,
    cryptoChunkBytes: VAULT_CRYPTO_CHUNK_BYTES,
    chunkCount: node.chunkCount,
    ciphertextMerkleRoot: toBase64Url(bootstrap.ciphertextMerkleRoot),
    bootstrapCbor: toBase64Url(record.bootstrapCbor),
    bootstrapSignature: toBase64Url(record.bootstrapSignature),
    encryptedManifest: toBase64Url(record.encryptedManifest),
    wrappers: record.wrappers.map((wrapper) => toBase64Url(wrapper)),
    signerKeyVersion: signer.keyVersion,
    signerEd25519PublicKey: signer.ed25519PublicKey,
    recordVersion: bootstrap.recordVersion,
    recordHash: toBase64Url(
      await sha256(
        concatBytes(record.bootstrapCbor, record.bootstrapSignature),
      ),
    ),
    share: null,
    downloadUrl: entryType === "file" ? "https://storage.invalid/object" : null,
  };
}

async function decryptAll(
  plan: VaultDownloadPlan,
  ciphertext: Uint8Array[],
): Promise<{ name: string; bytes: Uint8Array }> {
  const started = await send<VaultDecryptionStart>({
    type: "startDecryption",
    plan,
  });
  const parts: Uint8Array[] = [];
  for (const [index, chunk] of ciphertext.entries()) {
    const decrypted = await send<VaultDecryptedChunk>({
      type: "decryptChunk",
      sessionId: started.sessionId,
      chunkIndex: index,
      ciphertext: chunk.slice().buffer,
    });
    parts.push(
      new Uint8Array(decrypted.plaintext).slice(0, decrypted.plaintextBytes),
    );
  }
  await send({ type: "finalizeDecryption", sessionId: started.sessionId });
  return {
    name: started.manifest.name,
    bytes: concatBytes(...parts).slice(0, started.manifest.plaintextBytes),
  };
}

async function relock(): Promise<void> {
  await send({ type: "lock" });
  await send({ type: "unlock", password: PASSWORD, material });
}

describe("renaming an encrypted node", () => {
  it("keeps the folder key and content while the names change", async () => {
    const folder = await encryptNode({
      parentId: null,
      entryType: "folder",
      name: "Holiday",
    });
    const content = new TextEncoder().encode("a small photo's bytes");
    const file = await encryptNode({
      parentId: folder.complete.nodeId,
      entryType: "file",
      name: "IMG_0001.png",
      mimeType: "image/png",
      plaintext: content,
    });
    const folderPlan = await planFor(
      folder.complete,
      "folder",
      folder.complete.record,
    );
    const filePlan = await planFor(file.complete, "file", file.complete.record);

    const renamedFile = await send<VaultRenameResult>({
      type: "renameNode",
      input: { plan: filePlan, name: "  Beach at dusk.png " },
    });
    const renamedFolder = await send<VaultRenameResult>({
      type: "renameNode",
      input: { plan: folderPlan, name: "Holiday 2026" },
    });

    expect(renamedFile.recordVersion).toBe(2);
    expect(renamedFile.manifest.name).toBe("Beach at dusk.png");
    expect(renamedFile.manifest.mimeType).toBe("image/png");
    const fileBootstrap = decodeBootstrap(renamedFile.record.bootstrapCbor);
    expect(
      toBase64Url(fileBootstrap.previousRecordHash ?? new Uint8Array()),
    ).toBe(filePlan.recordHash);
    expect(fileBootstrap.generationNumber).toBe(file.complete.generationNumber);
    expect(toBase64Url(fileBootstrap.ciphertextMerkleRoot)).toBe(
      filePlan.ciphertextMerkleRoot,
    );
    const nextFilePlan = await planFor(
      file.complete,
      "file",
      renamedFile.record,
    );
    expect(nextFilePlan.recordHash).toBe(renamedFile.recordHash);
    const nextFolderPlan = await planFor(
      folder.complete,
      "folder",
      renamedFolder.record,
    );

    // A fresh unlock holds no node keys: the file's key is recovered through
    // the renamed folder's re-sealed wrapper, then its own.
    await relock();
    await expect(
      send<VaultOpenPlanResult>({ type: "openPlan", plan: nextFilePlan }),
    ).rejects.toMatchObject({ code: "PARENT_KEY_REQUIRED" });
    const openedFolder = await send<VaultOpenPlanResult>({
      type: "openPlan",
      plan: nextFolderPlan,
    });
    expect(openedFolder.manifest.name).toBe("Holiday 2026");

    const decrypted = await decryptAll(nextFilePlan, file.ciphertext);
    expect(decrypted.name).toBe("Beach at dusk.png");
    expect(decrypted.bytes).toEqual(content);
  }, 60_000);

  it("chains a second rename onto the first", async () => {
    const file = await encryptNode({
      parentId: null,
      entryType: "file",
      name: "draft.txt",
      plaintext: new TextEncoder().encode("v1"),
    });
    const first = await send<VaultRenameResult>({
      type: "renameNode",
      input: {
        plan: await planFor(file.complete, "file", file.complete.record),
        name: "notes.txt",
      },
    });
    const second = await send<VaultRenameResult>({
      type: "renameNode",
      input: {
        plan: await planFor(file.complete, "file", first.record),
        name: "final notes.txt",
      },
    });
    expect(second.recordVersion).toBe(3);

    await relock();
    const decrypted = await decryptAll(
      await planFor(file.complete, "file", second.record),
      file.ciphertext,
    );
    expect(decrypted.name).toBe("final notes.txt");
    expect(new TextDecoder().decode(decrypted.bytes)).toBe("v1");
  }, 60_000);

  it("rejects an empty name and a shared plan", async () => {
    const file = await encryptNode({
      parentId: null,
      entryType: "file",
      name: "keep.txt",
      plaintext: new TextEncoder().encode("x"),
    });
    const plan = await planFor(file.complete, "file", file.complete.record);
    await expect(
      send({ type: "renameNode", input: { plan, name: "   " } }),
    ).rejects.toThrow("The file or folder name is invalid.");
    await expect(
      send({
        type: "renameNode",
        input: { plan: { ...plan, share: {} }, name: "other.txt" },
      }),
    ).rejects.toMatchObject({ code: "NOT_OWNER" });
  }, 60_000);
});
