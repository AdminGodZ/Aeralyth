import { afterEach, describe, expect, it, vi } from "vitest";

import { readEncryptedFileBlob } from "@/features/vault/encrypted-download";
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
});
