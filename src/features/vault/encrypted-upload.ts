import type {
  ExistingUploadNode,
  FolderUploadResolution,
} from "@/features/dashboard/folder-upload-conflicts";
import {
  runUploadWithRetry,
  uploadRequestErrorFromResponse,
} from "@/features/uploads/upload-retry";
import {
  BoundedRollingPipeline,
  detectedCryptoConcurrency,
  WeightedSemaphore,
} from "@/features/vault/bounded-async";
import {
  ExactStreamReader,
  FixedSizeBufferAssembler,
} from "@/features/vault/buffered-bytes";
import { publishEncryptedFolderTree } from "@/features/vault/encrypted-folder-upload";
import {
  asBufferSource,
  toArrayBuffer,
  VAULT_CRYPTO_CHUNK_BYTES,
  VAULT_MAX_CIPHERTEXT_BYTES,
} from "@/features/vault/protocol";
import {
  beginShareDirectorySyncBatch,
  enqueueShareDirectorySync,
  finishShareDirectorySyncBatch,
} from "@/features/vault/share-directory-sync";
import {
  abortVaultUpload,
  getVaultContentUrl,
  getVaultPartUrl,
  getVaultPartUrls,
  initVaultUpload,
  publishVaultUpload,
  type VaultCompletedPart,
  type VaultMigrationNode,
  type VaultUploadPlan,
} from "@/features/vault/vault-api";
import type { VaultCryptoClient } from "@/features/vault/vault-client";

const VAULT_PRESIGN_BATCH_SIZE = 4;
const VAULT_UPLOAD_CONCURRENCY = 4;
const VAULT_PRESIGN_FLUSH_MS = 4;
const VAULT_SMALL_FILE_CONCURRENCY_MAX = 3;
const VAULT_CONCURRENT_FILE_MAX_BYTES = 8 * 1024 * 1024;

type PendingVaultPart = {
  partNumber: number;
  content: Uint8Array;
};

type MultipartUploadPipeline = BoundedRollingPipeline<
  PendingVaultPart,
  VaultCompletedPart
>;

export type EncryptedUploadSelection = {
  file: File;
  relativePath: string;
};

