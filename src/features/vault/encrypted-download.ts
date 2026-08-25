import { ExactStreamReader } from "@/features/vault/buffered-bytes";
import {
  ciphertextChunkLength,
  type VaultDownloadPlan,
  type VaultManifest,
} from "@/features/vault/protocol";
import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type { VaultDecryptionStart } from "@/features/vault/vault-messages";

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
  const plaintextParts: BlobPart[] = [];

  try {
    await decryptEncryptedFile({
      plan,
      manifest,
      client,
      signal,
      onProgress,
      async write(plaintext) {
        if (writable) {
          await writable.write(plaintext);
        } else {
          plaintextParts.push(plaintext);
        }
      },
    });
    if (writable) {
      await writable.close();
      writable = null;
      if (originPrivateDownload) {
        const completed = await originPrivateDownload.fileHandle.getFile();
        const cleanup = originPrivateDownload;
        triggerBlobDownload(completed, manifest.name, () =>
          cleanup.directory.removeEntry(cleanup.fileName),
        );
        originPrivateDownload = null;
      }
    } else {
      triggerBlobDownload(new Blob(plaintextParts), manifest.name);
    }
    onProgress?.(100);
  } catch (error) {
    await writable?.abort(error).catch(() => undefined);
    if (originPrivateDownload) {
      await originPrivateDownload.directory
        .removeEntry(originPrivateDownload.fileName)
        .catch(() => undefined);
    }
    throw error;
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
  const plaintextParts: BlobPart[] = [];
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
  return new Blob(plaintextParts, {
    type: manifest.mimeType ?? "application/octet-stream",
  });
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
  const abortFromParent = () => operation.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });

  let demand = Promise.withResolvers<void>();
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
}: {
  plan: VaultDownloadPlan;
  manifest: VaultManifest;
  client: VaultCryptoClient;
  signal?: AbortSignal;
  onProgress?(value: number): void;
  write(plaintext: ArrayBuffer): void | Promise<void>;
}): Promise<void> {
  if (!plan.downloadUrl || manifest.entryType !== "file") {
    throw new Error("This vault node does not contain downloadable file data.");
  }
  const network = new AbortController();
  const abortNetwork = () => network.abort(signal?.reason);
  if (signal?.aborted) abortNetwork();
  else signal?.addEventListener("abort", abortNetwork, { once: true });

  const startedPromise = client.startDecryption(plan);
  const responsePromise = fetch(plan.downloadUrl, {
    signal: network.signal,
    cache: "no-store",
  });
  let sessionId: string | null = null;
  let response: Response | null = null;
  let reader: ExactStreamReader | null = null;
  let chunkIndex = 0;
  let received = 0;

  try {
    let started: VaultDecryptionStart;
    try {
      [started, response] = await Promise.all([
        startedPromise,
        responsePromise,
      ]);
    } catch (error) {
      network.abort(error);
      const lateResponse = await responsePromise.catch(() => null);
      await lateResponse?.body?.cancel(error).catch(() => undefined);
      const lateSession = await startedPromise.catch(() => null);
      if (lateSession) {
        await client
          .abortDecryption(lateSession.sessionId)
          .catch(() => undefined);
      }
      throw error;
    }
    sessionId = started.sessionId;
    if (!response.ok || !response.body) {
      throw new Error(
        `Encrypted download failed with status ${response.status}.`,
      );
    }
    reader = new ExactStreamReader(response.body.getReader());

    while (chunkIndex < plan.chunkCount) {
      const expected = ciphertextChunkLength(
        plan.ciphertextLength,
        plan.chunkCount,
        chunkIndex,
      );
      const ciphertext = await reader.readExactly(expected);
      if (!ciphertext) {
        throw new Error(
          "The encrypted download ended before all chunks arrived.",
        );
      }
      received += ciphertext.length;
      const decrypted = await client.decryptChunk(
        sessionId,
        chunkIndex,
        ciphertext.buffer,
      );
      await write(decrypted.plaintext);
      chunkIndex += 1;
      onProgress?.(Math.min(100, (received / plan.ciphertextLength) * 100));
    }

    if (!(await reader.isAtEnd())) {
      throw new Error(
        "The encrypted download contains unexpected trailing data.",
      );
    }
    await client.finalizeDecryption(sessionId);
    sessionId = null;
    onProgress?.(100);
  } catch (error) {
    network.abort(error);
    if (sessionId) {
      await client.abortDecryption(sessionId).catch(() => undefined);
      sessionId = null;
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortNetwork);
    network.abort();
    await reader?.cancel().catch(() => undefined);
  }
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

function triggerBlobDownload(
  blob: Blob,
  fileName: string,
  release?: () => void | Promise<void>,
): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeDownloadName(fileName);
  anchor.rel = "noopener";
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    void Promise.resolve(release?.()).catch(() => undefined);
  }, 60_000);
}

function randomFileToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("The operation was aborted.", "AbortError")
  );
}

function safeDownloadName(name: string): string {
  const forbidden = new Set(["\\", "/", ":", "*", "?", '"', "<", ">", "|"]);
  const safe = Array.from(name, (character) =>
    character.charCodeAt(0) < 32 || forbidden.has(character) ? "_" : character,
  ).join("");
  return safe.slice(0, 240) || "download";
}
