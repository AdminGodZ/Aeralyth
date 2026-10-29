import {
  ciphertextChunkLength,
  VAULT_CRYPTO_CHUNK_BYTES,
  type VaultDownloadPlan,
  type VaultManifest,
} from "@/features/vault/protocol";
import { ResumableDownload } from "@/features/vault/resumable-download";
import { createTransferMetrics } from "@/features/vault/transfer-metrics";
import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type { VaultDecryptionStart } from "@/features/vault/vault-messages";
import { abortReason } from "@/lib/abort";
import { randomFileToken, triggerBlobDownload } from "@/lib/browser-download";

type SaveFilePicker = (options: {
  suggestedName: string;
}) => Promise<FileSystemFileHandle>;

type FileSystemFileHandle = {
  createWritable(): Promise<FileSystemWritableFileStream>;
};

type OriginPrivateFileSystemHandle = FileSystemFileHandle & {
  getFile(): Promise<File>;
};

type OriginPrivateFileSystemDirectory = {
  getFileHandle(
    name: string,
    options: { create: true },
  ): Promise<OriginPrivateFileSystemHandle>;
  removeEntry(name: string): Promise<void>;
};

type OriginPrivateDownload = {
  directory: OriginPrivateFileSystemDirectory;
  fileHandle: OriginPrivateFileSystemHandle;
  fileName: string;
  writable: FileSystemWritableFileStream;
};

type FileSystemWritableFileStream = {
  write(data: ArrayBuffer): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
};

export const MAX_IN_MEMORY_DOWNLOAD_BYTES = 128 * 1024 * 1024;

export async function downloadEncryptedFile({
  plan,
  manifest,
  client,
  signal,
  onProgress,
}: {
  plan: VaultDownloadPlan;
  manifest: VaultManifest;
  client: VaultCryptoClient;
  signal?: AbortSignal;
  onProgress?(value: number): void;
}): Promise<void> {
  if (!plan.downloadUrl || manifest.entryType !== "file") {
    throw new Error("This vault node does not contain downloadable file data.");
  }
  const savePicker = getSaveFilePicker();
  let writable: FileSystemWritableFileStream | null = null;
  let originPrivateDownload: OriginPrivateDownload | null = null;
  if (savePicker) {
    const handle = await savePicker({
      suggestedName: safeDownloadName(manifest.name),
    });
    writable = await handle.createWritable();
  } else {
    originPrivateDownload = await createOriginPrivateDownload();
    writable = originPrivateDownload?.writable ?? null;
    if (!writable && manifest.plaintextBytes > MAX_IN_MEMORY_DOWNLOAD_BYTES) {
      throw new Error(
        "This browser cannot stream this large download to disk. Use a browser with the File System Access API or download a file no larger than 128 MiB.",
      );
    }
  }
  const plaintextParts: ArrayBuffer[] = [];
  const metrics = createTransferMetrics();

  try {
    await decryptEncryptedFile({
      plan,
      manifest,
      client,
      signal,
      onProgress,
      metrics,
      async write(plaintext) {
        if (writable) {
          await writable.write(plaintext);
        } else {
          plaintextParts.push(plaintext);
        }
      },
    });
    signal?.throwIfAborted();
    if (writable) {
      await metrics.measure(
        "sink",
        () => writable?.close() ?? Promise.resolve(),
      );
      signal?.throwIfAborted();
      writable = null;
      if (originPrivateDownload) {
        const completed = await originPrivateDownload.fileHandle.getFile();
        signal?.throwIfAborted();
        const cleanup = originPrivateDownload;
        triggerBlobDownload(completed, safeDownloadName(manifest.name), () =>
          cleanup.directory.removeEntry(cleanup.fileName),
        );
        originPrivateDownload = null;
      }
    } else {
      triggerBlobDownload(
        new Blob(plaintextParts),
        safeDownloadName(manifest.name),
      );
    }
    metrics.finish("completed");
    onProgress?.(100);
  } catch (error) {
    await writable?.abort(error).catch(() => undefined);
    if (originPrivateDownload) {
      await originPrivateDownload.directory
        .removeEntry(originPrivateDownload.fileName)
        .catch(() => undefined);
    }
    metrics.finish(signal?.aborted ? "canceled" : "failed");
    throw error;
  } finally {
    for (const plaintext of plaintextParts) new Uint8Array(plaintext).fill(0);
  }
}

export async function readEncryptedFileBlob({
  plan,
  manifest,
  client,
  signal,
  onProgress,
}: {
  plan: VaultDownloadPlan;
  manifest: VaultManifest;
  client: VaultCryptoClient;
  signal?: AbortSignal;
  onProgress?(value: number): void;
}): Promise<Blob> {
  const plaintextParts: ArrayBuffer[] = [];
  try {
    await decryptEncryptedFile({
      plan,
      manifest,
      client,
      signal,
      onProgress,
      write(plaintext) {
        plaintextParts.push(plaintext);
      },
    });
    signal?.throwIfAborted();
    return new Blob(plaintextParts, {
      type: manifest.mimeType ?? "application/octet-stream",
    });
  } finally {
    for (const plaintext of plaintextParts) new Uint8Array(plaintext).fill(0);
  }
}

