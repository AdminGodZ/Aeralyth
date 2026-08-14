import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type { VaultEncryptionInput } from "@/features/vault/vault-messages";

const vaultApi = vi.hoisted(() => ({
  abortVaultUpload: vi.fn(),
  getVaultContentUrl: vi.fn(),
  getVaultPartUrls: vi.fn(),
  initVaultUpload: vi.fn(),
  publishVaultUpload: vi.fn(),
}));

vi.mock("@/features/vault/vault-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/vault/vault-api")>()),
  ...vaultApi,
}));

import { uploadEncryptedSelections } from "@/features/vault/encrypted-upload";

const emptyRecord = {
  bootstrapCbor: "bootstrap",
  bootstrapSignature: "signature",
  encryptedManifest: "manifest",
  wrappers: [],
};

describe("encrypted upload scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vaultApi.abortVaultUpload.mockResolvedValue(undefined);
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
        existingParts: [],
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
      existingParts: [],
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
