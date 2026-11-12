import type {
  ExistingUploadNode,
  FolderUploadResolution,
} from "@/features/dashboard/folder-upload-conflicts";
import { runUploadWithRetry } from "@/features/uploads/upload-retry";
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
  InlineUploadLane,
  InlineUploadsUnavailableError,
} from "@/features/vault/inline-upload-lane";
import {
  asBufferSource,
  toArrayBuffer,
  VAULT_CRYPTO_CHUNK_BYTES,
  VAULT_MAX_CIPHERTEXT_BYTES,
  VAULT_SINGLE_UPLOAD_MAX_CIPHERTEXT_BYTES,
} from "@/features/vault/protocol";
import {
  beginShareDirectorySyncBatch,
  enqueueShareDirectorySync,
  finishShareDirectorySyncBatch,
} from "@/features/vault/share-directory-sync";
import {
  putStorageObject,
  type StoragePutResponse,
} from "@/features/vault/storage-put";
import {
  abortVaultUpload,
  getVaultContentUrl,
  getVaultPartUrl,
  getVaultPartUrls,
  initVaultUpload,
  publishVaultUpload,
  VAULT_UPLOAD_CONTROL_REQUESTS,
  type VaultCompletedPart,
  type VaultMigrationNode,
  type VaultPublishResponse,
  type VaultUploadPlan,
  type VaultUploadUrl,
} from "@/features/vault/vault-api";
import type { VaultCryptoClient } from "@/features/vault/vault-client";
import { VAULT_INLINE_UPLOAD_MAX_BYTES } from "@/features/vault/vault-wire";
import { baseName, parentDirectory } from "@/lib/paths";

const VAULT_PRESIGN_BATCH_SIZE = 4;
const VAULT_UPLOAD_CONCURRENCY = 4;
const VAULT_PRESIGN_FLUSH_MS = 4;
// Every storage PUT of this tab shares the multipart ceiling, so concurrent
// files never take the connections previews and downloads need.
const vaultStoragePutSlots = new WeightedSemaphore(VAULT_UPLOAD_CONCURRENCY);
const VAULT_DIRECT_FILE_CONCURRENCY_MAX = 4;
const MEBIBYTE = 1024 * 1024;
const VAULT_BUFFER_PART_BYTES = 32 * MEBIBYTE;
// Ciphertext the client-driven files in flight may hold together: the four
// uploading parts and the producer's next part that one multipart file
// needs. Smaller files share that ceiling instead of taking turns.
const VAULT_DIRECT_BUFFER_MEBIBYTES =
  ((VAULT_UPLOAD_CONCURRENCY + 1) * VAULT_BUFFER_PART_BYTES) / MEBIBYTE;
