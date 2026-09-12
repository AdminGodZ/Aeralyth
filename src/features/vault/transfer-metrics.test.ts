import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTransferMetrics,
  recentTransferMetrics,
  subscribeTransferMetrics,
} from "@/features/vault/transfer-metrics";

afterEach(() => vi.restoreAllMocks());

describe("transfer diagnostics", () => {
  it("records overlapping stage time, real bytes, and failures without content", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const metrics = createTransferMetrics();
    metrics.addBytes(64, 48);
    await metrics.measure("network", async () => {
      now = 10;
    });
    await expect(
      metrics.measure("decrypt", async () => {
        now = 15;
        throw new Error("invalid ciphertext");
      }),
    ).rejects.toThrow("invalid ciphertext");
    now = 20;
    expect(metrics.finish("failed")).toEqual({
      outcome: "failed",
      durationMs: 20,
      ciphertextBytes: 64,
      plaintextBytes: 48,
      stages: {
        network: { durationMs: 10, operations: 1 },
        decrypt: { durationMs: 5, operations: 1 },
        sink: { durationMs: 0, operations: 0 },
      },
    });
  });

  it("bounds history, publishes once and isolates diagnostic consumers", () => {
    const listener = vi.fn(() => {
      throw new Error("consumer failure");
    });
    const unsubscribe = subscribeTransferMetrics(listener);
    for (let index = 1; index <= 35; index += 1) {
      const metrics = createTransferMetrics();
      metrics.addBytes(index);
      const result = metrics.finish("completed");
      result.stages.network.operations = 999;
      metrics.addBytes(999);
      metrics.finish("failed");
    }
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(35);
    const history = recentTransferMetrics();
    expect(history).toHaveLength(32);
    expect(history[0].ciphertextBytes).toBe(4);
    expect(history.at(-1)?.ciphertextBytes).toBe(35);
    expect(history.every((sample) => sample.outcome === "completed")).toBe(
      true,
    );
    expect(history[0].stages.network.operations).toBe(0);
    history[0].stages.network.operations = 123;
    expect(recentTransferMetrics()[0].stages.network.operations).toBe(0);
  });
});
