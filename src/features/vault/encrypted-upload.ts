import {
  ExactStreamReader,
  FixedSizeBufferAssembler,
} from "@/features/vault/buffered-bytes";
import {
  asBufferSource,
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

type MultipartBufferState = {
  nextPartNumber: number;
  pending: PendingVaultPart[];
  completed: VaultCompletedPart[];
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
  const assembler = new FixedSizeBufferAssembler(
    encryptedUploadBufferSize(plan, started.ciphertextLength),
  );
  const multipart: MultipartBufferState = {
    nextPartNumber: 1,
    pending: [],
    completed: [],
  };
  let singleContent: Uint8Array | null = null;
  let ciphertextBytes = 0;

  try {
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
      const ciphertext = new Uint8Array(encrypted.ciphertext);
      ciphertextBytes += ciphertext.byteLength;
      const ready = assembler.append(ciphertext);
      onChunk(sourceBytes);

      if (plan.mode === "multipart") {
        queueMultipartBuffers(multipart, ready);
        await uploadReadyMultipartParts(
          multipart,
          csrfToken,
          plan.uploadId,
          signal,
          false,
        );
      } else if (ready.length > 0) {
        if (ready.length !== 1 || singleContent) {
          throw new Error("The encrypted upload length is inconsistent.");
        }
        [singleContent] = ready;
      }
    }

    if (ciphertextBytes !== started.ciphertextLength) {
      throw new Error("The encrypted upload length is inconsistent.");
    }
    if (plan.mode === "single") {
      const trailing = assembler.finish();
      trailing?.fill(0);
      if (trailing || singleContent?.length !== started.ciphertextLength) {
        throw new Error("The encrypted upload length is inconsistent.");
      }
      await uploadSingle(csrfToken, plan.uploadId, singleContent, signal);
    } else {
      const trailing = assembler.finish();
      if (trailing) queueMultipartBuffers(multipart, [trailing]);
      await uploadReadyMultipartParts(
        multipart,
        csrfToken,
        plan.uploadId,
        signal,
        true,
      );
    }
    return multipart.completed;
  } finally {
    assembler.clear();
    singleContent?.fill(0);
    for (const part of multipart.pending) part.content.fill(0);
  }
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
  const reader = new ExactStreamReader(stream.getReader());
  const assembler = new FixedSizeBufferAssembler(
    encryptedUploadBufferSize(plan, started.ciphertextLength),
  );
  const multipart: MultipartBufferState = {
    nextPartNumber: 1,
    pending: [],
    completed: [],
  };
  let singleContent: Uint8Array | null = null;
  let processedBytes = 0;
  let ciphertextBytes = 0;

  try {
    for (let chunkIndex = 0; chunkIndex < started.chunkCount; chunkIndex += 1) {
      assertNotAborted(signal);
      const expected = Math.min(
        VAULT_CRYPTO_CHUNK_BYTES,
        plaintextBytes - processedBytes,
      );
      const plaintext = await reader.readExactly(expected);
      if (!plaintext) {
        throw new Error("The legacy object ended before its recorded size.");
      }
      let encrypted: Awaited<ReturnType<VaultCryptoClient["encryptChunk"]>>;
      try {
        encrypted = await client.encryptChunk(
          started.sessionId,
          chunkIndex,
          toArrayBuffer(plaintext),
        );
      } finally {
        if (plaintext.byteLength > 0) plaintext.fill(0);
      }
      const ciphertext = new Uint8Array(encrypted.ciphertext);
      ciphertextBytes += ciphertext.byteLength;
      const ready = assembler.append(ciphertext);
      processedBytes += expected;
      onChunk(processedBytes);

      if (plan.mode === "multipart") {
        queueMultipartBuffers(multipart, ready);
        await uploadReadyMultipartParts(
          multipart,
          csrfToken,
          plan.uploadId,
          signal,
          false,
        );
      } else if (ready.length > 0) {
        if (ready.length !== 1 || singleContent) {
          throw new Error("The encrypted migration length is inconsistent.");
        }
        [singleContent] = ready;
      }
    }
    if (
      !(await reader.isAtEnd()) ||
      ciphertextBytes !== started.ciphertextLength ||
      processedBytes !== plaintextBytes
    ) {
      throw new Error("The legacy object size changed during migration.");
    }
    if (plan.mode === "single") {
      const trailing = assembler.finish();
      trailing?.fill(0);
      if (trailing || singleContent?.length !== started.ciphertextLength) {
        throw new Error("The encrypted migration length is inconsistent.");
      }
      await uploadSingle(csrfToken, plan.uploadId, singleContent, signal);
    } else {
      const trailing = assembler.finish();
      if (trailing) queueMultipartBuffers(multipart, [trailing]);
      await uploadReadyMultipartParts(
        multipart,
        csrfToken,
        plan.uploadId,
        signal,
        true,
      );
    }
    return multipart.completed;
  } finally {
    assembler.clear();
    singleContent?.fill(0);
    for (const part of multipart.pending) part.content.fill(0);
    await reader.cancel();
  }
}

function encryptedUploadBufferSize(
  plan: VaultUploadPlan,
  ciphertextLength: number,
): number {
  const size =
    plan.mode === "multipart" ? plan.partSizeBytes : ciphertextLength;
  if (!Number.isSafeInteger(size) || !size || size < 1) {
    throw new Error("The encrypted upload plan is invalid.");
  }
  return size;
}

function queueMultipartBuffers(
  state: MultipartBufferState,
  buffers: Uint8Array[],
): void {
  for (const content of buffers) {
    state.pending.push({ partNumber: state.nextPartNumber, content });
    state.nextPartNumber += 1;
  }
}

async function uploadReadyMultipartParts(
  state: MultipartBufferState,
  csrfToken: string,
  uploadId: string,
  signal: AbortSignal,
  flushAll: boolean,
): Promise<void> {
  while (
    state.pending.length >= VAULT_PRESIGN_BATCH_SIZE ||
    (flushAll && state.pending.length > 0)
  ) {
    const batch = state.pending.splice(0, VAULT_PRESIGN_BATCH_SIZE);
    state.completed.push(
      ...(await uploadMultipartParts(csrfToken, uploadId, batch, signal)),
    );
  }
}

async function uploadSingle(
  csrfToken: string,
  uploadId: string,
  content: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  try {
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
  } finally {
    content.fill(0);
  }
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
        body: asBufferSource(content),
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

async function sha256Base64(content: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", asBufferSource(content)),
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
