import { afterEach, describe, expect, it, vi } from "vitest";

import {
  downloadEncryptedFile,
  MAX_IN_MEMORY_DOWNLOAD_BYTES,
  readEncryptedFileBlob,
  readEncryptedFileStream,
} from "@/features/vault/encrypted-download";
import {
  VAULT_CRYPTO_CHUNK_BYTES,
  type VaultDownloadPlan,
  type VaultManifest,
} from "@/features/vault/protocol";
import type { VaultCryptoClient } from "@/features/vault/vault-client";

const manifest: VaultManifest = {
  name: "fragmented.bin",
  mimeType: "application/octet-stream",
  entryType: "file",
  plaintextBytes: 2,
  paddedBytes: VAULT_CRYPTO_CHUNK_BYTES + 107,
  lastModified: 0,
  parentId: null,
  chunkCount: 2,
  generationId: new Uint8Array(16),
  createdAt: 0,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("encrypted download buffering", () => {
  it("assembles fragmented network reads into exact transferable chunks", async () => {
    const firstChunkBytes = VAULT_CRYPTO_CHUNK_BYTES + 16;
    const secondChunkBytes = 123;
    const ciphertext = new Uint8Array(firstChunkBytes + secondChunkBytes);
    ciphertext.fill(3, 0, firstChunkBytes);
    ciphertext.fill(9, firstChunkBytes);
    const networkChunkBytes = 64 * 1024;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (
          let offset = 0;
          offset < ciphertext.length;
          offset += networkChunkBytes
        ) {
          controller.enqueue(
            ciphertext.slice(
              offset,
              Math.min(ciphertext.length, offset + networkChunkBytes),
            ),
          );
        }
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const received: Uint8Array[] = [];
    let finalized = false;
    const client = {
      async startDecryption() {
        return { sessionId: "session", manifest };
      },
      async decryptChunk(
        _sessionId: string,
        chunkIndex: number,
        chunk: ArrayBuffer,
      ) {
        received.push(new Uint8Array(chunk));
        return {
          plaintext: Uint8Array.of(chunkIndex + 1).buffer,
          plaintextBytes: 1,
        };
      },
      async finalizeDecryption() {
        finalized = true;
      },
      async abortDecryption() {},
    } as unknown as VaultCryptoClient;
    const plan = {
      nodeId: "node",
      entryType: "file",
      generationNumber: 1,
      generationId: "generation",
      ciphertextLength: ciphertext.length,
      cryptoChunkBytes: VAULT_CRYPTO_CHUNK_BYTES,
      chunkCount: 2,
      ciphertextMerkleRoot: "root",
      downloadUrl: "https://storage.invalid/object",
      bootstrapCbor: "",
      bootstrapSignature: "",
      encryptedManifest: "",
      wrappers: [],
      signerKeyVersion: 1,
      signerEd25519PublicKey: "",
      recordVersion: 1,
      recordHash: "",
      share: null,
    } satisfies VaultDownloadPlan;

    const blob = await readEncryptedFileBlob({ plan, manifest, client });

    expect(received).toHaveLength(2);
    expect(received[0]).toHaveLength(firstChunkBytes);
    expect(received[0]?.[0]).toBe(3);
    expect(received[0]?.[firstChunkBytes - 1]).toBe(3);
    expect(received[1]).toHaveLength(secondChunkBytes);
    expect(received[1]?.[0]).toBe(9);
    expect(finalized).toBe(true);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      Uint8Array.of(1, 2),
    );
  });

  it("releases a decryption session that starts after the network fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    );
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const aborted: string[] = [];
    const client = {
      async startDecryption() {
        await startGate;
        return { sessionId: "late-session", manifest };
      },
      async abortDecryption(sessionId: string) {
        aborted.push(sessionId);
      },
    } as unknown as VaultCryptoClient;
    const plan = testPlan(1);

    const download = readEncryptedFileBlob({ plan, manifest, client });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    releaseStart?.();

    await expect(download).rejects.toThrow("network unavailable");
    expect(aborted).toEqual(["late-session"]);
  });

  it("aborts an active decryption session when ciphertext validation fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(1), {
            status: 200,
          }),
      ),
    );
    const aborted: string[] = [];
    const client = {
      async startDecryption() {
        return { sessionId: "active-session", manifest };
      },
      async abortDecryption(sessionId: string) {
        aborted.push(sessionId);
      },
    } as unknown as VaultCryptoClient;

    await expect(
      readEncryptedFileBlob({
        plan: testPlan(VAULT_CRYPTO_CHUNK_BYTES + 16),
        manifest,
        client,
      }),
    ).rejects.toThrow("ended before all chunks arrived");
    expect(aborted).toEqual(["active-session"]);
  });

  it("rejects an unsafe large in-memory fallback before starting I/O", async () => {
    vi.stubGlobal("navigator", { storage: {} });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = {
      startDecryption: vi.fn(),
    } as unknown as VaultCryptoClient;

    await expect(
      downloadEncryptedFile({
        plan: testPlan(1),
        manifest: {
          ...manifest,
          chunkCount: 1,
          paddedBytes: 1,
          plaintextBytes: MAX_IN_MEMORY_DOWNLOAD_BYTES + 1,
        },
        client,
      }),
    ).rejects.toThrow("cannot stream this large download to disk");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.startDecryption).not.toHaveBeenCalled();
  });

  it("streams compatibility downloads through OPFS and removes the temp entry", async () => {
    vi.useFakeTimers();
    const writes: ArrayBuffer[] = [];
    const writable = {
      write: vi.fn(async (data: ArrayBuffer) => {
        writes.push(data);
      }),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const removeEntry = vi.fn(async () => undefined);
    const getFile = vi.fn(async () => new Blob(writes) as unknown as File);
    const getFileHandle = vi.fn(async () => ({
      createWritable: async () => writable,
      getFile,
    }));
    const getDirectory = vi.fn(async () => ({
      getFileHandle,
      removeEntry,
    }));
    vi.stubGlobal("navigator", { storage: { getDirectory } });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(Uint8Array.of(5), {
            status: 200,
          }),
      ),
    );
    const anchor = {
      href: "",
      download: "",
      rel: "",
      click: vi.fn(),
    };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
    });
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:aeralyth-test");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const client = {
      async startDecryption() {
        return { sessionId: "session", manifest };
      },
      async decryptChunk() {
        return { plaintext: Uint8Array.of(7).buffer, plaintextBytes: 1 };
      },
      async finalizeDecryption() {},
      async abortDecryption() {},
    } as unknown as VaultCryptoClient;

    await downloadEncryptedFile({
      plan: testPlan(1),
      manifest: {
        ...manifest,
        chunkCount: 1,
        paddedBytes: 1,
        plaintextBytes: 1,
      },
      client,
    });

    expect(writes.map((part) => Array.from(new Uint8Array(part)))).toEqual([
      [7],
    ]);
    expect(writable.close).toHaveBeenCalledOnce();
    expect(getFile).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchor.download).toBe("fragmented.bin");
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(removeEntry).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:aeralyth-test");
    expect(removeEntry).toHaveBeenCalledOnce();
  });

  it("backpressures decrypted archive streams to one queued plaintext chunk", async () => {
    const ciphertextLength = 2 * (VAULT_CRYPTO_CHUNK_BYTES + 16) + 1;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(ciphertextLength), {
            status: 200,
          }),
      ),
    );
    const streamManifest: VaultManifest = {
      ...manifest,
      plaintextBytes: 3,
      paddedBytes: 3,
      chunkCount: 3,
    };
    const decryptChunk = vi.fn(
      async (_sessionId: string, chunkIndex: number) => ({
        plaintext: Uint8Array.of(chunkIndex + 10).buffer,
        plaintextBytes: 1,
      }),
    );
    const client = {
      async startDecryption() {
        return { sessionId: "stream-session", manifest: streamManifest };
      },
      decryptChunk,
      async finalizeDecryption() {},
      async abortDecryption() {},
    } as unknown as VaultCryptoClient;
    const stream = readEncryptedFileStream({
      plan: { ...testPlan(ciphertextLength), chunkCount: 3 },
      manifest: streamManifest,
      client,
    });
    const reader = stream.getReader();

    expect(await reader.read()).toMatchObject({
      done: false,
      value: Uint8Array.of(10),
    });
    await vi.waitFor(() => expect(decryptChunk).toHaveBeenCalledTimes(2));
    expect(decryptChunk).toHaveBeenCalledTimes(2);
    expect(await reader.read()).toMatchObject({
      done: false,
      value: Uint8Array.of(11),
    });
    await vi.waitFor(() => expect(decryptChunk).toHaveBeenCalledTimes(3));
    expect(await reader.read()).toMatchObject({
      done: false,
      value: Uint8Array.of(12),
    });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });
});

function testPlan(ciphertextLength: number): VaultDownloadPlan {
  return {
    nodeId: "node",
    entryType: "file",
    generationNumber: 1,
    generationId: "generation",
    ciphertextLength,
    cryptoChunkBytes: VAULT_CRYPTO_CHUNK_BYTES,
    chunkCount: 1,
    ciphertextMerkleRoot: "root",
    downloadUrl: "https://storage.invalid/object",
    bootstrapCbor: "",
    bootstrapSignature: "",
    encryptedManifest: "",
    wrappers: [],
    signerKeyVersion: 1,
    signerEd25519PublicKey: "",
    recordVersion: 1,
    recordHash: "",
    share: null,
  };
}
