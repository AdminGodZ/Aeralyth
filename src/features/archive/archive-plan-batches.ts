import type { VaultDownloadPlan } from "@/features/vault/protocol";

/** Plans requested together; well under the server's batch limit. */
export const ARCHIVE_PLAN_BATCH_SIZE = 64;
/**
 * The next batch is requested once this few planned entries remain ahead, so
 * it arrives before the archive window reaches it.
 */
export const ARCHIVE_PLAN_REFILL = 16;

type PlanEntry = { id: string; e2eeState: string };

export type GetDownloadPlans = (
  nodeIds: readonly string[],
  signal?: AbortSignal,
) => Promise<Array<VaultDownloadPlan | Error>>;

/**
 * Serves the per-entry plan lookups of an archive from batched requests. Plans
 * are fetched a batch at a time just ahead of the entries asking for them, in
 * archive order, never for the whole archive up front: their download URLs
 * are short-lived (a URL that expires anyway is renewed on use). A node the
 * server refuses fails only its own lookup; a failed request fails its batch.
 */
export function batchArchivePlans<T extends PlanEntry>(
  entries: readonly T[],
  {
    getPlans,
    signal,
    batchSize = ARCHIVE_PLAN_BATCH_SIZE,
    refill = ARCHIVE_PLAN_REFILL,
  }: {
    getPlans: GetDownloadPlans;
    signal?: AbortSignal;
    batchSize?: number;
    refill?: number;
  },
): (nodeId: string) => Promise<VaultDownloadPlan> {
  const nodeIds = entries
    .filter((entry) => entry.e2eeState === "encrypted")
    .map((entry) => entry.id);
  const positions = new Map(nodeIds.map((nodeId, index) => [nodeId, index]));
  const plans = new Map<string, Promise<VaultDownloadPlan>>();
  let requested = 0;

  const requestBatch = () => {
    const batch = nodeIds.slice(requested, requested + batchSize);
    requested += batch.length;
    const results = getPlans(batch, signal);
    for (const [index, nodeId] of batch.entries()) {
      const plan = results.then((planned) => {
        const result = planned[index];
        if (result instanceof Error) throw result;
        return result;
      });
      // Failures surface when the entry asks for its plan.
      plan.catch(() => undefined);
      plans.set(nodeId, plan);
    }
  };

  return (nodeId) => {
    const position = positions.get(nodeId);
    if (position === undefined) {
      return Promise.reject(new Error("The archive entry is not encrypted."));
    }
    while (requested <= position) requestBatch();
    if (requested < nodeIds.length && requested - position <= refill) {
      requestBatch();
    }
    const plan = plans.get(nodeId);
    plans.delete(nodeId);
    return (
      plan ??
      Promise.reject(new Error("The archive entry plan was already taken."))
    );
  };
}
