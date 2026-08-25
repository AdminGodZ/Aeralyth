import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type { VaultEncryptionInput } from "@/features/vault/vault-messages";

const vaultApi = vi.hoisted(() => ({
  abortVaultUpload: vi.fn(),
  getVaultContentUrl: vi.fn(),
  getVaultPartUrl: vi.fn(),
  getVaultPartUrls: vi.fn(),
  initVaultUpload: vi.fn(),
  publishVaultFoldersBatch: vi.fn(),
  publishVaultUpload: vi.fn(),
}));

vi.mock("@/features/vault/vault-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/vault/vault-api")>()),
  ...vaultApi,
}));

import { uploadEncryptedSelections } from "@/features/vault/encrypted-upload";

const emptyRecord = {
  bootstrapCbor: new Uint8Array(),
  bootstrapSignature: new Uint8Array(),
  encryptedManifest: new Uint8Array(),
  wrappers: [],
};

describe("encrypted upload scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vaultApi.abortVaultUpload.mockResolvedValue(undefined);
    vaultApi.publishVaultFoldersBatch.mockResolvedValue({ folders: [] });
    vaultApi.publishVaultUpload.mockResolvedValue({
      nodeId: "node",
      generationNumber: 1,
      generationId: "generation",
      recordVersion: 1,
      recordHash: "record-hash",
      shareSyncRequired: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs three small encrypted files concurrently", async () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
    let activePuts = 0;
    let peakPuts = 0;
    let releasePuts: (() => void) | undefined;
    const putGate = new Promise<void>((resolve) => {
      releasePuts = resolve;
    });
    vaultApi.initVaultUpload.mockImplementation(
      async (_csrfToken, payload: { nodeId: string }) => ({
        uploadId: `upload-${payload.nodeId}`,
        nodeId: payload.nodeId,
        mode: "single",
        partSizeBytes: null,
      }),
    );
    vaultApi.getVaultContentUrl.mockImplementation(
      async (_csrfToken, uploadId: string) => ({
        url: `https://storage.invalid/${uploadId}`,
        contentLength: 1,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        activePuts += 1;
        peakPuts = Math.max(peakPuts, activePuts);
        await putGate;
        activePuts -= 1;
        return new Response(null, { status: 200 });
      }),
    );

    const client = createCryptoClient(() => 1);
    const upload = uploadEncryptedSelections({
      selections: ["one", "two", "three"].map((name) => ({
        file: new File([Uint8Array.of(1)], `${name}.txt`),
        relativePath: `${name}.txt`,
      })),
      parentFolderId: null,
      csrfToken: "csrf",
      client,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onFileStart: () => undefined,
      onFileComplete: () => undefined,
    });

    await vi.waitFor(() => expect(activePuts).toBe(3));
    releasePuts?.();
    await upload;

    expect(peakPuts).toBe(3);
    expect(vaultApi.publishVaultUpload).toHaveBeenCalledTimes(3);
  });

  it("refreshes an expired single-upload signature before retrying", async () => {
    vaultApi.initVaultUpload.mockResolvedValue({
      uploadId: "upload-refresh",
      nodeId: "node-refresh",
      mode: "single",
      partSizeBytes: null,
    });
    vaultApi.getVaultContentUrl
      .mockResolvedValueOnce({
        url: "https://storage.invalid/expired",
        contentLength: 1,
      })
      .mockResolvedValueOnce({
        url: "https://storage.invalid/refreshed",
        contentLength: 1,
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<Code>ExpiredToken</Code>", { status: 403 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadEncryptedSelections({
      selections: [
        {
          file: new File([Uint8Array.of(1)], "refresh.bin"),
          relativePath: "refresh.bin",
        },
      ],
      parentFolderId: null,
      csrfToken: "csrf",
      client: createCryptoClient(() => 1),
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onFileStart: () => undefined,
      onFileComplete: () => undefined,
    });

    expect(vaultApi.getVaultContentUrl).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://storage.invalid/expired",
      "https://storage.invalid/refreshed",
    ]);
  });

  it("presigns four parts once, uploads them concurrently, and publishes in order", async () => {
    let activePuts = 0;
    let peakPuts = 0;
    let releaseFirstBatch: (() => void) | undefined;
    const firstBatchGate = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    });
    vaultApi.initVaultUpload.mockResolvedValue({
      uploadId: "upload-multipart",
      nodeId: "node-multipart",
      mode: "multipart",
      partSizeBytes: 8,
    });
    vaultApi.getVaultPartUrls.mockImplementation(
      async (_csrfToken, _uploadId, parts: Array<{ partNumber: number }>) => ({
        parts: parts.map(({ partNumber }) => ({
          partNumber,
          url: `https://storage.invalid/part-${partNumber}`,
          contentLength: 8,
        })),
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const partNumber = Number(String(input).split("-").at(-1));
        activePuts += 1;
        peakPuts = Math.max(peakPuts, activePuts);
        if (partNumber <= 4) await firstBatchGate;
        activePuts -= 1;
        return new Response(null, {
          status: 200,
          headers: { ETag: `"etag-${partNumber}"` },
        });
      }),
    );

    const client = createCryptoClient(() => 40);
    const upload = uploadEncryptedSelections({
      selections: [
        {
          file: new File([Uint8Array.of(1)], "multipart.bin"),
          relativePath: "multipart.bin",
        },
      ],
      parentFolderId: null,
      csrfToken: "csrf",
      client,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onFileStart: () => undefined,
      onFileComplete: () => undefined,
    });

    await vi.waitFor(() => expect(activePuts).toBe(4));
    expect(vaultApi.getVaultPartUrls).toHaveBeenCalledTimes(1);
    releaseFirstBatch?.();
    await upload;

    expect(peakPuts).toBe(4);
    expect(vaultApi.getVaultPartUrls).toHaveBeenCalledTimes(2);
    expect(
      vaultApi.getVaultPartUrls.mock.calls.map((call) =>
        call[2].map((part: { partNumber: number }) => part.partNumber),
      ),
    ).toEqual([[1, 2, 3, 4], [5]]);
    expect(vaultApi.publishVaultUpload.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({ partNumber: 1, etag: '"etag-1"' }),
      expect.objectContaining({ partNumber: 2, etag: '"etag-2"' }),
      expect.objectContaining({ partNumber: 3, etag: '"etag-3"' }),
      expect.objectContaining({ partNumber: 4, etag: '"etag-4"' }),
      expect.objectContaining({ partNumber: 5, etag: '"etag-5"' }),
    ]);
  });

  it("publishes parent-ordered folders in one batch without staging folder uploads", async () => {
    vaultApi.publishVaultFoldersBatch.mockResolvedValue({
      folders: ["root", "nested"].map((name) => ({
        nodeId: `node-${name}`,
        generationNumber: 1,
        generationId: `generation-${name}`,
        recordVersion: 1,
        recordHash: `record-${name}`,
        shareSyncRequired: false,
      })),
    });
    vaultApi.initVaultUpload.mockResolvedValue({
      uploadId: "upload-file",
      nodeId: "node-file.txt",
      mode: "single",
      partSizeBytes: null,
    });
    vaultApi.getVaultContentUrl.mockResolvedValue({
      url: "https://storage.invalid/file",
      contentLength: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const client = createCryptoClient(() => 1);
    const startEncryption = vi.spyOn(client, "startEncryption");

    const result = await uploadEncryptedSelections({
      selections: [
        {
          file: new File([Uint8Array.of(1)], "file.txt"),
          relativePath: "root/nested/file.txt",
        },
      ],
      parentFolderId: null,
      csrfToken: "csrf",
      client,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onFileStart: () => undefined,
      onFileComplete: () => undefined,
    });

    expect(result.rootFolderId).toBe("node-root");
    expect(vaultApi.publishVaultFoldersBatch).toHaveBeenCalledTimes(1);
    expect(vaultApi.publishVaultFoldersBatch.mock.calls[0]?.[1]).toHaveLength(
      2,
    );
    expect(vaultApi.initVaultUpload).toHaveBeenCalledTimes(1);
    expect(startEncryption.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        entryType: "folder",
        name: "root",
        parentId: null,
      }),
      expect.objectContaining({
        entryType: "folder",
        name: "nested",
        parentId: "node-root",
      }),
      expect.objectContaining({
        entryType: "file",
        name: "file.txt",
        parentId: "node-nested",
      }),
    ]);
  });

  it("discards every unpublished folder key when a batch is rejected", async () => {
    vaultApi.publishVaultFoldersBatch.mockRejectedValue(
      new Error("batch rejected"),
    );
    const client = createCryptoClient(() => 1);
    const abortEncryption = vi.spyOn(client, "abortEncryption");

    await expect(
      uploadEncryptedSelections({
        selections: [
          {
            file: new File([Uint8Array.of(1)], "file.txt"),
            relativePath: "root/nested/file.txt",
          },
        ],
        parentFolderId: null,
        csrfToken: "csrf",
        client,
        signal: new AbortController().signal,
        onProgress: () => undefined,
        onFileStart: () => undefined,
        onFileComplete: () => undefined,
      }),
    ).rejects.toThrow("batch rejected");

    expect(abortEncryption.mock.calls).toEqual(
      expect.arrayContaining([
        ["session-root", "node-root"],
        ["session-nested", "node-nested"],
      ]),
    );
    expect(vaultApi.initVaultUpload).not.toHaveBeenCalled();
  });

  it("rejects folder ancestry beyond the server safety bound before encryption", async () => {
    const client = createCryptoClient(() => 1);
    const startEncryption = vi.spyOn(client, "startEncryption");
    const relativePath = `${Array.from({ length: 101 }, (_, index) => `d${index}`).join("/")}/file.txt`;

    await expect(
      uploadEncryptedSelections({
        selections: [
          {
            file: new File([Uint8Array.of(1)], "file.txt"),
            relativePath,
          },
        ],
        parentFolderId: null,
        csrfToken: "csrf",
        client,
        signal: new AbortController().signal,
        onProgress: () => undefined,
        onFileStart: () => undefined,
        onFileComplete: () => undefined,
      }),
    ).rejects.toThrow("exceeds 100 levels");

    expect(startEncryption).not.toHaveBeenCalled();
    expect(vaultApi.publishVaultFoldersBatch).not.toHaveBeenCalled();
  });

  it("publishes a 10,000-folder import in bounded parent-ordered batches", async () => {
    const branchCount = 100;
    const branchDepth = 100;
    const selections = Array.from({ length: branchCount }, (_, branch) => ({
      file: new File([Uint8Array.of(1)], `file-${branch}.txt`),
      relativePath: `${Array.from(
        { length: branchDepth },
        (_, depth) =>
          `b${branch.toString().padStart(3, "0")}-d${depth
            .toString()
            .padStart(3, "0")}`,
      ).join("/")}/file-${branch}.txt`,
    }));
    const expectedFolderNames = Array.from(
      { length: branchDepth },
      (_, depth) =>
        Array.from(
          { length: branchCount },
          (_, branch) =>
            `b${branch.toString().padStart(3, "0")}-d${depth
              .toString()
              .padStart(3, "0")}`,
        ),
    ).flat();
    let published = 0;
    vaultApi.publishVaultFoldersBatch.mockImplementation(
      async (_csrfToken, records: unknown[]) => {
        const names = expectedFolderNames.slice(
          published,
          published + records.length,
        );
        published += records.length;
        return {
          folders: names.map((name) => ({
            nodeId: `node-${name}`,
            generationNumber: 1,
            generationId: `generation-${name}`,
            recordVersion: 1,
            recordHash: `record-${name}`,
            shareSyncRequired: false,
          })),
        };
      },
    );
    const client = createCryptoClient(() => 1);
    const startEncryption = vi.spyOn(client, "startEncryption");

    await expect(
      uploadEncryptedSelections({
        selections,
        parentFolderId: null,
        csrfToken: "csrf",
        client,
        signal: new AbortController().signal,
        onProgress: () => undefined,
        onFileStart: () => {
          throw new Error("folder scale fixture complete");
        },
        onFileComplete: () => undefined,
      }),
    ).rejects.toThrow("folder scale fixture complete");

    expect(published).toBe(10_000);
    expect(vaultApi.publishVaultFoldersBatch).toHaveBeenCalledTimes(100);
    expect(
      vaultApi.publishVaultFoldersBatch.mock.calls.every(
        ([, records]) => records.length === 100,
      ),
    ).toBe(true);
    expect(startEncryption).toHaveBeenCalledTimes(10_000);
    expect(vaultApi.initVaultUpload).not.toHaveBeenCalled();
  });
});

