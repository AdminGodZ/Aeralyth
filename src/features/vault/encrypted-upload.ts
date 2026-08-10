import {
  toArrayBuffer,
  VAULT_CRYPTO_CHUNK_BYTES,
  VAULT_MAX_CIPHERTEXT_BYTES,
} from "@/features/vault/protocol";
import { enqueueShareDirectorySync } from "@/features/vault/share-directory-sync";
import {
  abortVaultUpload,
  getVaultContentUrl,
  getVaultPartUrls,
  initVaultUpload,
  publishVaultUpload,
  type VaultCompletedPart,
  type VaultMigrationNode,
  type VaultUploadPlan,
} from "@/features/vault/vault-api";
import type { VaultCryptoClient } from "@/features/vault/vault-client";

const VAULT_PRESIGN_BATCH_SIZE = 8;
const VAULT_UPLOAD_CONCURRENCY = 4;

type PendingVaultPart = {
  partNumber: number;
  content: Uint8Array;
};

export type EncryptedUploadSelection = {
  file: File;
  relativePath: string;
};

export async function uploadEncryptedSelections({
  selections,
  parentFolderId,
  csrfToken,
  client,
  signal,
  onProgress,
  onFileStart,
  onFileComplete,
}: {
  selections: EncryptedUploadSelection[];
  parentFolderId: string | null;
  csrfToken: string;
  client: VaultCryptoClient;
  signal: AbortSignal;
  onProgress(
    processedBytes: number,
    totalBytes: number,
    fileIndex: number,
    fileProcessedBytes: number,
  ): void;
  onFileStart(fileIndex: number): void;
  onFileComplete(fileIndex: number): void;
}): Promise<{ rootFolderId: string | null }> {
  const totalBytes = selections.reduce(
    (total, item) => total + item.file.size,
    0,
  );
  let processedBytes = 0;
  const folderIds = new Map<string, string>();
  folderIds.set("", parentFolderId ?? "");
  const folders = collectFolders(selections);

  for (const path of folders) {
    assertNotAborted(signal);
    const parentPath = parentDirectory(path);
    const parentId = folderIds.get(parentPath);
    if (parentId === undefined) {
      throw new Error("The selected folder hierarchy is invalid.");
    }
    // Each folder must exist before its children can use the returned node ID.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const result = await uploadEncryptedEntry({
      file: null,
      name: baseName(path),
      parentId: parentId || null,
      csrfToken,
      client,
      signal,
      onChunk: () => undefined,
    });
    folderIds.set(path, result.nodeId);
  }

  for (const [fileIndex, selection] of selections.entries()) {
    assertNotAborted(signal);
    onFileStart(fileIndex);
    let fileProcessedBytes = 0;
    const path = normalizeRelativePath(
      selection.relativePath || selection.file.name,
    );
    const parentId = folderIds.get(parentDirectory(path));
    if (parentId === undefined) {
      throw new Error("The selected file hierarchy is invalid.");
    }
    // Keep one encrypted multipart upload active to bound browser memory and I/O.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await uploadEncryptedEntry({
      file: selection.file,
      name: baseName(path),
      parentId: parentId || null,
      csrfToken,
      client,
      signal,
      onChunk: (sourceBytes) => {
        processedBytes += sourceBytes;
        fileProcessedBytes += sourceBytes;
        onProgress(processedBytes, totalBytes, fileIndex, fileProcessedBytes);
      },
    });
    onFileComplete(fileIndex);
  }

  const rootFolders = folders.filter((path) => !path.includes("/"));
  return {
    rootFolderId:
      rootFolders.length === 1 ? (folderIds.get(rootFolders[0]) ?? null) : null,
  };
}

export async function createEncryptedFolder({
  name,
  parentId = null,
  csrfToken,
  client,
  signal,
}: {
  name: string;
  parentId?: string | null;
  csrfToken: string;
  client: VaultCryptoClient;
  signal: AbortSignal;
}): Promise<{ nodeId: string }> {
  return uploadEncryptedEntry({
    file: null,
    name,
    parentId,
    csrfToken,
    client,
    signal,
    onChunk: () => undefined,
  });
}

