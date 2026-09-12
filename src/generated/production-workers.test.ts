import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";
import type { FolderZipWorkerResponse } from "@/features/dashboard/folder-zip-messages";
import { decodeBootstrap } from "@/features/vault/cbor";
import {
  VAULT_CRYPTO_CHUNK_BYTES,
  type VaultDownloadPlan,
} from "@/features/vault/protocol";
import type {
  VaultWorkerRequest,
  VaultWorkerResponse,
  VaultWorkerResult,
} from "@/features/vault/vault-messages";
import {
  FOLDER_ZIP_WORKER_URL,
  UPLOAD_CHECKSUM_WORKER_URL,
  VAULT_WORKER_URL,
} from "@/generated/worker-assets";
import { ZIP_WASM_URL } from "@/generated/zip-assets";

const root = resolve(import.meta.dirname, "../..");
const host = resolve(root, "scripts/test-fixtures/production-worker-host.mjs");
const timeoutMs = 30_000;

function nextMessage<T>(
  worker: Worker,
  matches: (value: T) => boolean,
): Promise<T> {
  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("Production worker did not respond.")),
      timeoutMs,
    );
    const onMessage = (value: T) => {
      if (matches(value)) {
        cleanup();
        resolveMessage(value);
      }
    };
    const finish = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("error", finish);
    };
    worker.on("message", onMessage);
    worker.once("error", finish);
  });
}

async function emittedWorker(url: string, forceWasm = false) {
  const worker = new Worker(host, {
    workerData: {
      modulePath: resolve(root, `public${url}`),
      url: `http://localhost${url}`,
      forceWasm,
      wasmUrl: ZIP_WASM_URL,
      wasmPath: resolve(root, `public${ZIP_WASM_URL}`),
    },
  });
  try {
    await nextMessage<{ hostReady?: boolean }>(
      worker,
      (value) => value.hostReady === true,
    );
    return worker;
  } catch (error) {
    await worker.terminate();
    throw error;
  }
}

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}

