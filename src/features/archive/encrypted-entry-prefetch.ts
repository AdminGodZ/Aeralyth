import type {
  VaultDownloadPlan,
  VaultManifest,
} from "@/features/vault/protocol";

export type OpenedEncryptedEntry = {
  manifest: VaultManifest;
  plan: VaultDownloadPlan;
};

type PrefetchEntry = { id: string; e2eeState: string };

/**
 * Keeps the next few encrypted archive entries ready while the ZIP writer
 * consumes the current one. Download plans are independent requests, so up to
 * `lookahead` of them run concurrently. Opening a node can need its parent's
 * keys, so opens stay chained in the given parent-first order and only overlap
 * with archive output, never with each other. Plans carry short-lived download
 * URLs, which is why the window stays small instead of covering the archive.
 */
export function prefetchEncryptedEntries<T extends PrefetchEntry>(
  entries: readonly T[],
  {
    getPlan,
    openNode,
    lookahead = 6,
    signal,
  }: {
    getPlan(nodeId: string, signal?: AbortSignal): Promise<VaultDownloadPlan>;
    openNode(
      nodeId: string,
      plan: VaultDownloadPlan,
      signal?: AbortSignal,
    ): Promise<VaultManifest>;
    lookahead?: number;
    signal?: AbortSignal;
  },
): (index: number) => Promise<OpenedEncryptedEntry> | undefined {
  const opened = new Map<number, Promise<OpenedEncryptedEntry>>();
  let openChain: Promise<unknown> = Promise.resolve();
  let scheduled = 0;

  const schedule = (end: number) => {
    for (; scheduled < Math.min(end, entries.length); scheduled += 1) {
      const entry = entries[scheduled];
      if (entry.e2eeState !== "encrypted") continue;
      const plan = getPlan(entry.id, signal);
      const result = openChain.then(async () => ({
        manifest: await openNode(entry.id, await plan, signal),
        plan: await plan,
      }));
      openChain = result;
      // Failures surface when the entry is consumed; a prefetched entry that
      // is never reached (cancellation, an earlier failure) must not report
      // an unhandled rejection.
      plan.catch(() => undefined);
      result.catch(() => undefined);
      opened.set(scheduled, result);
    }
  };

  return (index) => {
    schedule(index + 1 + lookahead);
    const result = opened.get(index);
    opened.delete(index);
    return result;
  };
}