export async function migrateEncryptedNode({
  node,
  csrfToken,
  client,
  signal,
  onProgress,
}: {
  node: VaultMigrationNode;
  csrfToken: string;
  client: VaultCryptoClient;
  signal: AbortSignal;
  onProgress(processedBytes: number, totalBytes: number): void;
}): Promise<void> {
  const started = await client.startEncryption({
    nodeId: node.nodeId,
    parentId: node.parentId,
    entryType: node.entryType,
    name: node.name,
    mimeType: node.mimeType,
    plaintextBytes: node.plaintextBytes,
    lastModified: node.lastModified,
    generationNumber: 1,
    recordVersion: 1,
    previousRecordHash: null,
  });
  if (started.ciphertextLength > VAULT_MAX_CIPHERTEXT_BYTES) {
    throw new Error(`${node.name} exceeds the encrypted upload limit.`);
  }
  const plan = await initVaultUpload(
    csrfToken,
    {
      nodeId: node.nodeId,
      parentId: node.parentId,
      entryType: node.entryType,
      generationNumber: started.generationNumber,
      generationId: started.generationId,
      ciphertextLength: started.ciphertextLength,
      chunkCount: started.chunkCount,
      migration: true,
    },
    signal,
  );

  try {
    let parts: VaultCompletedPart[] = [];
    if (node.entryType === "file") {
      if (!node.downloadUrl) {
        throw new Error(
          "The legacy object does not have a migration download URL.",
        );
      }
      const response = await fetch(node.downloadUrl, {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(
          `Legacy download failed with status ${response.status}.`,
        );
      }
      parts = await encryptAndUploadStream({
        stream: response.body,
        plaintextBytes: node.plaintextBytes,
        started,
        plan,
        csrfToken,
        client,
        signal,
        onChunk: (bytes) => onProgress(bytes, node.plaintextBytes),
      });
    }
    const completed = await client.finalizeEncryption(started.sessionId);
    const published = await publishVaultUpload(
      csrfToken,
      plan.uploadId,
      parts,
      completed.record,
      signal,
    );
    if (published.shareSyncRequired) {
      enqueueShareDirectorySync({
        csrfToken,
        client,
        job: {
          ...published,
          entryType: node.entryType,
        },
      });
    }
    onProgress(node.plaintextBytes, node.plaintextBytes);
  } catch (error) {
    await abortVaultUpload(csrfToken, plan.uploadId).catch(() => undefined);
    throw error;
  }
}

async function uploadEncryptedEntry({
  file,
  name,
  parentId,
  csrfToken,
  client,
  signal,
  onChunk,
}: {
  file: File | null;
  name: string;
  parentId: string | null;
  csrfToken: string;
  client: VaultCryptoClient;
  signal: AbortSignal;
  onChunk(bytes: number): void;
}): Promise<{ nodeId: string }> {
  const started = await client.startEncryption({
    parentId,
    entryType: file ? "file" : "folder",
    name,
    mimeType: file?.type || null,
    plaintextBytes: file?.size ?? 0,
    lastModified: file?.lastModified ?? Date.now(),
  });
  if (started.ciphertextLength > VAULT_MAX_CIPHERTEXT_BYTES) {
    throw new Error(`${name} exceeds the encrypted upload limit.`);
  }
  const plan = await initVaultUpload(
    csrfToken,
    {
      nodeId: started.nodeId,
      parentId,
      entryType: file ? "file" : "folder",
      generationNumber: started.generationNumber,
      generationId: started.generationId,
      ciphertextLength: started.ciphertextLength,
      chunkCount: started.chunkCount,
    },
    signal,
  );

  try {
    const parts = file
      ? await encryptAndUploadFile({
          file,
          started,
          plan,
          csrfToken,
          client,
          signal,
          onChunk,
        })
      : [];
    const completed = await client.finalizeEncryption(started.sessionId);
    const published = await publishVaultUpload(
      csrfToken,
      plan.uploadId,
      parts,
      completed.record,
      signal,
    );
    if (published.shareSyncRequired) {
      enqueueShareDirectorySync({
        csrfToken,
        client,
        job: {
          ...published,
          entryType: file ? "file" : "folder",
        },
      });
    }
    return { nodeId: completed.nodeId };
  } catch (error) {
    await abortVaultUpload(csrfToken, plan.uploadId).catch(() => undefined);
    throw error;
  }
}

async function encryptAndUploadFile({
  file,
  started,
  plan,
  csrfToken,
  client,
  signal,
  onChunk,
}: {
  file: File;
  started: Awaited<ReturnType<VaultCryptoClient["startEncryption"]>>;
  plan: VaultUploadPlan;
  csrfToken: string;
  client: VaultCryptoClient;
  signal: AbortSignal;
  onChunk(bytes: number): void;
}): Promise<VaultCompletedPart[]> {
  if (plan.mode === "none")
    throw new Error("The storage plan omitted file content.");
  if (plan.existingParts.length > 0) {
    throw new Error(
      "An encrypted upload cannot resume after its browser key was discarded.",
    );
  }
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const completed: VaultCompletedPart[] = [];
  const pendingParts: PendingVaultPart[] = [];
  let partNumber = 1;

  for (let chunkIndex = 0; chunkIndex < started.chunkCount; chunkIndex += 1) {
    assertNotAborted(signal);
    const sourceStart = chunkIndex * VAULT_CRYPTO_CHUNK_BYTES;
    const sourceEnd = Math.min(
      file.size,
      sourceStart + VAULT_CRYPTO_CHUNK_BYTES,
    );
    const plaintext = await file.slice(sourceStart, sourceEnd).arrayBuffer();
    const sourceBytes = plaintext.byteLength;
    const encrypted = await client.encryptChunk(
      started.sessionId,
      chunkIndex,
      plaintext,
    );
    pending = appendBytes(pending, new Uint8Array(encrypted.ciphertext));
    onChunk(sourceBytes);

    if (plan.mode === "multipart") {
      const partSize = plan.partSizeBytes;
      if (!partSize) throw new Error("The multipart upload plan is invalid.");
      while (pending.length >= partSize) {
        const part = pending.slice(0, partSize);
        pending = pending.slice(partSize);
        pendingParts.push({ partNumber, content: part });
        partNumber += 1;
        if (pendingParts.length === VAULT_PRESIGN_BATCH_SIZE) {
          completed.push(
            ...(await uploadMultipartParts(
              csrfToken,
              plan.uploadId,
              pendingParts.splice(0),
              signal,
            )),
          );
        }
      }
    }
  }

  if (plan.mode === "single") {
    if (pending.length !== started.ciphertextLength) {
      throw new Error("The encrypted upload length is inconsistent.");
    }
    await uploadSingle(csrfToken, plan.uploadId, pending, signal);
  } else if (pending.length > 0) {
    pendingParts.push({ partNumber, content: pending });
  }
  if (pendingParts.length > 0) {
    completed.push(
      ...(await uploadMultipartParts(
        csrfToken,
        plan.uploadId,
        pendingParts.splice(0),
        signal,
      )),
    );
  }
  pending.fill(0);
  return completed;
}

async function encryptAndUploadStream({
  stream,
  plaintextBytes,
  started,
  plan,
  csrfToken,
  client,
  signal,
  onChunk,
}: {
  stream: ReadableStream<Uint8Array>;
  plaintextBytes: number;
  started: Awaited<ReturnType<VaultCryptoClient["startEncryption"]>>;
  plan: VaultUploadPlan;
  csrfToken: string;
  client: VaultCryptoClient;
  signal: AbortSignal;
  onChunk(processedBytes: number): void;
}): Promise<VaultCompletedPart[]> {
  if (plan.mode === "none")
    throw new Error("The storage plan omitted file content.");
  if (plan.existingParts.length > 0) {
    throw new Error(
      "An encrypted migration cannot resume with discarded browser keys.",
    );
  }
  const reader = stream.getReader();
  let plaintextPending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let encryptedPending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const completed: VaultCompletedPart[] = [];
  const pendingParts: PendingVaultPart[] = [];
  let partNumber = 1;
  let processedBytes = 0;

  try {
    for (let chunkIndex = 0; chunkIndex < started.chunkCount; chunkIndex += 1) {
      assertNotAborted(signal);
      const expected = Math.min(
        VAULT_CRYPTO_CHUNK_BYTES,
        plaintextBytes - processedBytes,
      );
      while (plaintextPending.length < expected) {
        const next = await reader.read();
        if (next.done) {
          throw new Error("The legacy object ended before its recorded size.");
        }
        plaintextPending = appendBytes(plaintextPending, next.value);
      }
      const plaintext = plaintextPending.slice(0, expected);
      plaintextPending = plaintextPending.slice(expected);
      const encrypted = await client.encryptChunk(
        started.sessionId,
        chunkIndex,
        toArrayBuffer(plaintext),
      );
      encryptedPending = appendBytes(
        encryptedPending,
        new Uint8Array(encrypted.ciphertext),
      );
      processedBytes += expected;
      onChunk(processedBytes);

      if (plan.mode === "multipart") {
        const partSize = plan.partSizeBytes;
        if (!partSize) throw new Error("The multipart upload plan is invalid.");
        while (encryptedPending.length >= partSize) {
          const part = encryptedPending.slice(0, partSize);
          encryptedPending = encryptedPending.slice(partSize);
          pendingParts.push({ partNumber, content: part });
          partNumber += 1;
          if (pendingParts.length === VAULT_PRESIGN_BATCH_SIZE) {
            completed.push(
              ...(await uploadMultipartParts(
                csrfToken,
                plan.uploadId,
                pendingParts.splice(0),
                signal,
              )),
            );
          }
        }
      }
    }
    const trailing = await reader.read();
    if (
      !trailing.done ||
      plaintextPending.length !== 0 ||
      processedBytes !== plaintextBytes
    ) {
      throw new Error("The legacy object size changed during migration.");
    }
    if (plan.mode === "single") {
      if (encryptedPending.length !== started.ciphertextLength) {
        throw new Error("The encrypted migration length is inconsistent.");
      }
      await uploadSingle(csrfToken, plan.uploadId, encryptedPending, signal);
    } else if (encryptedPending.length > 0) {
      pendingParts.push({ partNumber, content: encryptedPending });
    }
    if (pendingParts.length > 0) {
      completed.push(
        ...(await uploadMultipartParts(
          csrfToken,
          plan.uploadId,
          pendingParts.splice(0),
          signal,
        )),
      );
    }
    return completed;
  } finally {
    plaintextPending.fill(0);
    encryptedPending.fill(0);
    await reader.cancel().catch(() => undefined);
  }
}

async function uploadSingle(
  csrfToken: string,
  uploadId: string,
  content: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  const checksum = await sha256Base64(content);
  const signed = await getVaultContentUrl(
    csrfToken,
    uploadId,
    checksum,
    signal,
  );
  if (signed.contentLength !== content.length) {
    throw new Error("The signed upload length is invalid.");
  }
  await putEncryptedBytes(signed.url, content, checksum, signal);
}

async function uploadMultipartParts(
  csrfToken: string,
  uploadId: string,
  pending: PendingVaultPart[],
  signal: AbortSignal,
): Promise<VaultCompletedPart[]> {
  if (pending.length < 1 || pending.length > VAULT_PRESIGN_BATCH_SIZE) {
    throw new Error("The encrypted multipart batch is invalid.");
  }
  try {
    const prepared = await Promise.all(
      pending.map(async (part) => ({
        ...part,
        checksumSha256: await sha256Base64(part.content),
      })),
    );
    const response = await getVaultPartUrls(
      csrfToken,
      uploadId,
      prepared.map((part) => ({
        partNumber: part.partNumber,
        checksumSha256: part.checksumSha256,
      })),
      signal,
    );
    const signedByPart = new Map(
      response.parts.map((part) => [part.partNumber, part]),
    );
    if (signedByPart.size !== prepared.length) {
      throw new Error("The signed multipart batch is incomplete.");
    }
    const completed: VaultCompletedPart[] = [];
    for (
      let offset = 0;
      offset < prepared.length;
      offset += VAULT_UPLOAD_CONCURRENCY
    ) {
      const uploaded = await Promise.all(
        prepared
          .slice(offset, offset + VAULT_UPLOAD_CONCURRENCY)
          .map(async (part) => {
            const signed = signedByPart.get(part.partNumber);
            if (!signed || signed.contentLength !== part.content.length) {
              throw new Error("The signed multipart length is invalid.");
            }
            const upload = await putEncryptedBytes(
              signed.url,
              part.content,
              part.checksumSha256,
              signal,
            );
            const etag = upload.headers.get("ETag")?.trim();
            if (!etag) {
              throw new Error(
                "The storage service did not expose the multipart ETag header.",
              );
            }
            return {
              partNumber: part.partNumber,
              etag,
              checksumSha256: part.checksumSha256,
            };
          }),
      );
      completed.push(...uploaded);
    }
    return completed;
  } finally {
    for (const part of pending) part.content.fill(0);
  }
}

async function putEncryptedBytes(
  url: string,
  content: Uint8Array,
  checksum: string,
  signal: AbortSignal,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertNotAborted(signal);
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-amz-checksum-sha256": checksum,
        },
        body: toArrayBuffer(content),
        signal,
      });
      if (!response.ok) {
        throw new Error(
          `Storage upload failed with status ${response.status}.`,
        );
      }
      return response;
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
      await delay(300 * 2 ** attempt, signal);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Storage upload failed.");
}

function collectFolders(selections: EncryptedUploadSelection[]): string[] {
  const folders = new Set<string>();
  for (const selection of selections) {
    let directory = parentDirectory(
      normalizeRelativePath(selection.relativePath || selection.file.name),
    );
    while (directory) {
      folders.add(directory);
      directory = parentDirectory(directory);
    }
  }
  return Array.from(folders).sort((left, right) => {
    const depth = pathDepth(left) - pathDepth(right);
    return depth || left.localeCompare(right);
  });
}

function normalizeRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").split("/").filter(Boolean);
  if (
    normalized.length === 0 ||
    normalized.some(
      (segment) =>
        segment === "." || segment === ".." || segment.includes("\0"),
    )
  ) {
    throw new Error("The selected path is invalid.");
  }
  return normalized.join("/");
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function baseName(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? path : path.slice(separator + 1);
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  left.fill(0);
  right.fill(0);
  return output;
}

async function sha256Base64(content: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(content)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  digest.fill(0);
  return btoa(binary);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new DOMException("Upload canceled", "AbortError"));
      },
      { once: true },
    );
  });
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Upload canceled", "AbortError");
}
