import { describe, expect, it, vi } from "vitest";

import { BatchScopedValueCache } from "@/features/vault/batch-scoped-value-cache";

describe("batch-scoped value cache", () => {
  it("deduplicates concurrent immutable loads with the same fingerprint", async () => {
    const cache = new BatchScopedValueCache<string>();
    const load = vi.fn(async () => "context-key");

    const first = cache.getOrLoad("upload:parent", "epoch-1:hash-a", load);
    const second = cache.getOrLoad("upload:parent", "epoch-1:hash-a", load);

    await expect(Promise.all([first, second])).resolves.toEqual([
      "context-key",
      "context-key",
    ]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("reloads changed, invalidated, and failed values", async () => {
    const cache = new BatchScopedValueCache<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("epoch-1")
      .mockResolvedValueOnce("epoch-2")
      .mockRejectedValueOnce(new Error("fenced"))
      .mockResolvedValueOnce("recovered");

    await expect(cache.getOrLoad("batch", "one", load)).resolves.toBe(
      "epoch-1",
    );
    await expect(cache.getOrLoad("batch", "two", load)).resolves.toBe(
      "epoch-2",
    );
    cache.delete("batch");
    await expect(cache.getOrLoad("batch", "three", load)).rejects.toThrow(
      "fenced",
    );
    await expect(cache.getOrLoad("batch", "three", load)).resolves.toBe(
      "recovered",
    );
    expect(load).toHaveBeenCalledTimes(4);
  });
});
