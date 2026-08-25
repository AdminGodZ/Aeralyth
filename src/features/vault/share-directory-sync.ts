import type { VaultActiveShareContext } from "@/features/vault/protocol";
import {
  getActiveShareContexts,
  getShareSyncJobs,
  getVaultDownloadPlan,
  publishShareDirectory,
  type VaultShareSyncJob,
} from "@/features/vault/vault-api";
import {
  type VaultCryptoClient,
  VaultWorkerError,
} from "@/features/vault/vault-client";
import type { VaultShareDirectoryResult } from "@/features/vault/vault-messages";

let syncQueue: Promise<void> = Promise.resolve();
let nextBatchId = 1;
let syncGeneration = 0;
const activeSyncControllers = new Set<AbortController>();
type ShareSyncBatchState = {
  cancelled: boolean;
  client: VaultCryptoClient | null;
  contextFlights: Map<string, Promise<VaultActiveShareContext[]>>;
  workerCacheKeys: Set<string>;
};
const syncBatches = new Map<string, ShareSyncBatchState>();

export function beginShareDirectorySyncBatch(): string {
  const batchId = `upload-${nextBatchId}`;
  nextBatchId += 1;
  syncBatches.set(batchId, {
    cancelled: false,
    client: null,
    contextFlights: new Map(),
    workerCacheKeys: new Set(),
  });
  return batchId;
}

export function cancelShareDirectorySyncForLock(): void {
  syncGeneration += 1;
  const reason = vaultLockAbort();
  for (const controller of activeSyncControllers) controller.abort(reason);
  for (const batch of syncBatches.values()) {
    batch.cancelled = true;
    batch.contextFlights.clear();
    const { client } = batch;
    if (client) {
      for (const cacheKey of batch.workerCacheKeys) {
        void client.clearShareContextCache(cacheKey).catch(() => undefined);
      }
    }
    batch.workerCacheKeys.clear();
  }
}

export function enqueueShareDirectorySync(input: {
  csrfToken: string;
  client: VaultCryptoClient;
  job?: VaultShareSyncJob;
  batchId?: string;
}): Promise<void> {
  const scheduledGeneration = syncGeneration;
  syncQueue = syncQueue
    .catch(() => undefined)
    .then(async () => {
      const batch = input.batchId ? syncBatches.get(input.batchId) : undefined;
      if (scheduledGeneration !== syncGeneration || batch?.cancelled) return;
      if (batch) batch.client = input.client;
      const controller = new AbortController();
      activeSyncControllers.add(controller);
      try {
        assertSyncActive(scheduledGeneration, controller.signal, batch);
        if (input.job) {
          await syncJob(
            input.client,
            input.csrfToken,
            input.job,
            scheduledGeneration,
            controller.signal,
            input.batchId,
          );
        } else {
          await drainJobs(
            input.client,
            input.csrfToken,
            scheduledGeneration,
            controller.signal,
          );
        }
      } finally {
        activeSyncControllers.delete(controller);
      }
    })
    // The database job remains durable and is retried after the next unlock.
    .catch(() => undefined);
  return syncQueue;
}

export function finishShareDirectorySyncBatch({
  batchId,
  client,
}: {
  batchId: string;
  client: VaultCryptoClient;
}): Promise<void> {
  syncQueue = syncQueue
    .catch(() => undefined)
    .then(async () => {
      const state = syncBatches.get(batchId);
      syncBatches.delete(batchId);
      if (!state) return;
      await Promise.allSettled(
        Array.from(state.workerCacheKeys, (cacheKey) =>
          client.clearShareContextCache(cacheKey),
        ),
      );
    })
    .catch(() => undefined);
  return syncQueue;
}

async function drainJobs(
  client: VaultCryptoClient,
  csrfToken: string,
  generation: number,
  signal: AbortSignal,
): Promise<void> {
  const attempted = new Set<string>();
  for (let page = 0; page < 32; page += 1) {
    assertSyncActive(generation, signal);
    const { jobs } = await getShareSyncJobs(signal);
    assertSyncActive(generation, signal);
    const pending = jobs.filter((job) => !attempted.has(job.nodeId));
    if (pending.length === 0) return;
    let completed = 0;
    for (const job of pending) {
      attempted.add(job.nodeId);
      try {
        await syncJob(client, csrfToken, job, generation, signal);
        completed += 1;
      } catch {
        assertSyncActive(generation, signal);
        // Continue with unrelated nodes; this job stays durable for a later pass.
      }
    }
    if (jobs.length < 32 || completed === 0) return;
  }
}

