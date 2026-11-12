import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type { VaultEncryptionInput } from "@/features/vault/vault-messages";
import type { InlineUploadEntry } from "@/features/vault/vault-wire";

const vaultApi = vi.hoisted(() => ({
  abortVaultUpload: vi.fn(),
  getVaultContentUrl: vi.fn(),
  initVaultUpload: vi.fn(),
  publishVaultFoldersBatch: vi.fn(),
  publishVaultInlineUploads: vi.fn(),
  publishVaultUpload: vi.fn(),
}));

vi.mock("@/features/vault/vault-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/vault/vault-api")>()),
  ...vaultApi,
}));

import {
  uploadEncryptedSelections,
  VAULT_INLINE_FILE_MAX_BYTES,
} from "@/features/vault/encrypted-upload";
import { encryptedLength, padmeLength } from "@/features/vault/protocol";
import { VaultApiError } from "@/features/vault/vault-api";
import { VAULT_INLINE_UPLOAD_MAX_BYTES } from "@/features/vault/vault-wire";

const CIPHERTEXT_LENGTH = 24;

function paddedCiphertextLength(plaintextBytes: number) {
  return encryptedLength(padmeLength(plaintextBytes)).ciphertextBytes;
}

function publishedFor(entry: InlineUploadEntry) {
  const name = new TextDecoder().decode(entry.record.bootstrapCbor);
  return {
    published: {
      nodeId: `node-${name}`,
      generationNumber: 1,
      generationId: `generation-${name}`,
      recordVersion: 1,
      recordHash: `hash-${name}`,
      shareSyncRequired: false,
    },
  };
}

