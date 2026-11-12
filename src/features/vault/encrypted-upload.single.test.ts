import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFetchBackedXhr } from "@/features/vault/fake-storage-xhr";
import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type { VaultEncryptionInput } from "@/features/vault/vault-messages";

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

import { uploadEncryptedSelections } from "@/features/vault/encrypted-upload";
import { VaultApiError } from "@/features/vault/vault-api";

const CIPHERTEXT_LENGTH = 24;

async function sha256Base64(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

// An API without the inline route sends every small file through the
// client-driven path; encrypted-upload.inline.test.ts covers inline batches.
describe("pre-encrypted single-object uploads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("XMLHttpRequest", createFetchBackedXhr().XMLHttpRequest);
    vaultApi.publishVaultInlineUploads.mockRejectedValue(
      new VaultApiError("not found", 404),
    );
    vaultApi.abortVaultUpload.mockResolvedValue(undefined);
    vaultApi.publishVaultFoldersBatch.mockResolvedValue({ folders: [] });
    vaultApi.publishVaultUpload.mockResolvedValue({
      nodeId: "node-small.txt",
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

  it("sends the checksum with init and PUTs to the signed URL it returns", async () => {
    vaultApi.initVaultUpload.mockResolvedValue({
      uploadId: "upload-small",
      nodeId: "node-small.txt",
      mode: "single",
      partSizeBytes: null,
      contentUrl: {
        url: "https://storage.invalid/small",
        contentLength: CIPHERTEXT_LENGTH,
      },
    });
    const puts: Array<{ url: string; body: Uint8Array; checksum: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        puts.push({
          url,
          body: new Uint8Array(init.body as ArrayBuffer).slice(),
          checksum:
            new Headers(init.headers).get("x-amz-checksum-sha256") ?? "",
        });
        return new Response(null, { status: 200 });
      }),
    );

    await runUpload();

    const expectedBody = new Uint8Array(CIPHERTEXT_LENGTH).fill(7);
    const checksum = await sha256Base64(expectedBody);
    expect(vaultApi.initVaultUpload).toHaveBeenCalledExactlyOnceWith(
      "csrf",
      expect.objectContaining({
        ciphertextLength: CIPHERTEXT_LENGTH,
        checksumSha256: checksum,
      }),
      expect.anything(),
    );
    expect(vaultApi.getVaultContentUrl).not.toHaveBeenCalled();
    expect(puts).toEqual([
      { url: "https://storage.invalid/small", body: expectedBody, checksum },
    ]);
    expect(vaultApi.publishVaultUpload).toHaveBeenCalledOnce();
  });

  it("falls back to the content-URL request when init returns no URL", async () => {
    vaultApi.initVaultUpload.mockResolvedValue({
      uploadId: "upload-small",
      nodeId: "node-small.txt",
      mode: "single",
      partSizeBytes: null,
    });
    vaultApi.getVaultContentUrl.mockResolvedValue({
      url: "https://storage.invalid/fallback",
      contentLength: CIPHERTEXT_LENGTH,
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await runUpload();

    expect(vaultApi.getVaultContentUrl).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://storage.invalid/fallback",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(vaultApi.publishVaultUpload).toHaveBeenCalledOnce();
  });

  it("aborts without uploading when the server plans a different mode", async () => {
    vaultApi.initVaultUpload.mockResolvedValue({
      uploadId: "upload-small",
      nodeId: "node-small.txt",
      mode: "multipart",
      partSizeBytes: 8,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runUpload()).rejects.toThrow(
      "The storage plan does not match the upload size.",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(vaultApi.abortVaultUpload).toHaveBeenCalledWith(
      "csrf",
      "upload-small",
    );
    expect(vaultApi.publishVaultUpload).not.toHaveBeenCalled();
  });
});

function runUpload() {
  return uploadEncryptedSelections({
    selections: [
      {
        file: new File([Uint8Array.of(1, 2, 3)], "small.txt"),
        relativePath: "small.txt",
      },
    ],
    parentFolderId: null,
    csrfToken: "csrf",
    client: createCryptoClient(),
    signal: new AbortController().signal,
    onProgress: () => undefined,
    onFileStart: () => undefined,
    onFileComplete: () => undefined,
  });
}

function createCryptoClient(): VaultCryptoClient {
  return {
    async startEncryption(input: VaultEncryptionInput) {
      return {
        sessionId: `session-${input.name}`,
        nodeId: `node-${input.name}`,
        generationNumber: 1,
        generationId: `generation-${input.name}`,
        recordVersion: 1,
        paddedBytes: CIPHERTEXT_LENGTH,
        ciphertextLength: CIPHERTEXT_LENGTH,
        chunkCount: 1,
      };
    },
    async encryptChunk() {
      return {
        ciphertext: new Uint8Array(CIPHERTEXT_LENGTH).fill(7).buffer,
        ciphertextBytes: CIPHERTEXT_LENGTH,
      };
    },
    async finalizeEncryption(sessionId: string) {
      return {
        nodeId: sessionId.replace("session-", "node-"),
        generationNumber: 1,
        generationId: sessionId.replace("session-", "generation-"),
        recordVersion: 1,
        ciphertextLength: CIPHERTEXT_LENGTH,
        chunkCount: 1,
        record: {
          bootstrapCbor: new Uint8Array(),
          bootstrapSignature: new Uint8Array(),
          encryptedManifest: new Uint8Array(),
          wrappers: [],
        },
      };
    },
    async abortEncryption() {},
  } as unknown as VaultCryptoClient;
}