describe("the exact production worker bundles", () => {
  it("hashes empty, known, and multichunk inputs with the emitted checksum worker", async () => {
    const worker = await emittedWorker(UPLOAD_CHECKSUM_WORKER_URL);
    try {
      const inputs = [
        new Uint8Array(),
        new TextEncoder().encode("abc"),
        new Uint8Array(5 * 1024 * 1024 + 7).fill(0xa5),
      ];
      for (const [id, input] of inputs.entries()) {
        const result = nextMessage<{
          id: number;
          type: string;
          checksumSha256?: string;
        }>(worker, (value) => value.id === id);
        worker.postMessage({ id, type: "hash", blob: new Blob([input]) });
        expect(await result).toEqual({
          id,
          type: "complete",
          checksumSha256: createHash("sha256").update(input).digest("base64"),
        });
      }
    } finally {
      await worker.terminate();
    }
  });

  it("creates and reads a ZIP using the emitted worker and its real WASM fallback", async () => {
    const worker = await emittedWorker(FOLDER_ZIP_WORKER_URL, true);
    const requestedAssets: string[] = [];
    worker.on("message", (value) => {
      if (value.hostAssetRequest) requestedAssets.push(value.hostAssetRequest);
    });
    const text = "Production worker ZIP and WASM round trip.\n".repeat(8_192);
    try {
      const result = nextMessage<FolderZipWorkerResponse>(
        worker,
        (value) => Boolean(value.type) && value.type !== "progress",
      );
      worker.postMessage({
        type: "compress",
        sources: [
          { directory: true, path: "fixture", lastModified: 0 },
          {
            path: "fixture/content.txt",
            file: new File([text], "content.txt", {
              type: "text/plain",
              lastModified: 0,
            }),
          },
        ],
      });
      const response = await result;
      expect(response.type).toBe("complete");
      if (response.type !== "complete")
        throw new Error(JSON.stringify(response));
      expect(requestedAssets).toContain(ZIP_WASM_URL);
      expect(response.archive.size).toBeLessThan(text.length / 10);
      const reader = new ZipReader(new BlobReader(response.archive), {
        useWebWorkers: false,
      });
      try {
        const entries = await reader.getEntries();
        expect(entries.map((entry) => entry.filename)).toEqual([
          "fixture/",
          "fixture/content.txt",
        ]);
        const entry = entries.find(
          (entry) => entry.filename === "fixture/content.txt",
        );
        if (!entry || entry.directory)
          throw new Error("ZIP file entry missing.");
        expect(await entry.getData(new TextWriter())).toBe(text);
      } finally {
        await reader.close();
      }
    } finally {
      await worker.terminate();
    }
  });

  it("runs Argon2 preflight and a signed, encrypted vault round trip through the emitted worker", async () => {
    const worker = await emittedWorker(VAULT_WORKER_URL);
    let requestId = 0;
    async function request<T extends VaultWorkerRequest["type"]>(
      payload: { type: T } & Omit<
        Extract<VaultWorkerRequest, { type: T }>,
        "id"
      >,
    ): Promise<Extract<VaultWorkerResult, { type: T }>> {
      const id = ++requestId;
      const pending = nextMessage<VaultWorkerResponse>(
        worker,
        (value) => value.id === id && (!value.ok || "result" in value),
      );
      worker.postMessage({ ...payload, id });
      const response = await pending;
      if (!response.ok) throw new Error(response.error);
      if (!("result" in response))
        throw new Error("Missing vault response result.");
      expect(response.result.type).toBe(payload.type);
      return response.result as Extract<VaultWorkerResult, { type: T }>;
    }
    try {
      expect(await request({ type: "preflight" })).toEqual({
        type: "preflight",
        supported: true,
      });
      const setup = await request({
        type: "setup",
        password: "production-worker-test-password",
      });
      const plaintext = new TextEncoder().encode(
        "Exact production bytes must encrypt and authenticate this content.",
      );
      const encryption = await request({
        type: "startEncryption",
        input: {
          parentId: null,
          entryType: "file",
          name: "roundtrip.txt",
          mimeType: "text/plain",
          plaintextBytes: plaintext.length,
          lastModified: 0,
        },
      });
      const encrypted = await request({
        type: "encryptChunk",
        sessionId: encryption.result.sessionId,
        chunkIndex: 0,
        plaintext: plaintext.buffer,
      });
      expect(new Uint8Array(encrypted.result.ciphertext)).not.toEqual(
        plaintext,
      );
      const completed = await request({
        type: "finalizeEncryption",
        sessionId: encryption.result.sessionId,
      });
      const { record } = completed.result;
      const bootstrap = decodeBootstrap(record.bootstrapCbor);
      const plan: VaultDownloadPlan = {
        ...completed.result,
        entryType: "file",
        cryptoChunkBytes: VAULT_CRYPTO_CHUNK_BYTES,
        ciphertextMerkleRoot: base64Url(bootstrap.ciphertextMerkleRoot),
        bootstrapCbor: base64Url(record.bootstrapCbor),
        bootstrapSignature: base64Url(record.bootstrapSignature),
        encryptedManifest: base64Url(record.encryptedManifest),
        wrappers: record.wrappers.map(base64Url),
        signerKeyVersion: setup.result.payload.identity.keyVersion,
        signerEd25519PublicKey: setup.result.payload.identity.ed25519PublicKey,
        recordHash: createHash("sha256")
          .update(record.bootstrapCbor)
          .update(record.bootstrapSignature)
          .digest("base64url"),
        share: null,
        downloadUrl: null,
      };
      const decryption = await request({ type: "startDecryption", plan });
      expect(decryption.result.manifest.name).toBe("roundtrip.txt");
      const decrypted = await request({
        type: "decryptChunk",
        sessionId: decryption.result.sessionId,
        chunkIndex: 0,
        ciphertext: encrypted.result.ciphertext,
      });
      expect(new Uint8Array(decrypted.result.plaintext)).toEqual(plaintext);
      await request({
        type: "finalizeDecryption",
        sessionId: decryption.result.sessionId,
      });
      await request({ type: "lock" });
      await expect(request({ type: "startDecryption", plan })).rejects.toThrow(
        "Unlock the vault first.",
      );
    } finally {
      await worker.terminate();
    }
  }, 60_000);
});