describe("inline small-file uploads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vaultApi.abortVaultUpload.mockResolvedValue(undefined);
    vaultApi.publishVaultFoldersBatch.mockResolvedValue({ folders: [] });
    vaultApi.publishVaultInlineUploads.mockImplementation(
      async (_csrfToken: string, uploads: InlineUploadEntry[]) => ({
        results: uploads.map(publishedFor),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("publishes small files without init, storage or publish requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const sent: Array<{ parentId: string | null; content: number[] }> = [];
    vaultApi.publishVaultInlineUploads.mockImplementation(
      async (_csrfToken: string, uploads: InlineUploadEntry[]) => {
        for (const upload of uploads) {
          sent.push({
            parentId: upload.parentId,
            content: Array.from(upload.content),
          });
        }
        return { results: uploads.map(publishedFor) };
      },
    );
    const onProgress = vi.fn();
    const completed: number[] = [];

    await runUpload({
      names: ["one.txt", "two.txt", "three.txt"],
      parentFolderId: "fil_parent",
      onProgress,
      onFileComplete: (index) => completed.push(index),
    });

    expect(sent).toHaveLength(3);
    expect(sent.every((upload) => upload.parentId === "fil_parent")).toBe(true);
    expect(sent[0].content).toEqual(Array(CIPHERTEXT_LENGTH).fill(7));
    expect(vaultApi.initVaultUpload).not.toHaveBeenCalled();
    expect(vaultApi.publishVaultUpload).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(completed.sort()).toEqual([0, 1, 2]);
    expect(onProgress).toHaveBeenLastCalledWith(9, 9, expect.any(Number), 3);
  });

  it("coalesces a folder of small files into a few batch requests", async () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
    let activeRequests = 0;
    let peakRequests = 0;
    const batchSizes: number[] = [];
    vaultApi.publishVaultInlineUploads.mockImplementation(
      async (_csrfToken: string, uploads: InlineUploadEntry[]) => {
        activeRequests += 1;
        peakRequests = Math.max(peakRequests, activeRequests);
        batchSizes.push(uploads.length);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeRequests -= 1;
        return { results: uploads.map(publishedFor) };
      },
    );

    await runUpload({
      names: Array.from({ length: 200 }, (_, index) => `file-${index}.txt`),
    });

    expect(batchSizes.reduce((total, size) => total + size, 0)).toBe(200);
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(32);
    expect(batchSizes.length).toBeLessThan(40);
    expect(peakRequests).toBeLessThanOrEqual(3);
  });

  it("fails the upload and releases the node key when the server rejects a file", async () => {
    vaultApi.publishVaultInlineUploads.mockImplementation(
      async (_csrfToken: string, uploads: InlineUploadEntry[]) => ({
        results: uploads.map(() => ({
          failed: { status: 409, message: "node head changed" },
        })),
      }),
    );
    const client = createCryptoClient();
    const failed: number[] = [];

    await expect(
      runUpload({
        names: ["conflict.txt"],
        client,
        onFileError: (index) => failed.push(index),
      }),
    ).rejects.toThrow("node head changed");

    expect(failed).toEqual([0]);
    expect(client.abortEncryption).toHaveBeenCalledWith(
      "session-conflict.txt",
      "node-conflict.txt",
    );
  });

  it("rejects a publication that names a different record", async () => {
    vaultApi.publishVaultInlineUploads.mockImplementation(
      async (_csrfToken: string, uploads: InlineUploadEntry[]) => ({
        results: uploads.map((upload) => ({
          published: {
            ...publishedFor(upload).published,
            nodeId: "node-other",
          },
        })),
      }),
    );

    await expect(runUpload({ names: ["swapped.txt"] })).rejects.toThrow(
      "The encrypted upload publication response is invalid.",
    );
  });

  it("re-encrypts through the client-driven path on an API without inline uploads", async () => {
    vaultApi.publishVaultInlineUploads.mockRejectedValue(
      new VaultApiError("not found", 404),
    );
    vaultApi.initVaultUpload.mockImplementation(
      async (_csrfToken: string, payload: { nodeId: string }) => ({
        uploadId: `upload-${payload.nodeId}`,
        nodeId: payload.nodeId,
        mode: "single",
        partSizeBytes: null,
        contentUrl: {
          url: `https://storage.invalid/${payload.nodeId}`,
          contentLength: CIPHERTEXT_LENGTH,
        },
      }),
    );
    vaultApi.publishVaultUpload.mockResolvedValue({
      nodeId: "node",
      generationNumber: 1,
      generationId: "generation",
      recordVersion: 1,
      recordHash: "hash",
      shareSyncRequired: false,
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createCryptoClient();

    await runUpload({ names: ["a.txt", "b.txt", "c.txt", "d.txt"], client });

    // Only the first batch probes the route; later files skip the inline lane.
    expect(vaultApi.publishVaultInlineUploads).toHaveBeenCalledTimes(1);
    expect(vaultApi.publishVaultUpload).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // The abandoned inline attempts released their node keys.
    expect(client.abortEncryption).toHaveBeenCalled();
  });

  it("falls back without holding more pending uploads than the client-driven lane", async () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
    vaultApi.publishVaultInlineUploads.mockRejectedValue(
      new VaultApiError("not found", 404),
    );
    // An upload is pending on the server from its init until its publication.
    let pendingUploads = 0;
    let peakPendingUploads = 0;
    vaultApi.initVaultUpload.mockImplementation(
      async (_csrfToken: string, payload: { nodeId: string }) => {
        pendingUploads += 1;
        peakPendingUploads = Math.max(peakPendingUploads, pendingUploads);
        return {
          uploadId: `upload-${payload.nodeId}`,
          nodeId: payload.nodeId,
          mode: "single",
          partSizeBytes: null,
          contentUrl: {
            url: `https://storage.invalid/${payload.nodeId}`,
            contentLength: CIPHERTEXT_LENGTH,
          },
        };
      },
    );
    vaultApi.publishVaultUpload.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      pendingUploads -= 1;
      return {
        nodeId: "node",
        generationNumber: 1,
        generationId: "generation",
        recordVersion: 1,
        recordHash: "hash",
        shareSyncRequired: false,
      };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    await runUpload({
      names: Array.from({ length: 60 }, (_, index) => `file-${index}.txt`),
    });

    expect(vaultApi.publishVaultUpload).toHaveBeenCalledTimes(60);
    expect(peakPendingUploads).toBeLessThanOrEqual(4);
  });

  it("sends the largest inline file within the wire limit", () => {
    expect(paddedCiphertextLength(VAULT_INLINE_FILE_MAX_BYTES)).toBe(
      VAULT_INLINE_FILE_MAX_BYTES + 16,
    );
    expect(
      paddedCiphertextLength(VAULT_INLINE_FILE_MAX_BYTES),
    ).toBeLessThanOrEqual(VAULT_INLINE_UPLOAD_MAX_BYTES);
    // One byte more pads to the whole limit, which leaves no room for the tag.
    expect(paddedCiphertextLength(VAULT_INLINE_FILE_MAX_BYTES + 1)).toBe(
      VAULT_INLINE_UPLOAD_MAX_BYTES + 16,
    );
  });

  it("keeps files above the inline size on the client-driven path", async () => {
    vaultApi.initVaultUpload.mockResolvedValue({
      uploadId: "upload-large",
      nodeId: "node-large.bin",
      mode: "single",
      partSizeBytes: null,
      contentUrl: {
        url: "https://storage.invalid/large",
        contentLength: VAULT_INLINE_UPLOAD_MAX_BYTES + 16,
      },
    });
    vaultApi.publishVaultUpload.mockResolvedValue({
      nodeId: "node-large.bin",
      generationNumber: 1,
      generationId: "generation-large.bin",
      recordVersion: 1,
      recordHash: "hash",
      shareSyncRequired: false,
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadEncryptedSelections({
      selections: [
        {
          file: new File(
            [new Uint8Array(VAULT_INLINE_FILE_MAX_BYTES + 1)],
            "large.bin",
          ),
          relativePath: "large.bin",
        },
        {
          file: new File(
            [new Uint8Array(VAULT_INLINE_FILE_MAX_BYTES)],
            "small.bin",
          ),
          relativePath: "small.bin",
        },
      ],
      parentFolderId: null,
      csrfToken: "csrf",
      client: createCryptoClient(paddedCiphertextLength),
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onFileStart: () => undefined,
      onFileComplete: () => undefined,
    });

    expect(vaultApi.initVaultUpload).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vaultApi.publishVaultInlineUploads).toHaveBeenCalledTimes(1);
    const inline: InlineUploadEntry[] =
      vaultApi.publishVaultInlineUploads.mock.calls[0][1];
    expect(inline).toHaveLength(1);
    expect(new TextDecoder().decode(inline[0].record.bootstrapCbor)).toBe(
      "small.bin",
    );
    expect(inline[0].content).toHaveLength(VAULT_INLINE_FILE_MAX_BYTES + 16);
  });
});

function runUpload({
  names,
  parentFolderId = null,
  client = createCryptoClient(),
  onProgress = () => undefined,
  onFileComplete = () => undefined,
  onFileError,
}: {
  names: string[];
  parentFolderId?: string | null;
  client?: VaultCryptoClient;
  onProgress?: (...values: number[]) => void;
  onFileComplete?: (index: number) => void;
  onFileError?: (index: number) => void;
}) {
  return uploadEncryptedSelections({
    selections: names.map((name) => ({
      file: new File([Uint8Array.of(1, 2, 3)], name),
      relativePath: name,
    })),
    parentFolderId,
    csrfToken: "csrf",
    client,
    signal: new AbortController().signal,
    onProgress,
    onFileStart: () => undefined,
    onFileComplete,
    onFileError,
  });
}

function createCryptoClient(
  ciphertextLength: (plaintextBytes: number) => number = () =>
    CIPHERTEXT_LENGTH,
): VaultCryptoClient {
  const lengths = new Map<string, number>();
  return {
    async startEncryption(input: VaultEncryptionInput) {
      const length = ciphertextLength(input.plaintextBytes);
      lengths.set(`session-${input.name}`, length);
      return {
        sessionId: `session-${input.name}`,
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
      const length = lengths.get(sessionId) ?? CIPHERTEXT_LENGTH;
      return {
        ciphertext: new Uint8Array(length).fill(7).buffer,
        ciphertextBytes: length,
      };
    },
    async finalizeEncryption(sessionId: string) {
      const name = sessionId.replace("session-", "");
      return {
        nodeId: `node-${name}`,
        generationNumber: 1,
        generationId: `generation-${name}`,
        recordVersion: 1,
        ciphertextLength: lengths.get(sessionId) ?? CIPHERTEXT_LENGTH,
        chunkCount: 1,
        record: {
          // The test server reads the file name back out of the record.
          bootstrapCbor: new TextEncoder().encode(name),
          bootstrapSignature: new Uint8Array(64),
          encryptedManifest: new Uint8Array(16),
          wrappers: [],
        },
      };
    },
    abortEncryption: vi.fn(async () => undefined),
  } as unknown as VaultCryptoClient;
}