/** A prefix authenticates complete AEAD chunks, but does not verify the full Merkle root. */
export async function readEncryptedFilePrefix({
  plan,
  manifest,
  client,
  maxPlaintextBytes,
  signal,
  onProgress,
}: {
  plan: VaultDownloadPlan;
  manifest: VaultManifest;
  client: VaultCryptoClient;
  maxPlaintextBytes: number;
  signal?: AbortSignal;
  onProgress?(value: number): void;
}): Promise<{ blob: Blob; verification: "full" | "partial" }> {
  if (!Number.isSafeInteger(maxPlaintextBytes) || maxPlaintextBytes < 1) {
    throw new Error("The preview byte limit must be a positive integer.");
  }
  const selectedChunks =
    maxPlaintextBytes >= manifest.plaintextBytes
      ? plan.chunkCount
      : Math.min(
          plan.chunkCount,
          Math.ceil(maxPlaintextBytes / VAULT_CRYPTO_CHUNK_BYTES),
        );
  const parts: BlobPart[] = [];
  let remaining = maxPlaintextBytes;
  await decryptEncryptedFile({
    plan,
    manifest,
    client,
    signal,
    onProgress,
    selectedChunks,
    write(plaintext) {
      // Blob snapshots just the displayed bytes and releases the rest of the
      // authenticated crypto chunk before the next one is consumed.
      const bytes = new Uint8Array(plaintext);
      const selected = Math.min(bytes.length, remaining);
      parts.push(new Blob([bytes.subarray(0, selected)]));
      remaining -= selected;
      bytes.fill(0);
    },
  });
  signal?.throwIfAborted();
  return {
    blob: new Blob(parts, {
      type: manifest.mimeType ?? "application/octet-stream",
    }),
    verification: selectedChunks === plan.chunkCount ? "full" : "partial",
  };
}

export function readEncryptedFileStream({
  plan,
  manifest,
  client,
  signal,
  onProgress,
}: {
  plan: VaultDownloadPlan;
  manifest: VaultManifest;
  client: VaultCryptoClient;
  signal?: AbortSignal;
  onProgress?(value: number): void;
}): ReadableStream<Uint8Array> {
  const operation = new AbortController();
  let demand = Promise.withResolvers<void>();
  const abortFromParent = () => {
    operation.abort(signal?.reason);
    demand.resolve();
  };
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });

  let producer: Promise<void> | null = null;
  let canceled = false;

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        producer = decryptEncryptedFile({
          plan,
          manifest,
          client,
          signal: operation.signal,
          onProgress,
          async write(plaintext) {
            if (operation.signal.aborted) {
              throw abortReason(operation.signal);
            }
            demand = Promise.withResolvers<void>();
            controller.enqueue(new Uint8Array(plaintext));
            await demand.promise;
            if (operation.signal.aborted) {
              throw abortReason(operation.signal);
            }
          },
        })
          .then(() => {
            if (!canceled) controller.close();
          })
          .catch((error: unknown) => {
            if (!canceled) controller.error(error);
          })
          .finally(() => {
            signal?.removeEventListener("abort", abortFromParent);
          });
      },
      pull() {
        demand.resolve();
      },
      async cancel(reason) {
        canceled = true;
        operation.abort(reason);
        demand.resolve();
        await producer?.catch(() => undefined);
      },
    },
    { highWaterMark: 1 },
  );
}