// Files this small cost more in round trips than in bytes, so they publish
// through inline batches instead of one init, storage PUT and publish each.
const VAULT_INLINE_FILE_MAX_BYTES = 1024 * 1024;
// Enough files in flight to fill every batch request, bounded by the
// ciphertext they keep in memory.
const VAULT_INLINE_ACTIVE_FILES = 128;
const VAULT_INLINE_ACTIVE_BYTES = 16 * 1024 * 1024;

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
    VAULT_DIRECT_FILE_CONCURRENCY_MAX,
  );
  const fileBudget = new WeightedSemaphore(VAULT_DIRECT_BUFFER_MEBIBYTES);
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
  // Inline files and client-driven files are admitted separately, so a large
  // file never holds back the small ones and neither starves the other.
  const inlineSupported =
    VAULT_SINGLE_UPLOAD_MAX_CIPHERTEXT_BYTES >= VAULT_INLINE_UPLOAD_MAX_BYTES;
  const ready: number[] = [];
  const inlineReady: number[] = [];
  let nextReady = 0;
  let nextInlineReady = 0;
  let directActive = 0;
  let inlineActive = 0;
  let inlineActiveBytes = 0;
  let foldersPublishing = true;
  const active = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  const fail = (error: unknown) => {
    failure ??= { error };
    if (!operation.signal.aborted) operation.abort(error);
  };
  const inlineLane = new InlineUploadLane({
    csrfToken,
    signal: operation.signal,
    // Folder batches and client-driven files need brief control requests of
    // their own; keep one of the server's slots free while they are running.
    maxRequests: () =>
      foldersPublishing || directActive > 0 || nextReady < ready.length
        ? VAULT_UPLOAD_CONTROL_REQUESTS - 1
        : VAULT_UPLOAD_CONTROL_REQUESTS,
  });
  const uploadFile = async (fileIndex: number, inline: boolean) => {
    assertNotAborted(operation.signal);
    onFileStart(fileIndex);
    const selection = selections[fileIndex];
    const path = paths[fileIndex];
    const parentId = folderIds.get(parentDirectory(path));
    if (parentId === undefined) {
      throw new Error("The selected file hierarchy is invalid.");
    }
    let fileProcessedBytes = 0;
    const entry = {
      file: selection.file,
      name: baseName(path),
      parentId: parentId || null,
      csrfToken,
      client,
      signal: operation.signal,
      replacement: resolution?.replacementFiles.get(path),
      shareSyncBatchId,
      onChunk: (sourceBytes: number) => {
        processedBytes += sourceBytes;
        fileProcessedBytes += sourceBytes;
        onProgress(processedBytes, totalBytes, fileIndex, fileProcessedBytes);
      },
    };
    if (inline) {
      try {
        await uploadInlineEntry({ ...entry, lane: inlineLane });
        onFileComplete(fileIndex);
      } catch (error) {
        if (!(error instanceof InlineUploadsUnavailableError)) throw error;
        // An API without inline uploads still takes every file the usual
        // way, at the client-driven lane's own concurrency: each of those
        // files holds one of the owner's pending-upload slots.
        ready.push(fileIndex);
      }
      return;
    }
    await uploadEncryptedEntry({
      ...entry,
      // Files hold the budget only while their ciphertext is buffered; the
      // small init and publication requests around it need no data permit.
      acquireContentPermit: (ciphertextLength) =>
        fileBudget.acquire(
          directBufferMebibytes(ciphertextLength),
          operation.signal,
        ),
    });
    onFileComplete(fileIndex);
  };
  const start = (fileIndex: number, inline: boolean) => {
    const bytes = selections[fileIndex].file.size;
    if (inline) {
      inlineActive += 1;
      inlineActiveBytes += bytes;
    } else {
      directActive += 1;
    }
    const work = uploadFile(fileIndex, inline)
      .catch((error) => {
        if (!failure) onFileError?.(fileIndex);
        fail(error);
      })
      .finally(() => {
        active.delete(work);
        if (inline) {
          inlineActive -= 1;
          inlineActiveBytes -= bytes;
        } else {
          directActive -= 1;
        }
        pump();
        inlineLane.poke();
      });
    active.add(work);
  };
  const pump = () => {
    while (!operation.signal.aborted) {
      const inlineWaiting = nextInlineReady < inlineReady.length;
      if (
        inlineWaiting &&
        inlineLane.available &&
        inlineActive < VAULT_INLINE_ACTIVE_FILES &&
        inlineActiveBytes < VAULT_INLINE_ACTIVE_BYTES
      ) {
        start(inlineReady[nextInlineReady++], true);
      } else if (directActive < fileConcurrency && nextReady < ready.length) {
        start(ready[nextReady++], false);
      } else if (
        directActive < fileConcurrency &&
        inlineWaiting &&
        !inlineLane.available
      ) {
        start(inlineReady[nextInlineReady++], false);
      } else {
        return;
      }
    }
  };
  const onPublished = (path: string) => {
    const indices = filesByParent.get(path);
    if (!indices) return;
    filesByParent.delete(path);
    for (const index of indices) {
      const inline =
        inlineSupported &&
        selections[index].file.size <= VAULT_INLINE_FILE_MAX_BYTES;
      (inline ? inlineReady : ready).push(index);
    }
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
    foldersPublishing = false;
    inlineLane.poke();
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

/**
 * Encrypts a small file completely and hands its ciphertext and signed record
 * to the inline lane, which publishes it together with its neighbours.
 */
async function uploadInlineEntry({
  file,
  name,
  parentId,
  csrfToken,
  client,
  signal,
  replacement,
  shareSyncBatchId,
  lane,
  onChunk,
}: {
  file: File;
  name: string;
  parentId: string | null;
  csrfToken: string;
  client: VaultCryptoClient;
  signal: AbortSignal;
  replacement?: ExistingUploadNode;
  shareSyncBatchId?: string;
  lane: InlineUploadLane;
  onChunk(bytes: number): void;
}): Promise<void> {
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
    entryType: "file",
    name,
    mimeType: file.type || null,
    plaintextBytes: file.size,
    lastModified: file.lastModified,
  });
  try {
    if (started.ciphertextLength > VAULT_INLINE_UPLOAD_MAX_BYTES) {
      throw new InlineUploadsUnavailableError();
    }
    assertNotAborted(signal);
    const content = await encryptSingleObject({
      file,
      started,
      client,
      signal,
    });
    let completed: Awaited<ReturnType<VaultCryptoClient["finalizeEncryption"]>>;
    try {
      completed = await client.finalizeEncryption(started.sessionId);
    } catch (error) {
      content.fill(0);
      throw error;
    }
    const published = await lane.submit({
      parentId,
      chunkCount: started.chunkCount,
      record: completed.record,
      content,
    });
    if (
      published.nodeId !== completed.nodeId ||
      published.generationNumber !== completed.generationNumber ||
      published.generationId !== completed.generationId ||
      published.recordVersion !== completed.recordVersion
    ) {
      throw new Error("The encrypted upload publication response is invalid.");
    }
    onChunk(file.size);
    syncPublishedShares({
      published,
      csrfToken,
      client,
      shareSyncBatchId,
      replacement,
      parentId,
      entryType: "file",
    });
  } catch (error) {
    await client
      .abortEncryption(started.sessionId, started.nodeId)
      .catch(() => undefined);
    throw error;
  }
}

