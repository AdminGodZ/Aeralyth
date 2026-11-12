import { describe, expect, it, vi } from "vitest";

import { batchArchivePlans } from "@/features/archive/archive-plan-batches";
import type { VaultDownloadPlan } from "@/features/vault/protocol";

function entries(count: number, legacyEvery = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: `node-${index}`,
    e2eeState:
      legacyEvery && index % legacyEvery === 0 ? "legacy" : "encrypted",
  }));
}

const plan = (nodeId: string) => ({ nodeId }) as unknown as VaultDownloadPlan;

describe("batchArchivePlans", () => {
  it("requests encrypted entries' plans in order, a batch ahead of use", async () => {
    const archive = entries(30, 5);
    const encrypted = archive.filter(
      (entry) => entry.e2eeState === "encrypted",
    );
    const getPlans = vi.fn(async (nodeIds: readonly string[]) =>
      nodeIds.map(plan),
    );
    const getPlan = batchArchivePlans(archive, {
      getPlans,
      batchSize: 8,
      refill: 2,
    });

    for (const [position, entry] of encrypted.entries()) {
      await expect(getPlan(entry.id)).resolves.toEqual(plan(entry.id));
      const requested = getPlans.mock.calls.flatMap(([nodeIds]) => nodeIds);
      expect(requested.length).toBeGreaterThan(position);
      expect(requested.length).toBeLessThanOrEqual(position + 2 + 8);
    }
    expect(getPlans.mock.calls.map(([nodeIds]) => nodeIds)).toEqual([
      encrypted.slice(0, 8).map((entry) => entry.id),
      encrypted.slice(8, 16).map((entry) => entry.id),
      encrypted.slice(16, 24).map((entry) => entry.id),
    ]);
  });

  it("fails only the entry the server refused", async () => {
    const archive = entries(3);
    const refused = new Error("not found");
    const getPlan = batchArchivePlans(archive, {
      getPlans: async (nodeIds) =>
        nodeIds.map((nodeId) => (nodeId === "node-1" ? refused : plan(nodeId))),
    });

    const plans = archive.map((entry) => getPlan(entry.id));
    await expect(plans[0]).resolves.toEqual(plan("node-0"));
    await expect(plans[1]).rejects.toBe(refused);
    await expect(plans[2]).resolves.toEqual(plan("node-2"));
  });

  it("fails every entry of a batch whose request failed", async () => {
    const failure = new Error("offline");
    const getPlans = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockImplementation(async (nodeIds: readonly string[]) =>
        nodeIds.map(plan),
      );
    const getPlan = batchArchivePlans(entries(4), {
      getPlans,
      batchSize: 2,
      refill: 0,
    });

    await expect(getPlan("node-0")).rejects.toBe(failure);
    await expect(getPlan("node-1")).rejects.toBe(failure);
    await expect(getPlan("node-2")).resolves.toEqual(plan("node-2"));
  });
});
