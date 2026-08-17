import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderZipSource } from "@/features/dashboard/folder-zip-messages";
import { downloadRepositoryArchive } from "@/features/repositories/repository-archive";
import {
  toBase64Url,
  type VaultDownloadPlan,
  type VaultManifest,
} from "@/features/vault/protocol";
import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type { RepositoryArchiveEntry, RepositorySummary } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  createBrowserZip: vi.fn(
    async (_request: { sources: FolderZipSource[] }) => new Blob(["zip"]),
  ),
  triggerBlobDownload: vi.fn(),
  readEncryptedFileBlob: vi.fn(
    async (_request: { signal?: AbortSignal }) => new Blob(["data"]),
  ),
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

const generationId = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const generation = toBase64Url(generationId);
const downloadPlan: VaultDownloadPlan = {
  nodeId: "file",
  entryType: "file",
  generationNumber: 1,
  generationId: generation,
  ciphertextLength: 48,
  cryptoChunkBytes: 4 * 1024 * 1024,
  chunkCount: 1,
  ciphertextMerkleRoot: "root",
  downloadUrl: "https://storage.invalid/file",
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
const encryptedManifest: VaultManifest = {
  name: "secret.txt",
  mimeType: "text/plain",
  entryType: "file",
  plaintextBytes: 4,
  paddedBytes: 32,
  lastModified: 2,
  parentId: "root",
  chunkCount: 1,
  generationId,
  createdAt: 2,
};
const encryptedEntry: RepositoryArchiveEntry = {
  id: "file",
  name: "Encrypted file",
  mimeType: "application/octet-stream",
  entryType: "file",
  parentId: "root",
  sizeBytes: 48,
  e2eeState: "encrypted",
  updatedAt: "2026-08-17T00:00:00Z",
  contentVersion: "2026-08-17T00:00:00.123456Z",
  vaultGenerationId: generation,
  vaultRecordHash: "record",
};
const repository: RepositorySummary = {
  id: "repository",
  ownerUsername: "admin",
  defaultBranch: "main",
  description: null,
  root: {
    id: "root",
    name: "project",
    e2eeState: "encrypted",
    updatedAt: "2026-08-17T00:00:00Z",
  },
  createdAt: "2026-08-17T00:00:00Z",
  updatedAt: "2026-08-17T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createBrowserZip.mockResolvedValue(new Blob(["zip"]));
  mocks.readEncryptedFileBlob.mockResolvedValue(new Blob(["data"]));
  mocks.getVaultDownloadPlan.mockResolvedValue(downloadPlan);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        repository,
        entries: [encryptedEntry],
        totalBytes: encryptedEntry.sizeBytes,
      }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("encrypted repository ZIP", () => {
  it("reuses one snapshot-bound plan and validates plaintext size", async () => {
    const openNode = vi.fn(
      async (_nodeId: string, plan: VaultDownloadPlan | undefined) => {
        expect(plan).toBe(downloadPlan);
        return encryptedManifest;
      },
    );

    await downloadRepositoryArchive({
      repository,
      repositoryName: "project",
      vault: {
        state: "unlocked",
        client: {} as VaultCryptoClient,
        requestUnlock: vi.fn(),
        openNode,
        isUnlocked: () => true,
      },
    });

    expect(mocks.getVaultDownloadPlan).toHaveBeenCalledOnce();
    expect(openNode).toHaveBeenCalledOnce();
    expect(mocks.readEncryptedFileBlob).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: downloadPlan,
        manifest: encryptedManifest,
      }),
    );
    expect(mocks.triggerBlobDownload).toHaveBeenCalledOnce();
  });

  it("does not release decrypted ZIP output when the vault locks during compression", async () => {
    let unlocked = true;
    mocks.createBrowserZip.mockImplementationOnce(async () => {
      unlocked = false;
      return new Blob(["zip"]);
    });

    await expect(
      downloadRepositoryArchive({
        repository,
        repositoryName: "project",
        vault: {
          state: "unlocked",
          client: {} as VaultCryptoClient,
          requestUnlock: vi.fn(),
          openNode: async () => encryptedManifest,
          isUnlocked: () => unlocked,
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(mocks.triggerBlobDownload).not.toHaveBeenCalled();
  });

  it("cancels an in-flight plan fetch without releasing a ZIP", async () => {
    const controller = new AbortController();
    mocks.getVaultDownloadPlan.mockImplementationOnce(
      async (_nodeId: string, signal?: AbortSignal) =>
        new Promise<VaultDownloadPlan>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const download = downloadRepositoryArchive({
      repository,
      repositoryName: "project",
      vault: {
        state: "unlocked",
        client: {} as VaultCryptoClient,
        requestUnlock: vi.fn(),
        openNode: async () => encryptedManifest,
        isUnlocked: () => true,
      },
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(mocks.getVaultDownloadPlan).toHaveBeenCalledOnce(),
    );
    controller.abort();

    await expect(download).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.triggerBlobDownload).not.toHaveBeenCalled();
  });

  it("cancels in-flight decryption without releasing a ZIP", async () => {
    const controller = new AbortController();
    mocks.readEncryptedFileBlob.mockImplementationOnce(
      async ({ signal }: { signal?: AbortSignal }) =>
        new Promise<Blob>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const download = downloadRepositoryArchive({
      repository,
      repositoryName: "project",
      vault: {
        state: "unlocked",
        client: {} as VaultCryptoClient,
        requestUnlock: vi.fn(),
        openNode: async () => encryptedManifest,
        isUnlocked: () => true,
      },
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(mocks.readEncryptedFileBlob).toHaveBeenCalledOnce(),
    );
    controller.abort();

    await expect(download).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.triggerBlobDownload).not.toHaveBeenCalled();
  });

  it("cancels in-flight ZIP compression without releasing its output", async () => {
    const controller = new AbortController();
    mocks.createBrowserZip.mockImplementationOnce(
      async ({
        signal,
      }: {
        sources: FolderZipSource[];
        signal?: AbortSignal;
      }) =>
        new Promise<Blob>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const download = downloadRepositoryArchive({
      repository,
      repositoryName: "project",
      vault: {
        state: "unlocked",
        client: {} as VaultCryptoClient,
        requestUnlock: vi.fn(),
        openNode: async () => encryptedManifest,
        isUnlocked: () => true,
      },
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(mocks.createBrowserZip).toHaveBeenCalledOnce(),
    );
    controller.abort();

    await expect(download).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.triggerBlobDownload).not.toHaveBeenCalled();
  });

  it("binds legacy downloads to the exact archive-manifest version", async () => {
    const legacyEntry: RepositoryArchiveEntry = {
      ...encryptedEntry,
      name: "readme.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      e2eeState: "legacy",
      contentVersion: "2026-08-17T12:34:56.123456Z",
      vaultGenerationId: null,
      vaultRecordHash: null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          repository,
          entries: [legacyEntry],
          totalBytes: legacyEntry.sizeBytes,
        }),
      )
      .mockResolvedValueOnce(new Response("data"));
    vi.stubGlobal("fetch", fetchMock);

    await downloadRepositoryArchive({
      repository,
      repositoryName: "project",
      vault: {
        state: "locked",
        client: null,
        requestUnlock: vi.fn(),
        openNode: async () => encryptedManifest,
        isUnlocked: () => false,
      },
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/files/file/download?version=2026-08-17T12%3A34%3A56.123456Z",
      { signal: undefined, cache: "no-store" },
    );
    expect(mocks.triggerBlobDownload).toHaveBeenCalledOnce();
  });
});
