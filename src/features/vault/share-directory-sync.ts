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

export function enqueueShareDirectorySync(input: {
  csrfToken: string;
  client: VaultCryptoClient;
  job?: VaultShareSyncJob;
}): void {
  syncQueue = syncQueue
    .catch(() => undefined)
    .then(async () => {
      if (input.job) {
        await syncJob(input.client, input.csrfToken, input.job);
      } else {
        await drainJobs(input.client, input.csrfToken);
      }
    })
    // The database job remains durable and is retried after the next unlock.
    .catch(() => undefined);
}

async function drainJobs(
  client: VaultCryptoClient,
  csrfToken: string,
): Promise<void> {
  const attempted = new Set<string>();
  for (let page = 0; page < 32; page += 1) {
    const { jobs } = await getShareSyncJobs();
    const pending = jobs.filter((job) => !attempted.has(job.nodeId));
    if (pending.length === 0) return;
    let completed = 0;
    for (const job of pending) {
      attempted.add(job.nodeId);
      try {
        await syncJob(client, csrfToken, job);
        completed += 1;
      } catch {
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
): Promise<void> {
  const shareContexts = await getActiveShareContexts(job.nodeId);
  if (shareContexts.length === 0) {
    await publishShareDirectory(csrfToken, job, null);
    return;
  }
  let material: VaultShareDirectoryResult;
  try {
    material = await client.createShareDirectory({ ...job, shareContexts });
  } catch (error) {
    if (
      !(error instanceof VaultWorkerError) ||
      error.code !== "NODE_KEY_REQUIRED"
    ) {
      throw error;
    }
    await unlockNodeKey(client, job.nodeId, new Set());
    material = await client.createShareDirectory({ ...job, shareContexts });
  }
  await publishShareDirectory(csrfToken, job, material);
}

async function unlockNodeKey(
  client: VaultCryptoClient,
  nodeId: string,
  visiting: Set<string>,
): Promise<void> {
  if (visiting.has(nodeId)) {
    throw new Error("The encrypted parent hierarchy contains a cycle.");
  }
  visiting.add(nodeId);
  const plan = await getVaultDownloadPlan(nodeId);
  try {
    await client.openPlan(plan);
  } catch (error) {
    const parentId = requiredParentId(error);
    if (!parentId) throw error;
    await unlockNodeKey(client, parentId, visiting);
    await client.openPlan(plan);
  } finally {
    visiting.delete(nodeId);
  }
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
