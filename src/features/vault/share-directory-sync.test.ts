import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VaultShareSyncJob } from "@/features/vault/vault-api";
import type { VaultCryptoClient } from "@/features/vault/vault-client";

const api = vi.hoisted(() => ({
  getActiveShareContexts: vi.fn(),
  getShareSyncJobs: vi.fn(),
  getVaultDownloadPlan: vi.fn(),
  publishShareDirectory: vi.fn(),
}));

vi.mock("@/features/vault/vault-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/vault/vault-api")>()),
  ...api,
}));

import {
  beginShareDirectorySyncBatch,
  cancelShareDirectorySyncForLock,
  enqueueShareDirectorySync,
  finishShareDirectorySyncBatch,
} from "@/features/vault/share-directory-sync";

const contexts = [
  {
    shareId: "shr_example",
    epoch: 1,
    wrapperId: "wrapper",
    ciphertext: "ciphertext",
  },
];

function job(nodeId: string): VaultShareSyncJob {
  return {
    nodeId,
    contextCacheKey: "parent-folder",
    entryType: "file",
    generationNumber: 1,
    generationId: "generation",
    recordVersion: 1,
    recordHash: "record",
  };
}

function client() {
  return {
    createShareDirectory: vi.fn(async () => ({
      directoryCbor: new Uint8Array(),
      directorySignature: new Uint8Array(),
      wrappers: [],
    })),
    clearShareContextCache: vi.fn(async () => undefined),
    openPlan: vi.fn(),
  } as unknown as VaultCryptoClient;
}

describe("batch-scoped share-directory sync", () => {
  beforeEach(() => {
    cancelShareDirectorySyncForLock();
    vi.clearAllMocks();
    api.getActiveShareContexts.mockResolvedValue(contexts);
    api.publishShareDirectory.mockResolvedValue(undefined);
  });

  it("fetches sibling contexts once and reuses one worker cache key", async () => {
    const cryptoClient = client();
    const batchId = beginShareDirectorySyncBatch();

    await enqueueShareDirectorySync({
      csrfToken: "csrf",
      client: cryptoClient,
      batchId,
      job: job("file-one"),
    });
    await enqueueShareDirectorySync({
      csrfToken: "csrf",
      client: cryptoClient,
      batchId,
      job: job("file-two"),
    });
    await finishShareDirectorySyncBatch({ batchId, client: cryptoClient });

    expect(api.getActiveShareContexts).toHaveBeenCalledOnce();
    expect(cryptoClient.createShareDirectory).toHaveBeenCalledTimes(2);
    const inputs = vi.mocked(cryptoClient.createShareDirectory).mock.calls;
    expect(inputs[0]?.[0].shareContextCacheKey).toBe(
      `${batchId}:parent-folder`,
    );
    expect(inputs[1]?.[0].shareContextCacheKey).toBe(
      `${batchId}:parent-folder`,
    );
    expect(cryptoClient.clearShareContextCache).toHaveBeenCalledOnce();
  });

  it("invalidates fetched and decrypted contexts after a fence error", async () => {
    const cryptoClient = client();
    const batchId = beginShareDirectorySyncBatch();
    api.publishShareDirectory
      .mockRejectedValueOnce(new Error("active shares changed"))
      .mockResolvedValueOnce(undefined);

    await enqueueShareDirectorySync({
      csrfToken: "csrf",
      client: cryptoClient,
      batchId,
      job: job("file-one"),
    });
    await enqueueShareDirectorySync({
      csrfToken: "csrf",
      client: cryptoClient,
      batchId,
      job: job("file-two"),
    });
    await finishShareDirectorySyncBatch({ batchId, client: cryptoClient });

    expect(api.getActiveShareContexts).toHaveBeenCalledTimes(2);
    expect(cryptoClient.clearShareContextCache).toHaveBeenCalledTimes(2);
  });

  it("cancels an in-flight directory build before it can publish after lock", async () => {
    const cryptoClient = client();
    const batchId = beginShareDirectorySyncBatch();
    let resolveDirectory: (() => void) | undefined;
    vi.mocked(cryptoClient.createShareDirectory).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDirectory = () =>
            resolve({
              directoryCbor: new Uint8Array(),
              directorySignature: new Uint8Array(),
              wrappers: [],
            });
        }),
    );

    const pending = enqueueShareDirectorySync({
      csrfToken: "csrf",
      client: cryptoClient,
      batchId,
      job: job("file-one"),
    });
    await vi.waitFor(() => {
      expect(cryptoClient.createShareDirectory).toHaveBeenCalledOnce();
    });

    cancelShareDirectorySyncForLock();
    resolveDirectory?.();
    await pending;
    await finishShareDirectorySyncBatch({ batchId, client: cryptoClient });

    expect(api.publishShareDirectory).not.toHaveBeenCalled();
    expect(cryptoClient.clearShareContextCache).toHaveBeenCalled();
  });
});
