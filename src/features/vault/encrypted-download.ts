import {
  ciphertextChunkLength,
  type VaultDownloadPlan,
  type VaultManifest,
} from "@/features/vault/protocol";
import type { VaultCryptoClient } from "@/features/vault/vault-client";

type SaveFilePicker = (options: {
  suggestedName: string;
}) => Promise<FileSystemFileHandle>;

type FileSystemFileHandle = {
  createWritable(): Promise<FileSystemWritableFileStream>;
};

type FileSystemWritableFileStream = {
  write(data: ArrayBuffer): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
};

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
  if (savePicker) {
    const handle = await savePicker({
      suggestedName: safeDownloadName(manifest.name),
    });
    writable = await handle.createWritable();
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
    } else {
      triggerBlobDownload(new Blob(plaintextParts), manifest.name);
    }
    onProgress?.(100);
  } catch (error) {
    await writable?.abort(error).catch(() => undefined);
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
  const [started, response] = await Promise.all([
    client.startDecryption(plan),
    fetch(plan.downloadUrl, {
      signal,
      cache: "no-store",
    }),
  ]);
  if (!response.ok || !response.body) {
    throw new Error(
      `Encrypted download failed with status ${response.status}.`,
    );
  }
  const reader = response.body.getReader();
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let chunkIndex = 0;
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending = appendBytes(pending, value);
    received += value.length;

    while (chunkIndex < plan.chunkCount) {
      const expected = ciphertextChunkLength(
        plan.ciphertextLength,
        plan.chunkCount,
        chunkIndex,
      );
      if (pending.length < expected) break;
      const ciphertext = pending.slice(0, expected);
      pending = pending.slice(expected);
      const decrypted = await client.decryptChunk(
        started.sessionId,
        chunkIndex,
        copyArrayBuffer(ciphertext),
      );
      await write(decrypted.plaintext);
      chunkIndex += 1;
      onProgress?.(Math.min(100, (received / plan.ciphertextLength) * 100));
    }
  }

  if (pending.length !== 0 || chunkIndex !== plan.chunkCount) {
    throw new Error("The encrypted download ended before all chunks arrived.");
  }
  await client.finalizeDecryption(started.sessionId);
  onProgress?.(100);
}

function getSaveFilePicker(): SaveFilePicker | null {
  const candidate = (
    globalThis as typeof globalThis & {
      showSaveFilePicker?: SaveFilePicker;
    }
  ).showSaveFilePicker;
  return typeof candidate === "function" ? candidate.bind(globalThis) : null;
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeDownloadName(fileName);
  anchor.rel = "noopener";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function safeDownloadName(name: string): string {
  const forbidden = new Set(["\\", "/", ":", "*", "?", '"', "<", ">", "|"]);
  const safe = Array.from(name, (character) =>
    character.charCodeAt(0) < 32 || forbidden.has(character) ? "_" : character,
  ).join("");
  return safe.slice(0, 240) || "download";
}

function appendBytes(
  left: Uint8Array,
  right: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  left.fill(0);
  return output;
}

function copyArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}
