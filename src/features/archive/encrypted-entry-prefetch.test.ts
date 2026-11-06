import { describe, expect, it, vi } from "vitest";

import { prefetchEncryptedEntries } from "@/features/archive/encrypted-entry-prefetch";
import type {
  VaultDownloadPlan,
  VaultManifest,
} from "@/features/vault/protocol";

const entries = [
  { id: "folder", e2eeState: "encrypted" },
  { id: "legacy", e2eeState: "legacy" },
  { id: "a", e2eeState: "encrypted" },
  { id: "b", e2eeState: "encrypted" },
  { id: "c", e2eeState: "encrypted" },
];

function plan(nodeId: string): VaultDownloadPlan {
  return { nodeId } as unknown as VaultDownloadPlan;
}

function manifest(nodeId: string): VaultManifest {
  return { name: nodeId } as unknown as VaultManifest;
}

describe("prefetchEncryptedEntries", () => {
  it("fetches plans ahead concurrently but opens nodes in order", async () => {
    const planRequests: string[] = [];
    const opens: string[] = [];
    let activeOpens = 0;
    let peakOpens = 0;
    const getPlan = vi.fn(async (nodeId: string) => {
      planRequests.push(nodeId);
      return plan(nodeId);
    });
    const openNode = vi.fn(async (nodeId: string) => {
      activeOpens += 1;
      peakOpens = Math.max(peakOpens, activeOpens);
      await new Promise((resolve) => setTimeout(resolve, 1));
      opens.push(nodeId);
      activeOpens -= 1;
      return manifest(nodeId);
    });

    const open = prefetchEncryptedEntries(entries, {
      getPlan,
      openNode,
      lookahead: 2,
    });

    const first = open(0);
    // The window covers the current entry plus two ahead; legacy entries
    // take no plan.
    expect(planRequests).toEqual(["folder", "a"]);
    expect(open(1)).toBeUndefined();
    await expect(first).resolves.toEqual({
      manifest: manifest("folder"),
      plan: plan("folder"),
    });
    expect(planRequests).toEqual(["folder", "a", "b"]);

    for (const index of [2, 3, 4]) {
      await open(index);
    }

    expect(opens).toEqual(["folder", "a", "b", "c"]);
    expect(peakOpens).toBe(1);
    expect(getPlan).toHaveBeenCalledTimes(4);
  });

  it("does not report unhandled rejections for entries never consumed", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const open = prefetchEncryptedEntries(entries, {
        getPlan: async () => {
          throw new Error("plan failed");
        },
        openNode: async (nodeId) => manifest(nodeId),
        lookahead: 4,
      });

      await expect(open(0)).rejects.toThrow("plan failed");
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