function syncPublishedShares({
  published,
  csrfToken,
  client,
  shareSyncBatchId,
  replacement,
  parentId,
  entryType,
}: {
  published: VaultPublishResponse;
  csrfToken: string;
  client: VaultCryptoClient;
  shareSyncBatchId?: string;
  replacement?: ExistingUploadNode;
  parentId: string | null;
  entryType: "file" | "folder";
}): void {
  if (!published.shareSyncRequired) return;
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
      entryType,
    },
  });
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
  acquireContentPermit?(ciphertextLength: number): Promise<() => void>;
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
  // A single-object upload is buffered whole either way, so it is encrypted
  // before init: init then carries the checksum and returns the signed PUT,
  // saving the separate content-URL round trip for every small file.
  const singleObject =
    file !== null &&
    started.ciphertextLength <= VAULT_SINGLE_UPLOAD_MAX_CIPHERTEXT_BYTES;
  let releaseSingleContent: (() => void) | undefined;
  let singleContent: { bytes: Uint8Array; checksum: string } | null = null;
  let plan: VaultUploadPlan;
  try {
    if (file && singleObject) {
      releaseSingleContent = await acquireContentPermit?.(
        started.ciphertextLength,
      );
      assertNotAborted(signal);
      const bytes = await encryptSingleObject({
        file,
        started,
        client,
        signal,
      });
      singleContent = { bytes, checksum: await sha256Base64(bytes) };
    }
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
        ...(singleContent ? { checksumSha256: singleContent.checksum } : {}),
      },
      signal,
    );
  } catch (error) {
    singleContent?.bytes.fill(0);
    releaseSingleContent?.();
    await client
      .abortEncryption(started.sessionId, started.nodeId)
      .catch(() => undefined);
    throw error;
  }

  try {
    let parts: VaultCompletedPart[] = [];
    if (file && singleContent) {
      try {
        if (plan.mode !== "single") {
          throw new Error("The storage plan does not match the upload size.");
        }
        const progress = createUploadProgress(
          started.ciphertextLength,
          file.size,
          onChunk,
        );
        await uploadSingle(
          csrfToken,
          plan.uploadId,
          singleContent.bytes,
          signal,
          { checksum: singleContent.checksum, signed: plan.contentUrl },
          (sentBytes) => progress(1, sentBytes),
        );
      } finally {
        singleContent.bytes.fill(0);
        releaseSingleContent?.();
      }
    } else if (file) {
      const releaseContent = await acquireContentPermit?.(
        started.ciphertextLength,
      );
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
    syncPublishedShares({
      published,
      csrfToken,
      client,
      shareSyncBatchId,
      replacement,
      parentId,
      entryType: file ? "file" : "folder",
    });
    return { nodeId: completed.nodeId };
  } catch (error) {
    await client
      .abortEncryption(started.sessionId, started.nodeId)
      .catch(() => undefined);
    await abortVaultUpload(csrfToken, plan.uploadId).catch(() => undefined);
    throw error;
  }
}

/**
 * Credits a file's plaintext bytes in proportion to the ciphertext its storage
 * PUTs have sent. Each body counts only the furthest byte any attempt sent, so
 * a retried or re-signed PUT starts over without counting its bytes twice or
 * moving progress backwards.
 */
