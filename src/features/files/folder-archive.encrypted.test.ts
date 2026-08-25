import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadFolderArchive } from "@/features/files/folder-archive";
import {
  toBase64Url,
  type VaultDownloadPlan,
  type VaultManifest,
} from "@/features/vault/protocol";
import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type { FolderArchiveEntry } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  createStreamingZipDestination: vi.fn(),
  zipAdd: vi.fn(),
  zipClose: vi.fn(),
  discard: vi.fn(),
  release: vi.fn(),
  triggerBlobDownload: vi.fn(),
  readEncryptedFileStream: vi.fn(),
  getVaultDownloadPlan: vi.fn(),
}));

vi.mock("@/features/archive/browser-archive", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/archive/browser-archive")
  >()),
  createStreamingZipDestination: mocks.createStreamingZipDestination,
  triggerBlobDownload: mocks.triggerBlobDownload,
}));

vi.mock("@/features/vault/encrypted-download", () => ({
  readEncryptedFileStream: mocks.readEncryptedFileStream,
}));

vi.mock("@/features/vault/vault-api", () => ({
  getVaultDownloadPlan: mocks.getVaultDownloadPlan,
}));

const rootGeneration = Uint8Array.from({ length: 16 }, (_, index) => index);
const fileGeneration = Uint8Array.from(
  { length: 16 },
  (_, index) => index + 16,
);

const rootManifest: VaultManifest = {
  name: "Private project",
  mimeType: null,
  entryType: "folder",
  plaintextBytes: 0,
  paddedBytes: 0,
  lastModified: 1,
  parentId: null,
  chunkCount: 0,
  generationId: rootGeneration,
  createdAt: 1,
};

const fileManifest: VaultManifest = {
  name: "secret.txt",
  mimeType: "text/plain",
  entryType: "file",
  plaintextBytes: 4,
  paddedBytes: 32,
  lastModified: 2,
  parentId: "root",
  chunkCount: 1,
  generationId: fileGeneration,
  createdAt: 2,
};

const encryptedFile: FolderArchiveEntry = {
  id: "file",
  name: "Encrypted file",
  mimeType: "application/octet-stream",
  entryType: "file",
  parentId: "root",
  sizeBytes: 48,
  e2eeState: "encrypted",
  updatedAt: "2026-08-17T00:00:00Z",
  contentVersion: "2026-08-17T00:00:00.123456Z",
  vaultGenerationId: toBase64Url(fileGeneration),
  vaultRecordVersion: 1,
  vaultRecordHash: "record",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.zipAdd.mockImplementation(
    async (_path: string, source?: ReadableStream<Uint8Array>) => {
      if (!source) return;
      const reader = source.getReader();
      while (!(await reader.read()).done) {
        // Drain the backpressured source as the ZIP writer would.
      }
    },
  );
  mocks.zipClose.mockResolvedValue(new Blob(["zip"]));
  mocks.createStreamingZipDestination.mockResolvedValue({
    zipWriter: { add: mocks.zipAdd },
    diskBacked: true,
    close: mocks.zipClose,
    discard: mocks.discard,
    release: mocks.release,
  });
  mocks.readEncryptedFileStream.mockImplementation(
    () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data"));
          controller.close();
        },
      }),
  );
  mocks.getVaultDownloadPlan.mockImplementation(async (nodeId: string) =>
    plan(
      nodeId,
      nodeId === "root" ? "folder" : "file",
      nodeId === "root" ? rootGeneration : fileGeneration,
    ),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        rootId: "root",
        entries: [encryptedFile],
        totalBytes: encryptedFile.sizeBytes,
      }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("encrypted folder ZIP", () => {
  it("validates the decrypted plaintext size instead of ciphertext bytes", async () => {
    const openNode = vi.fn(
      async (nodeId: string, nodePlan: VaultDownloadPlan | undefined) => {
        expect(nodePlan?.nodeId).toBe(nodeId);
        return nodeId === "root" ? rootManifest : fileManifest;
      },
    );

    await expect(
      downloadFolderArchive({
        folder: {
          id: "root",
          name: "Encrypted folder",
          entryType: "folder",
          e2eeState: "encrypted",
          updatedAt: "2026-08-17T00:00:00Z",
        },
        vault: {
          state: "unlocked",
          client: {} as VaultCryptoClient,
          requestUnlock: vi.fn(),
          openNode,
          isUnlocked: () => true,
        },
      }),
    ).resolves.toBeUndefined();

    expect(mocks.readEncryptedFileStream).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({ nodeId: "file" }),
        manifest: fileManifest,
      }),
    );
    expect(encryptedFile.sizeBytes).not.toBe(fileManifest.plaintextBytes);
    expect(mocks.triggerBlobDownload).toHaveBeenCalledOnce();
  });

  it("rejects a plan that no longer matches the manifest snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          rootId: "root",
          entries: [{ ...encryptedFile, vaultRecordHash: "older-record" }],
          totalBytes: encryptedFile.sizeBytes,
        }),
      ),
    );

    await expect(
      downloadFolderArchive({
        folder: {
          id: "root",
          name: "Encrypted folder",
          entryType: "folder",
          e2eeState: "encrypted",
          updatedAt: "2026-08-17T00:00:00Z",
        },
        vault: {
          state: "unlocked",
          client: {} as VaultCryptoClient,
          requestUnlock: vi.fn(),
          openNode: async (nodeId) =>
            nodeId === "root" ? rootManifest : fileManifest,
          isUnlocked: () => true,
        },
      }),
    ).rejects.toThrow("changed during ZIP preparation");
    expect(mocks.readEncryptedFileStream).not.toHaveBeenCalled();
    expect(mocks.triggerBlobDownload).not.toHaveBeenCalled();
  });
});

function plan(
  nodeId: string,
  entryType: "file" | "folder",
  generationId: Uint8Array,
): VaultDownloadPlan {
  return {
    nodeId,
    entryType,
    generationNumber: 1,
    generationId: toBase64Url(generationId),
    ciphertextLength: entryType === "file" ? 48 : 0,
    cryptoChunkBytes: 4 * 1024 * 1024,
    chunkCount: entryType === "file" ? 1 : 0,
    ciphertextMerkleRoot: "root",
    downloadUrl: entryType === "file" ? "https://storage.invalid/file" : null,
    bootstrapCbor: "",
    bootstrapSignature: "",
    encryptedManifest: "",
    wrappers: [],
    signerKeyVersion: 1,
    signerEd25519PublicKey: "",
    recordVersion: 1,
    recordHash: "record",
    share: null,
  };
}