export async function uploadEncryptedSelections({
  selections,
  parentFolderId,
  resolution,
  csrfToken,
  client,
  signal,
  onProgress,
  onFileStart,
  onFileComplete,
  onFileError,
}: {
  selections: EncryptedUploadSelection[];
  parentFolderId: string | null;
  resolution?: FolderUploadResolution;
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
  onFileError?(fileIndex: number): void;
}): Promise<{ rootFolderId: string | null }> {
  const totalBytes = selections.reduce(
    (total, item) => total + item.file.size,
    0,
  );
  let processedBytes = 0;
  const folderIds = new Map<string, string>();
  folderIds.set("", parentFolderId ?? "");
  const folders = collectFolders(selections);
  const shareSyncBatchId = beginShareDirectorySyncBatch();

  const fileConcurrency = detectedCryptoConcurrency(
    VAULT_SMALL_FILE_CONCURRENCY_MAX,
  );
  const fileBudget = new WeightedSemaphore(fileConcurrency);
  const operation = linkedAbortController(signal);
  const filesByParent = new Map<string, number[]>();
  const paths = selections.map((selection, index) => {
    const path = normalizeRelativePath(
      selection.relativePath || selection.file.name,
    );
    const parentPath = parentDirectory(path);
    const children = filesByParent.get(parentPath) ?? [];
    children.push(index);
    filesByParent.set(parentPath, children);
    return path;
  });
  const ready: number[] = [];
  let nextReady = 0;
  const active = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  const fail = (error: unknown) => {
    failure ??= { error };
    if (!operation.signal.aborted) operation.abort(error);
  };
  const uploadFile = async (fileIndex: number) => {
    assertNotAborted(operation.signal);
    onFileStart(fileIndex);
    const selection = selections[fileIndex];
    const path = paths[fileIndex];
    const parentId = folderIds.get(parentDirectory(path));
    if (parentId === undefined) {
      throw new Error("The selected file hierarchy is invalid.");
    }
    let fileProcessedBytes = 0;
    await uploadEncryptedEntry({
      file: selection.file,
      name: baseName(path),
      parentId: parentId || null,
      csrfToken,
      client,
      signal: operation.signal,
      replacement: resolution?.replacementFiles.get(path),
      shareSyncBatchId,
      // Keep large-file data exclusive until device profiling supports raising
      // its buffer budget. Small init/finalization requests need no data permit.
      acquireContentPermit: () =>
        fileBudget.acquire(
          selection.file.size <= VAULT_CONCURRENT_FILE_MAX_BYTES
            ? 1
            : fileConcurrency,
          operation.signal,
        ),
      onChunk: (sourceBytes) => {
        processedBytes += sourceBytes;
        fileProcessedBytes += sourceBytes;
        onProgress(processedBytes, totalBytes, fileIndex, fileProcessedBytes);
      },
    });
    onFileComplete(fileIndex);
  };
  const pump = () => {
    while (
      !operation.signal.aborted &&
      active.size < fileConcurrency &&
      nextReady < ready.length
    ) {
      const fileIndex = ready[nextReady++];
      const work = uploadFile(fileIndex)
        .catch((error) => {
          if (!failure) onFileError?.(fileIndex);
          fail(error);
        })
        .finally(() => {
          active.delete(work);
          pump();
        });
      active.add(work);
    }
  };
  const onPublished = (path: string) => {
    const indices = filesByParent.get(path);
    if (!indices) return;
    filesByParent.delete(path);
    for (const index of indices) ready.push(index);
    pump();
  };

  try {
    onPublished("");
    try {
      await publishEncryptedFolderTree({
        folders,
        folderIds,
        existingFolders: resolution?.existingFolders,
        csrfToken,
        client,
        signal: operation.signal,
        shareSyncBatchId,
        priorityParents: new Set(filesByParent.keys()),
        onPublished,
      });
    } catch (error) {
      fail(error);
    }
    // Completion may schedule the next ready file; drain all started work before
    // finishing the share-sync batch or propagating an operation failure.
    while (active.size > 0) await Promise.all(active);
    if (failure) throw failure.error;
    assertNotAborted(operation.signal);
    if (filesByParent.size > 0)
      throw new Error("The selected file hierarchy is invalid.");
    const rootFolders = folders.filter((path) => !path.includes("/"));
    return {
      rootFolderId:
        rootFolders.length === 1
          ? (folderIds.get(rootFolders[0]) ?? null)
          : null,
    };
  } finally {
    operation.dispose();
    void finishShareDirectorySyncBatch({ batchId: shareSyncBatchId, client });
  }
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
    await client
      .abortEncryption(started.sessionId, started.nodeId)
      .catch(() => undefined);
    throw new Error(`${node.name} exceeds the encrypted upload limit.`);
  }
  let plan: VaultUploadPlan;
  try {
    plan = await initVaultUpload(
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
  } catch (error) {
    await client
      .abortEncryption(started.sessionId, started.nodeId)
      .catch(() => undefined);
    throw error;
  }

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
    await client
      .abortEncryption(started.sessionId, started.nodeId)
      .catch(() => undefined);
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
  replacement,
  shareSyncBatchId,
  acquireContentPermit,
  onChunk,
}: {
  file: File | null;
  name: string;
  parentId: string | null;
  csrfToken: string;
  client: VaultCryptoClient;
  signal: AbortSignal;
  replacement?: ExistingUploadNode;
  shareSyncBatchId?: string;
  acquireContentPermit?(): Promise<() => void>;
  onChunk(bytes: number): void;
}): Promise<{ nodeId: string }> {
  const replacementVersion = getEncryptedReplacementVersion(replacement);
  const started = await client.startEncryption({
    ...(replacementVersion
      ? {
          nodeId: replacementVersion.nodeId,
          generationNumber: replacementVersion.generationNumber + 1,
          recordVersion: replacementVersion.recordVersion + 1,
          previousRecordHash: replacementVersion.recordHash,
        }
      : {}),
    parentId,
    entryType: file ? "file" : "folder",
    name,
    mimeType: file?.type || null,
    plaintextBytes: file?.size ?? 0,
    lastModified: file?.lastModified ?? Date.now(),
  });
  if (started.ciphertextLength > VAULT_MAX_CIPHERTEXT_BYTES) {
    await client
      .abortEncryption(started.sessionId, started.nodeId)
      .catch(() => undefined);
    throw new Error(`${name} exceeds the encrypted upload limit.`);
  }
  let plan: VaultUploadPlan;
  try {
    plan = await initVaultUpload(
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
  } catch (error) {
    await client
      .abortEncryption(started.sessionId, started.nodeId)
      .catch(() => undefined);
    throw error;
  }

  try {
    let parts: VaultCompletedPart[] = [];
    if (file) {
      const releaseContent = await acquireContentPermit?.();
      try {
        assertNotAborted(signal);
        parts = await encryptAndUploadFile({
          file,
          started,
          plan,
          csrfToken,
          client,
          signal,
          onChunk,
        });
      } finally {
        releaseContent?.();
      }
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
        batchId: shareSyncBatchId,
        job: {
          ...published,
          ...(shareSyncBatchId
            ? {
                contextCacheKey: replacement
                  ? published.nodeId
                  : (parentId ?? published.nodeId),
              }
            : {}),
          entryType: file ? "file" : "folder",
        },
      });
    }
    return { nodeId: completed.nodeId };
  } catch (error) {
    await client
      .abortEncryption(started.sessionId, started.nodeId)
      .catch(() => undefined);
    await abortVaultUpload(csrfToken, plan.uploadId).catch(() => undefined);
    throw error;
  }
}

