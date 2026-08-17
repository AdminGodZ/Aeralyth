import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderZipSource } from "@/features/dashboard/folder-zip-messages";
import { downloadFolderArchive } from "@/features/files/folder-archive";
import {
  toBase64Url,
  type VaultDownloadPlan,
  type VaultManifest,
} from "@/features/vault/protocol";
import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type { FolderArchiveEntry } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  createBrowserZip: vi.fn(
    async (_request: { sources: FolderZipSource[] }) => new Blob(["zip"]),
  ),
  triggerBlobDownload: vi.fn(),
  readEncryptedFileBlob: vi.fn(async () => new Blob(["data"])),
  getVaultDownloadPlan: vi.fn(),
}));

vi.mock("@/features/archive/browser-archive", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/archive/browser-archive")
  >()),
  createBrowserZip: mocks.createBrowserZip,
  triggerBlobDownload: mocks.triggerBlobDownload,
}));

vi.mock("@/features/vault/encrypted-download", () => ({
  readEncryptedFileBlob: mocks.readEncryptedFileBlob,
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
  vaultRecordHash: "record",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createBrowserZip.mockResolvedValue(new Blob(["zip"]));
  mocks.readEncryptedFileBlob.mockResolvedValue(new Blob(["data"]));
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

    const zipRequest = mocks.createBrowserZip.mock.calls[0]?.[0];
    const downloadedSource = zipRequest?.sources.find(
      (source): source is Extract<FolderZipSource, { directory?: false }> =>
        !source.directory,
    );
    expect(downloadedSource?.file.size).toBe(fileManifest.plaintextBytes);
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
    expect(mocks.readEncryptedFileBlob).not.toHaveBeenCalled();
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