async function decryptEncryptedFile({
  plan,
  manifest,
  client,
  signal,
  onProgress,
  write,
  selectedChunks = plan.chunkCount,
  metrics: providedMetrics,
}: {
  plan: VaultDownloadPlan;
  manifest: VaultManifest;
  client: VaultCryptoClient;
  signal?: AbortSignal;
  onProgress?(value: number): void;
  write(plaintext: ArrayBuffer): void | Promise<void>;
  selectedChunks?: number;
  metrics?: ReturnType<typeof createTransferMetrics>;
}): Promise<void> {
  if (!plan.downloadUrl || manifest.entryType !== "file") {
    throw new Error("This vault node does not contain downloadable file data.");
  }
  const metrics = providedMetrics ?? createTransferMetrics();
  let outcome: "completed" | "failed" | "canceled" = "failed";
  const endExclusive =
    selectedChunks === plan.chunkCount
      ? plan.ciphertextLength
      : selectedChunks * (VAULT_CRYPTO_CHUNK_BYTES + 16);
  const network = new ResumableDownload(plan, endExclusive, signal, (bytes) =>
    metrics.addBytes(bytes),
  );
  const startedPromise = client.startDecryption(plan);
  const responsePromise = metrics.measure("network", () => network.open());
  let sessionId: string | null = null;
  let lookahead: Promise<Uint8Array<ArrayBuffer>> | null = null;
  let pendingWrite: Promise<void> | null = null;
  let unconsumedPlaintext: ArrayBuffer | null = null;
  let received = 0;

  const read = (index: number) => {
    const reading = metrics.measure("network", () =>
      network.readChunk(
        ciphertextChunkLength(plan.ciphertextLength, plan.chunkCount, index),
      ),
    );
    // Reads and writes can fail before the ordered consumer awaits them.
    void reading.catch(() => undefined);
    return reading;
  };

  try {
    let started: VaultDecryptionStart;
    try {
      [started] = await Promise.all([startedPromise, responsePromise]);
    } catch (error) {
      await network.cancel(error);
      await responsePromise.catch(() => undefined);
      const lateSession = await startedPromise.catch(() => null);
      if (lateSession) {
        await client
          .abortDecryption(lateSession.sessionId)
          .catch(() => undefined);
      }
      throw error;
    }
    sessionId = started.sessionId;
    if (selectedChunks > 0) lookahead = read(0);

    for (let index = 0; index < selectedChunks; index += 1) {
      const ciphertext = await lookahead;
      lookahead = null;
      if (!ciphertext) throw new Error("The encrypted download is incomplete.");
      const ciphertextBytes = ciphertext.length;
      // Exactly one read runs ahead. The worker remains strictly sequential;
      // it may decrypt the next chunk while the preceding sink write settles.
      if (index + 1 < selectedChunks) lookahead = read(index + 1);
      const decrypted = await metrics.measure("decrypt", () =>
        client.decryptChunk(sessionId as string, index, ciphertext.buffer),
      );
      unconsumedPlaintext = decrypted.plaintext;
      await pendingWrite;
      signal?.throwIfAborted();
      const plaintext = unconsumedPlaintext;
      unconsumedPlaintext = null;
      pendingWrite = metrics.measure("sink", async () => {
        try {
          await write(plaintext);
        } catch (error) {
          new Uint8Array(plaintext).fill(0);
          throw error;
        }
        received += ciphertextBytes;
        metrics.addBytes(0, plaintext.byteLength);
        onProgress?.(Math.min(99, (received / endExclusive) * 100));
      });
      void pendingWrite.catch(() => undefined);
    }
    await pendingWrite;
    await metrics.measure("network", () => network.finish());
    if (selectedChunks === plan.chunkCount) {
      await metrics.measure("decrypt", () =>
        client.finalizeDecryption(sessionId as string),
      );
    } else {
      await client.abortDecryption(sessionId);
    }
    signal?.throwIfAborted();
    sessionId = null;
    outcome = "completed";
    if (!providedMetrics) onProgress?.(100);
  } catch (error) {
    outcome = signal?.aborted ? "canceled" : "failed";
    await network.cancel(error);
    if (sessionId) {
      await client.abortDecryption(sessionId).catch(() => undefined);
      sessionId = null;
    }
    throw error;
  } finally {
    await network.cancel();
    const abandoned = await lookahead?.catch(() => null);
    abandoned?.fill(0);
    if (unconsumedPlaintext) new Uint8Array(unconsumedPlaintext).fill(0);
    await pendingWrite?.catch(() => undefined);
    if (!providedMetrics)
      metrics.finish(signal?.aborted ? "canceled" : outcome);
  }
  signal?.throwIfAborted();
}

function getSaveFilePicker(): SaveFilePicker | null {
  const candidate = (
    globalThis as typeof globalThis & {
      showSaveFilePicker?: SaveFilePicker;
    }
  ).showSaveFilePicker;
  return typeof candidate === "function" ? candidate.bind(globalThis) : null;
}

async function createOriginPrivateDownload(): Promise<OriginPrivateDownload | null> {
  if (typeof navigator === "undefined") return null;
  const storage = navigator.storage as
    | (StorageManager & {
        getDirectory?: () => Promise<OriginPrivateFileSystemDirectory>;
      })
    | undefined;
  const getDirectory = storage?.getDirectory;
  if (typeof getDirectory !== "function") return null;

  let directory: OriginPrivateFileSystemDirectory | null = null;
  let fileName: string | null = null;
  try {
    directory = await getDirectory.call(storage);
    fileName = `aeralyth-download-${randomFileToken()}.tmp`;
    const fileHandle = await directory.getFileHandle(fileName, {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    return { directory, fileHandle, fileName, writable };
  } catch {
    if (directory && fileName) {
      await directory.removeEntry(fileName).catch(() => undefined);
    }
    return null;
  }
}

function safeDownloadName(name: string): string {
  const forbidden = new Set(["\\", "/", ":", "*", "?", '"', "<", ">", "|"]);
  const safe = Array.from(name, (character) =>
    character.charCodeAt(0) < 32 || forbidden.has(character) ? "_" : character,
  ).join("");
  return safe.slice(0, 240) || "download";
}