export function getEncryptedReplacementVersion(
  replacement?: ExistingUploadNode,
) {
  if (!replacement) return null;
  if (
    replacement.e2eeState !== "encrypted" ||
    !Number.isSafeInteger(replacement.generationNumber) ||
    !Number.isSafeInteger(replacement.recordVersion) ||
    (replacement.generationNumber ?? 0) < 1 ||
    (replacement.recordVersion ?? 0) < 1 ||
    !replacement.recordHash
  ) {
    throw new Error(
      `“${replacement.name}” cannot be replaced until its encrypted record is ready.`,
    );
  }
  return {
    nodeId: replacement.id,
    generationNumber: replacement.generationNumber as number,
    recordVersion: replacement.recordVersion as number,
    recordHash: replacement.recordHash,
  };
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
  const assembler = new FixedSizeBufferAssembler(
    encryptedUploadBufferSize(plan, started.ciphertextLength),
  );
  const pipelineAbort = linkedAbortController(signal);
  let uploadedCiphertextBytes = 0;
  let reportedPlaintextBytes = 0;
  const multipart = createMultipartUploadPipeline(
    csrfToken,
    plan.uploadId,
    pipelineAbort,
    encryptedUploadBufferSize(plan, started.ciphertextLength),
    (bytes) => {
      uploadedCiphertextBytes += bytes;
      const plaintextBytes = Math.min(
        file.size,
        Math.floor(
          (uploadedCiphertextBytes / started.ciphertextLength) * file.size,
        ),
      );
      onChunk(plaintextBytes - reportedPlaintextBytes);
      reportedPlaintextBytes = plaintextBytes;
    },
  );
  let nextPartNumber = 1;
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
      const encrypted = await client.encryptChunk(
        started.sessionId,
        chunkIndex,
        plaintext,
      );
      const ciphertext = new Uint8Array(encrypted.ciphertext);
      ciphertextBytes += ciphertext.byteLength;
      const ready = assembler.append(ciphertext);

      if (plan.mode === "multipart") {
        nextPartNumber = await queueMultipartBuffers(
          multipart,
          ready,
          nextPartNumber,
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
      onChunk(file.size);
    } else {
      const trailing = assembler.finish();
      if (trailing) {
        nextPartNumber = await queueMultipartBuffers(
          multipart,
          [trailing],
          nextPartNumber,
        );
      }
    }
    return await multipart.finish();
  } finally {
    pipelineAbort.abort();
    await multipart.stop();
    assembler.clear();
    singleContent?.fill(0);
    pipelineAbort.dispose();
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
  const reader = new ExactStreamReader(stream.getReader());
  const assembler = new FixedSizeBufferAssembler(
    encryptedUploadBufferSize(plan, started.ciphertextLength),
  );
  const pipelineAbort = linkedAbortController(signal);
  const multipart = createMultipartUploadPipeline(
    csrfToken,
    plan.uploadId,
    pipelineAbort,
    encryptedUploadBufferSize(plan, started.ciphertextLength),
  );
  let nextPartNumber = 1;
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
        nextPartNumber = await queueMultipartBuffers(
          multipart,
          ready,
          nextPartNumber,
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
      if (trailing) {
        nextPartNumber = await queueMultipartBuffers(
          multipart,
          [trailing],
          nextPartNumber,
        );
      }
    }
    return await multipart.finish();
  } finally {
    pipelineAbort.abort();
    await multipart.stop();
    assembler.clear();
    singleContent?.fill(0);
    pipelineAbort.dispose();
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

function createMultipartUploadPipeline(
  csrfToken: string,
  uploadId: string,
  operation: ReturnType<typeof linkedAbortController>,
  partBytes: number,
  onUploaded?: (bytes: number) => void,
): MultipartUploadPipeline {
  const presign = createPartPresigner(csrfToken, uploadId, operation.signal);
  // Four active bodies plus the producer's next part, its partial assembler,
  // and one crypto chunk keep the previous four-part/one-lookahead ceiling.
  return new BoundedRollingPipeline(
    VAULT_UPLOAD_CONCURRENCY,
    VAULT_UPLOAD_CONCURRENCY * partBytes,
    (part: PendingVaultPart) => part.content.buffer.byteLength,
    async (part) => {
      try {
        assertNotAborted(operation.signal);
        const checksumSha256 = await sha256Base64(part.content);
        const signed = await presign(part.partNumber, checksumSha256);
        if (signed.contentLength !== part.content.length) {
          throw new Error("The signed multipart length is invalid.");
        }
        const upload = await putEncryptedBytes(
          signed.url,
          part.content,
          checksumSha256,
          operation.signal,
          async () => {
            const refreshed = await getVaultPartUrl(
              csrfToken,
              uploadId,
              part.partNumber,
              checksumSha256,
              operation.signal,
            );
            if (refreshed.contentLength !== part.content.length) {
              throw new Error("The signed multipart length is invalid.");
            }
            return refreshed.url;
          },
        );
        const etag = upload.headers.get("ETag")?.trim();
        if (!etag) {
          throw new Error(
            "The storage service did not expose the multipart ETag header.",
          );
        }
        onUploaded?.(part.content.length);
        return { partNumber: part.partNumber, etag, checksumSha256 };
      } finally {
        part.content.fill(0);
      }
    },
    operation.signal,
    (error) => operation.abort(error),
  );
}

function createPartPresigner(
  csrfToken: string,
  uploadId: string,
  signal: AbortSignal,
) {
  type SignedPart = Awaited<ReturnType<typeof getVaultPartUrl>>;
  type Pending = {
    partNumber: number;
    checksumSha256: string;
    resolve(value: SignedPart): void;
    reject(error: unknown): void;
  };
  let pending: Pending[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    const batch = pending;
    pending = [];
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    signal.removeEventListener("abort", abort);
    try {
      assertNotAborted(signal);
      const response = await getVaultPartUrls(
        csrfToken,
        uploadId,
        batch.map(({ partNumber, checksumSha256 }) => ({
          partNumber,
          checksumSha256,
        })),
        signal,
      );
      const signed = new Map(
        response.parts.map((part) => [part.partNumber, part]),
      );
      if (
        signed.size !== batch.length ||
        batch.some((part) => !signed.has(part.partNumber))
      ) {
        throw new Error("The signed multipart batch is incomplete.");
      }
      for (const part of batch) {
        const value = signed.get(part.partNumber);
        if (value) part.resolve(value);
      }
    } catch (error) {
      for (const part of batch) part.reject(error);
    }
  };
  const abort = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const part of pending) {
      part.reject(
        signal.reason ??
          new DOMException("The operation was aborted.", "AbortError"),
      );
    }
    pending = [];
  };
  return (partNumber: number, checksumSha256: string): Promise<SignedPart> => {
    assertNotAborted(signal);
    return new Promise((resolve, reject) => {
      pending.push({ partNumber, checksumSha256, resolve, reject });
      if (pending.length === VAULT_PRESIGN_BATCH_SIZE) {
        void flush();
      } else if (timer === undefined) {
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => void flush(), VAULT_PRESIGN_FLUSH_MS);
      }
    });
  };
}