function createCryptoClient(
  ciphertextLength: (fileName: string) => number,
): VaultCryptoClient {
  const lengths = new Map<string, number>();
  return {
    async startEncryption(input: VaultEncryptionInput) {
      const length = ciphertextLength(input.name);
      const sessionId = `session-${input.name}`;
      lengths.set(sessionId, length);
      return {
        sessionId,
        nodeId: `node-${input.name}`,
        generationNumber: 1,
        generationId: `generation-${input.name}`,
        recordVersion: 1,
        paddedBytes: length,
        ciphertextLength: length,
        chunkCount: 1,
      };
    },
    async encryptChunk(sessionId: string) {
      const length = lengths.get(sessionId);
      if (!length) throw new Error("Unknown encryption session.");
      return {
        ciphertext: new Uint8Array(length).fill(7).buffer,
        ciphertextBytes: length,
      };
    },
    async finalizeEncryption(sessionId: string) {
      const length = lengths.get(sessionId);
      if (!length) throw new Error("Unknown encryption session.");
      return {
        nodeId: sessionId.replace("session-", "node-"),
        generationNumber: 1,
        generationId: sessionId.replace("session-", "generation-"),
        recordVersion: 1,
        ciphertextLength: length,
        chunkCount: 1,
        record: emptyRecord,
      };
    },
    async abortEncryption() {},
  } as unknown as VaultCryptoClient;
}