function createUploadProgress(
  ciphertextLength: number,
  plaintextBytes: number,
  onChunk: (bytes: number) => void,
): (body: number, sentBytes: number) => void {
  const sentByBody = new Map<number, number>();
  let sentCiphertextBytes = 0;
  let reportedPlaintextBytes = 0;
  return (body, sentBytes) => {
    const previous = sentByBody.get(body) ?? 0;
    if (sentBytes <= previous) return;
    sentByBody.set(body, sentBytes);
    sentCiphertextBytes += sentBytes - previous;
    const plaintext = Math.min(
      plaintextBytes,
      Math.floor((sentCiphertextBytes / ciphertextLength) * plaintextBytes),
    );
    if (plaintext <= reportedPlaintextBytes) return;
    onChunk(plaintext - reportedPlaintextBytes);
    reportedPlaintextBytes = plaintext;
  };
}

/** The share of the direct buffer budget one file's ciphertext occupies. */
function directBufferMebibytes(ciphertextLength: number): number {
  if (ciphertextLength <= VAULT_BUFFER_PART_BYTES) {
    return Math.max(1, Math.ceil(ciphertextLength / MEBIBYTE));
  }
  const parts = Math.ceil(ciphertextLength / VAULT_BUFFER_PART_BYTES);
  return Math.min(
    VAULT_DIRECT_BUFFER_MEBIBYTES,
    ((Math.min(parts, VAULT_UPLOAD_CONCURRENCY) + 1) *
      VAULT_BUFFER_PART_BYTES) /
      MEBIBYTE,
  );
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
  const progress = createUploadProgress(
    started.ciphertextLength,
    file.size,
    onChunk,
  );
  const multipart = createMultipartUploadPipeline(
    csrfToken,
    plan.uploadId,
    pipelineAbort,
    encryptedUploadBufferSize(plan, started.ciphertextLength),
    progress,
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
      await uploadSingle(
        csrfToken,
        plan.uploadId,
        singleContent,
        signal,
        undefined,
        (sentBytes) => progress(1, sentBytes),
      );
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
  onSent?: (partNumber: number, sentBytes: number) => void,
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
          onSent && ((sentBytes) => onSent(part.partNumber, sentBytes)),
        );
        const etag = upload.getResponseHeader("ETag")?.trim();
        if (!etag) {
          throw new Error(
            "The storage service did not expose the multipart ETag header.",
          );
        }
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

async function encryptSingleObject({
  file,
  started,
  client,
  signal,
}: {
  file: File;
  started: Awaited<ReturnType<VaultCryptoClient["startEncryption"]>>;
  client: VaultCryptoClient;
  signal: AbortSignal;
}): Promise<Uint8Array> {
  const content = new Uint8Array(started.ciphertextLength);
  let offset = 0;
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
      if (offset + ciphertext.byteLength > content.byteLength) {
        throw new Error("The encrypted upload length is inconsistent.");
      }
      content.set(ciphertext, offset);
      offset += ciphertext.byteLength;
      ciphertext.fill(0);
    }
    if (offset !== started.ciphertextLength) {
      throw new Error("The encrypted upload length is inconsistent.");
    }
    return content;
  } catch (error) {
    content.fill(0);
    throw error;
  }
}

async function uploadSingle(
  csrfToken: string,
  uploadId: string,
  content: Uint8Array,
  signal: AbortSignal,
  prepared?: { checksum: string; signed?: VaultUploadUrl },
  onProgress?: (sentBytes: number) => void,
): Promise<void> {
  try {
    const checksum = prepared?.checksum ?? (await sha256Base64(content));
    const signed =
      prepared?.signed ??
      (await getVaultContentUrl(csrfToken, uploadId, checksum, signal));
    if (signed.contentLength !== content.length) {
      throw new Error("The signed upload length is invalid.");
    }
    await putEncryptedBytes(
      signed.url,
      content,
      checksum,
      signal,
      async () => {
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
      },
      onProgress,
    );
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
  onProgress?: (sentBytes: number) => void,
): Promise<StoragePutResponse> {
  const release = await vaultStoragePutSlots.acquire(1, signal);
  try {
    return await runUploadWithRetry({
      initialUrl: url,
      refreshUrl,
      request: (candidateUrl) =>
        putStorageObject({
          url: candidateUrl,
          body: content,
          headers: {
            "Content-Type": "application/octet-stream",
            "x-amz-checksum-sha256": checksum,
          },
          signal,
          onProgress,
        }),
      signal,
    });
  } finally {
    release();
  }
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