async function queueMultipartBuffers(
  pipeline: MultipartUploadPipeline,
  buffers: Uint8Array[],
  nextPartNumber: number,
): Promise<number> {
  for (const [index, content] of buffers.entries()) {
    try {
      await pipeline.push({ partNumber: nextPartNumber, content });
      nextPartNumber += 1;
    } catch (error) {
      for (const abandoned of buffers.slice(index)) abandoned.fill(0);
      throw error;
    }
  }
  return nextPartNumber;
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
    await putEncryptedBytes(signed.url, content, checksum, signal, async () => {
      const refreshed = await getVaultContentUrl(
        csrfToken,
        uploadId,
        checksum,
        signal,
      );
      if (refreshed.contentLength !== content.length) {
        throw new Error("The signed upload length is invalid.");
      }
      return refreshed.url;
    });
  } finally {
    content.fill(0);
  }
}

async function putEncryptedBytes(
  url: string,
  content: Uint8Array,
  checksum: string,
  signal: AbortSignal,
  refreshUrl?: () => Promise<string>,
): Promise<Response> {
  return runUploadWithRetry({
    initialUrl: url,
    refreshUrl,
    request: async (candidateUrl) => {
      const response = await fetch(candidateUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-amz-checksum-sha256": checksum,
        },
        body: asBufferSource(content),
        signal,
      });
      if (!response.ok) {
        throw await uploadRequestErrorFromResponse(response);
      }
      return response;
    },
    signal,
  });
}

function collectFolders(selections: EncryptedUploadSelection[]): string[] {
  const folders = new Set<string>();
  for (const selection of selections) {
    let directory = parentDirectory(
      normalizeRelativePath(selection.relativePath || selection.file.name),
    );
    while (directory) {
      if (pathDepth(directory) > 100) {
        throw new Error("The selected folder hierarchy exceeds 100 levels.");
      }
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

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Upload canceled", "AbortError");
}

function linkedAbortController(parent: AbortSignal): {
  signal: AbortSignal;
  abort(reason?: unknown): void;
  dispose(): void;
} {
  const controller = new AbortController();
  const forward = () => controller.abort(parent.reason);
  if (parent.aborted) forward();
  else parent.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    dispose: () => parent.removeEventListener("abort", forward),
  };
}
