import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadRepositoryArchive } from "@/features/repositories/repository-archive";
import {
  toBase64Url,
  type VaultDownloadPlan,
  type VaultManifest,
} from "@/features/vault/protocol";
import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type { RepositoryArchiveEntry, RepositorySummary } from "@/lib/api";

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
  vaultRecordVersion: 1,
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
    vaultGenerationId: generation,
    vaultRecordVersion: 1,
    vaultRecordHash: "record",
  },
  createdAt: "2026-08-17T00:00:00Z",
  updatedAt: "2026-08-17T00:00:00Z",
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
  mocks.getVaultDownloadPlan.mockResolvedValue(downloadPlan);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        repository,
        entries: [encryptedEntry],
        snapshotVersion: 1,
        totalBytes: encryptedEntry.sizeBytes,
        totalEntries: 1,
        totalFiles: 1,
        totalEncryptedEntries: 1,
        nextCursor: null,
        hasMore: false,
      }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("encrypted repository ZIP", () => {
  it("consumes each bounded manifest page before requesting the next one", async () => {
    const folder: RepositoryArchiveEntry = {
      id: "folder",
      name: "src",
      mimeType: null,
      entryType: "folder",
      parentId: "root",
      sizeBytes: 0,
      e2eeState: "legacy",
      updatedAt: "2026-08-17T00:00:00Z",
      contentVersion: "2026-08-17T00:00:00.000001Z",
      vaultGenerationId: null,
      vaultRecordVersion: null,
      vaultRecordHash: null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          repository,
          entries: [folder],
          snapshotVersion: 3,
          totalBytes: encryptedEntry.sizeBytes,
          totalEntries: 2,
          totalFiles: 1,
          totalEncryptedEntries: 1,
          nextCursor: "second-page",
          hasMore: true,
        }),
      )
      .mockImplementationOnce(async () => {
        expect(mocks.zipAdd).toHaveBeenCalledTimes(2);
        return Response.json({
          repository,
          entries: [encryptedEntry],
          snapshotVersion: 3,
          totalBytes: encryptedEntry.sizeBytes,
          totalEntries: 2,
          totalFiles: 1,
          totalEncryptedEntries: 1,
          nextCursor: null,
          hasMore: false,
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    await downloadRepositoryArchive({
      repository,
      repositoryName: "project",
      vault: {
        state: "unlocked",
        client: {} as VaultCryptoClient,
        requestUnlock: vi.fn(),
        openNode: async () => encryptedManifest,
        isUnlocked: () => true,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/repositories/repository/archive-manifest?cursor=second-page",
      { signal: undefined, cache: "no-cache" },
    );
  });

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
    expect(mocks.readEncryptedFileStream).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: downloadPlan,
        manifest: encryptedManifest,
      }),
    );
    expect(mocks.triggerBlobDownload).toHaveBeenCalledOnce();
  });

  it("does not release decrypted ZIP output when the vault locks during compression", async () => {
    let unlocked = true;
    mocks.zipClose.mockImplementationOnce(async () => {
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
    mocks.readEncryptedFileStream.mockImplementationOnce(
      ({ signal }: { signal?: AbortSignal }) =>
        new ReadableStream<Uint8Array>({
          start(streamController) {
            signal?.addEventListener(
              "abort",
              () => streamController.error(signal.reason),
              { once: true },
            );
          },
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
      expect(mocks.readEncryptedFileStream).toHaveBeenCalledOnce(),
    );
    controller.abort();

    await expect(download).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.triggerBlobDownload).not.toHaveBeenCalled();
  });

  it("cancels in-flight ZIP compression without releasing its output", async () => {
    const controller = new AbortController();
    mocks.zipAdd.mockImplementation(
      async (
        _path: string,
        source?: ReadableStream<Uint8Array>,
        { signal }: { signal?: AbortSignal } = {},
      ) => {
        if (!source) return;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
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
    await vi.waitFor(() => expect(mocks.zipAdd).toHaveBeenCalledTimes(2));
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
          snapshotVersion: 1,
          totalBytes: legacyEntry.sizeBytes,
          totalEntries: 1,
          totalFiles: 1,
          totalEncryptedEntries: 0,
          nextCursor: null,
          hasMore: false,
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
