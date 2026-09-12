import type { ExistingUploadNode } from "@/features/dashboard/folder-upload-conflicts";
import { detectedCryptoConcurrency } from "@/features/vault/bounded-async";
import { enqueueShareDirectorySync } from "@/features/vault/share-directory-sync";
import { publishVaultFoldersBatch } from "@/features/vault/vault-api";
import type { VaultCryptoClient } from "@/features/vault/vault-client";

const FOLDER_BATCH_SIZE = 100;
const FOLDER_CRYPTO_CONCURRENCY = 4;
const FILE_PARENT_FLUSH_DELAY_MS = 8;

type PreparedFolder = {
  path: string;
  sessionId: string;
  parentId: string | null;
  complete: Awaited<ReturnType<VaultCryptoClient["finalizeEncryption"]>>;
};

type FolderEvent =
  | { type: "prepared"; folder: PreparedFolder }
  | { type: "published" }
  | { type: "flush" }
  | { type: "failed"; error: unknown };

/** Prepares parent keys before descendants and releases only durable folders. */
export async function publishEncryptedFolderTree({
  folders,
  folderIds,
  existingFolders,
  csrfToken,
  client,
  signal,
  shareSyncBatchId,
  priorityParents,
  onPublished,
}: {
  folders: string[];
  folderIds: Map<string, string>;
  existingFolders?: Map<string, ExistingUploadNode>;
  csrfToken: string;
  client: VaultCryptoClient;
  signal: AbortSignal;
  shareSyncBatchId: string;
  priorityParents?: ReadonlySet<string>;
  onPublished?(path: string, folderId: string): void;
}): Promise<void> {
  const allPaths = new Set(folders);
  for (const path of folders) {
    if (
      !path ||
      (!allPaths.has(parentDirectory(path)) &&
        !folderIds.has(parentDirectory(path)))
    ) {
      throw new Error("The selected folder hierarchy is invalid.");
    }
  }

  // Prefer branches containing files without serializing independent siblings.
  const priorityPaths = new Set<string>();
  for (const parent of priorityParents ?? []) {
    let path = parent;
    while (path && !priorityPaths.has(path)) {
      priorityPaths.add(path);
      path = parentDirectory(path);
    }
  }
  const children = new Map<string, string[]>();
  const ready: string[] = [];
  const priorityReady: string[] = [];
  const priorityDescendants: string[] = [];
  let readyIndex = 0;
  let priorityIndex = 0;
  const enqueueReady = (path: string, descendant = false) => {
    if (priorityPaths.has(path)) {
      (descendant ? priorityDescendants : priorityReady).push(path);
    } else {
      ready.push(path);
    }
  };
  const hasReady = () =>
    priorityDescendants.length > 0 ||
    priorityIndex < priorityReady.length ||
    readyIndex < ready.length;

  const preparedIds = new Map<string, string>();
  const sessions = new Map<string, string>();
  const active = new Map<string, Promise<void>>();
  let pending: PreparedFolder[] = [];
  let publication: Promise<void> | undefined;
  let publishingCount = 0;
  let flushDue = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const events: FolderEvent[] = [];
  let waiter: ((event: FolderEvent) => void) | undefined;
  const emit = (event: FolderEvent) => {
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve(event);
    } else {
      events.push(event);
    }
  };
  const nextEvent = (): Promise<FolderEvent> => {
    const event = events.shift();
    return event
      ? Promise.resolve(event)
      : new Promise((resolve) => {
          waiter = resolve;
        });
  };
  const operation = new AbortController();
  const abort = () => {
    operation.abort(signal.reason);
    emit({ type: "failed", error: abortReason(signal) });
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  const prepare = async (path: string): Promise<PreparedFolder> => {
    const parentPath = parentDirectory(path);
    const parentId = preparedIds.get(parentPath) ?? folderIds.get(parentPath);
    if (parentId === undefined) {
      throw new Error("The selected folder hierarchy is invalid.");
    }
    const started = await client.startEncryption({
      parentId: parentId || null,
      entryType: "folder",
      name: path.slice(path.lastIndexOf("/") + 1),
      mimeType: null,
      plaintextBytes: 0,
      lastModified: Date.now(),
    });
    sessions.set(started.sessionId, started.nodeId);
    assertNotAborted(operation.signal);
    const complete = await client.finalizeEncryption(started.sessionId);
    assertNotAborted(operation.signal);
    return {
      path,
      sessionId: started.sessionId,
      parentId: parentId || null,
      complete,
    };
  };

  const publish = async (batch: PreparedFolder[]) => {
    const response = await publishVaultFoldersBatch(
      csrfToken,
      batch.map(({ complete }) => complete.record),
      operation.signal,
    );
    if (response.folders.length !== batch.length) {
      throw new Error(
        "The encrypted folder publication response is incomplete.",
      );
    }
    // Validate the entire response before releasing any dependent file.
    for (const [index, published] of response.folders.entries()) {
      const { complete } = batch[index];
      if (
        published.nodeId !== complete.nodeId ||
        published.generationNumber !== complete.generationNumber ||
        published.generationId !== complete.generationId ||
        published.recordVersion !== complete.recordVersion
      ) {
        throw new Error(
          "The encrypted folder publication response is invalid.",
        );
      }
    }
    for (const { path, sessionId, complete } of batch) {
      sessions.delete(sessionId);
      preparedIds.delete(path);
      folderIds.set(path, complete.nodeId);
    }
    for (const [index, published] of response.folders.entries()) {
      const { parentId } = batch[index];
      if (published.shareSyncRequired) {
        enqueueShareDirectorySync({
          csrfToken,
          client,
          batchId: shareSyncBatchId,
          job: {
            ...published,
            contextCacheKey: parentId ?? published.nodeId,
            entryType: "folder",
          },
        });
      }
    }
    for (const { path, complete } of batch) {
      if (!operation.signal.aborted) onPublished?.(path, complete.nodeId);
    }
  };

  try {
    assertNotAborted(operation.signal);
    for (const path of allPaths) {
      const existing = existingFolders?.get(path);
      if (existing) folderIds.set(path, existing.id);
    }
    for (const path of allPaths) {
      const publishedId = folderIds.get(path);
      if (publishedId !== undefined) {
        onPublished?.(path, publishedId);
        continue;
      }
      const parent = parentDirectory(path);
      if (folderIds.has(parent)) {
        enqueueReady(path);
      } else {
        const siblings = children.get(parent) ?? [];
        siblings.push(path);
        children.set(parent, siblings);
      }
    }

    const concurrency = detectedCryptoConcurrency(FOLDER_CRYPTO_CONCURRENCY);
    while (hasReady() || active.size || pending.length || publication) {
      assertNotAborted(operation.signal);
      while (
        hasReady() &&
        active.size < concurrency &&
        pending.length + publishingCount + active.size < FOLDER_BATCH_SIZE
      ) {
        // Continue active branches toward their files before opening more
        // roots. A breadth-only queue delays every deep file until the end.
        const path =
          priorityDescendants.pop() ??
          (priorityIndex < priorityReady.length
            ? priorityReady[priorityIndex++]
            : ready[readyIndex++]);
        active.set(
          path,
          prepare(path).then(
            (folder) => emit({ type: "prepared", folder }),
            (error: unknown) => emit({ type: "failed", error }),
          ),
        );
      }
      if (
        !publication &&
        pending.length > 0 &&
        (flushDue ||
          pending.length === FOLDER_BATCH_SIZE ||
          (!hasReady() && active.size === 0))
      ) {
        const batch = pending;
        pending = [];
        publishingCount = batch.length;
        flushDue = false;
        clearTimeout(flushTimer);
        flushTimer = undefined;
        publication = publish(batch).then(
          () => emit({ type: "published" }),
          (error: unknown) => emit({ type: "failed", error }),
        );
      }
      // Each task subscribes once. Repeated Promise.race calls would retain a
      // reaction per fast sibling on a single slow worker request.
      const event = await nextEvent();
      if (event.type === "failed") throw event.error;
      if (event.type === "published") {
        publication = undefined;
        publishingCount = 0;
      } else if (event.type === "flush") {
        flushTimer = undefined;
        flushDue = true;
      } else {
        const { folder } = event;
        active.delete(folder.path);
        pending.push(folder);
        preparedIds.set(folder.path, folder.complete.nodeId);
        for (const child of children.get(folder.path) ?? [])
          enqueueReady(child, true);
        children.delete(folder.path);
        if (priorityParents?.has(folder.path) && !flushTimer && !flushDue) {
          flushTimer = setTimeout(
            () => emit({ type: "flush" }),
            FILE_PARENT_FLUSH_DELAY_MS,
          );
        }
      }
    }
    assertNotAborted(operation.signal);
  } catch (error) {
    operation.abort(error);
    // Worker messages cannot be interrupted. Wait for every started session to
    // become known before cleaning up its key, including late start responses.
    await Promise.allSettled([
      ...active.values(),
      ...(publication ? [publication] : []),
    ]);
    await Promise.allSettled(
      Array.from(sessions, ([sessionId, nodeId]) =>
        client.abortEncryption(sessionId, nodeId),
      ),
    );
    throw error;
  } finally {
    clearTimeout(flushTimer);
    signal.removeEventListener("abort", abort);
  }
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The upload was cancelled.", "AbortError")
  );
}