async function syncJob(
  client: VaultCryptoClient,
  csrfToken: string,
  job: VaultShareSyncJob,
  generation: number,
  signal: AbortSignal,
  batchId?: string,
): Promise<void> {
  const batch = batchId ? syncBatches.get(batchId) : undefined;
  const contextKey = batch && job.contextCacheKey;
  const workerCacheKey =
    batchId && contextKey ? `${batchId}:${contextKey}` : undefined;
  try {
    assertSyncActive(generation, signal, batch);
    const shareContexts = contextKey
      ? await loadBatchShareContexts(batch, contextKey, job.nodeId, signal)
      : await getActiveShareContexts(job.nodeId, signal);
    assertSyncActive(generation, signal, batch);
    if (shareContexts.length === 0) {
      await publishShareDirectory(csrfToken, job, null, signal);
      return;
    }
    if (workerCacheKey && batch) batch.workerCacheKeys.add(workerCacheKey);
    let material: VaultShareDirectoryResult;
    try {
      material = await client.createShareDirectory({
        ...job,
        shareContexts,
        shareContextCacheKey: workerCacheKey,
      });
    } catch (error) {
      if (
        !(error instanceof VaultWorkerError) ||
        error.code !== "NODE_KEY_REQUIRED"
      ) {
        throw error;
      }
      await unlockNodeKey(
        client,
        job.nodeId,
        new Set(),
        generation,
        signal,
        batch,
      );
      material = await client.createShareDirectory({
        ...job,
        shareContexts,
        shareContextCacheKey: workerCacheKey,
      });
    }
    assertSyncActive(generation, signal, batch);
    await publishShareDirectory(csrfToken, job, material, signal);
  } catch (error) {
    if (contextKey && workerCacheKey) {
      batch.contextFlights.delete(contextKey);
      batch.workerCacheKeys.delete(workerCacheKey);
      await client
        .clearShareContextCache(workerCacheKey)
        .catch(() => undefined);
    }
    throw error;
  }
}

function loadBatchShareContexts(
  batch: ShareSyncBatchState,
  contextKey: string,
  nodeId: string,
  signal: AbortSignal,
): Promise<VaultActiveShareContext[]> {
  const existing = batch.contextFlights.get(contextKey);
  if (existing) return existing;
  const contexts = getActiveShareContexts(nodeId, signal);
  batch.contextFlights.set(contextKey, contexts);
  void contexts.catch(() => {
    if (batch.contextFlights.get(contextKey) === contexts) {
      batch.contextFlights.delete(contextKey);
    }
  });
  return contexts;
}

async function unlockNodeKey(
  client: VaultCryptoClient,
  nodeId: string,
  visiting: Set<string>,
  generation: number,
  signal: AbortSignal,
  batch?: ShareSyncBatchState,
): Promise<void> {
  assertSyncActive(generation, signal, batch);
  if (visiting.has(nodeId)) {
    throw new Error("The encrypted parent hierarchy contains a cycle.");
  }
  visiting.add(nodeId);
  const plan = await getVaultDownloadPlan(nodeId, signal);
  assertSyncActive(generation, signal, batch);
  try {
    await client.openPlan(plan);
    assertSyncActive(generation, signal, batch);
  } catch (error) {
    const parentId = requiredParentId(error);
    if (!parentId) throw error;
    await unlockNodeKey(client, parentId, visiting, generation, signal, batch);
    await client.openPlan(plan);
    assertSyncActive(generation, signal, batch);
  } finally {
    visiting.delete(nodeId);
  }
}

function assertSyncActive(
  generation: number,
  signal: AbortSignal,
  batch?: ShareSyncBatchState,
): void {
  if (generation !== syncGeneration || signal.aborted || batch?.cancelled) {
    throw signal.reason instanceof Error ? signal.reason : vaultLockAbort();
  }
}

function vaultLockAbort(): Error {
  const error = new Error("The vault was locked during share synchronization.");
  error.name = "AbortError";
  return error;
}

function requiredParentId(error: unknown): string | null {
  if (
    !(error instanceof VaultWorkerError) ||
    error.code !== "PARENT_KEY_REQUIRED"
  ) {
    return null;
  }
  const separator = error.message.lastIndexOf(":");
  const parentId = separator >= 0 ? error.message.slice(separator + 1) : "";
  return parentId || null;
}
