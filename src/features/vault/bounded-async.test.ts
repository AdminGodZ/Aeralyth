import { describe, expect, it } from "vitest";

import {
  BoundedBatchPipeline,
  concurrencyForHardware,
  mapWithConcurrency,
  WeightedSemaphore,
} from "@/features/vault/bounded-async";

describe("bounded async work", () => {
  it("preserves result order while enforcing the in-flight limit", async () => {
    let active = 0;
    let peak = 0;
    const values = Array.from({ length: 40 }, (_, index) => index);
    const results = await mapWithConcurrency(values, 4, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return value * 2;
    });

    expect(peak).toBe(4);
    expect(results).toEqual(values.map((value) => value * 2));
  });

  it("stops scheduling new work after a failure", async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency(
        Array.from({ length: 100 }, (_, index) => index),
        4,
        async (value) => {
          started.push(value);
          if (value === 2) throw new Error("expected failure");
          await new Promise((resolve) => setTimeout(resolve, 1));
          return value;
        },
      ),
    ).rejects.toThrow("expected failure");

    expect(started.length).toBeLessThanOrEqual(4);
  });

  it("scales to hardware without exceeding configured caps", () => {
    expect(concurrencyForHardware(undefined, 16)).toBe(4);
    expect(concurrencyForHardware(1, 16)).toBe(1);
    expect(concurrencyForHardware(12, 16)).toBe(12);
    expect(concurrencyForHardware(64, 16)).toBe(16);
    expect(concurrencyForHardware(12, 8, 2)).toBe(6);
    expect(concurrencyForHardware(64, 8, 2)).toBe(8);
  });
});

describe("weighted semaphore", () => {
  it("allows small work to overlap while large work remains exclusive", async () => {
    const semaphore = new WeightedSemaphore(3);
    let activeWeight = 0;
    let peakWeight = 0;
    const activeDuringLarge: number[] = [];

    await mapWithConcurrency([1, 1, 1, 3, 1, 1], 3, async (weight) => {
      const release = await semaphore.acquire(weight);
      activeWeight += weight;
      peakWeight = Math.max(peakWeight, activeWeight);
      if (weight === 3) activeDuringLarge.push(activeWeight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeWeight -= weight;
      release();
    });

    expect(peakWeight).toBe(3);
    expect(activeDuringLarge).toEqual([3]);
  });

  it("removes an aborted waiter without consuming capacity", async () => {
    const semaphore = new WeightedSemaphore(1);
    const release = await semaphore.acquire();
    const controller = new AbortController();
    const waiting = semaphore.acquire(1, controller.signal);
    controller.abort(new Error("cancelled"));

    await expect(waiting).rejects.toThrow("cancelled");
    release();
    const nextRelease = await semaphore.acquire();
    nextRelease();
  });
});

describe("bounded batch pipeline", () => {
  it("overlaps one batch with one look-ahead item and preserves order", async () => {
    let releaseFirstBatch: (() => void) | undefined;
    let activeBatches = 0;
    let peakBatches = 0;
    const batches: number[][] = [];
    const pipeline = new BoundedBatchPipeline<number, number>(
      4,
      1,
      async (batch) => {
        batches.push(batch);
        activeBatches += 1;
        peakBatches = Math.max(peakBatches, activeBatches);
        if (batches.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstBatch = resolve;
          });
        }
        activeBatches -= 1;
        return batch.map((value) => value * 2);
      },
    );

    await Promise.all([0, 1, 2, 3].map((value) => pipeline.push(value)));
    expect(pipeline.processing).toBe(true);
    const lookahead = pipeline.push(4);
    await Promise.resolve();
    expect(pipeline.bufferedInputs).toBe(1);
    releaseFirstBatch?.();
    await lookahead;
    await Promise.all([5, 6, 7].map((value) => pipeline.push(value)));

    expect(await pipeline.finish()).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    expect(batches).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ]);
    expect(peakBatches).toBe(1);
  });

  it("surfaces processing failures without leaving buffered input", async () => {
    const pipeline = new BoundedBatchPipeline<number, number>(
      2,
      1,
      async () => {
        throw new Error("upload failed");
      },
    );

    await pipeline.push(1);
    await pipeline.push(2);
    await expect(pipeline.push(3)).rejects.toThrow("upload failed");
    expect(await pipeline.stop()).toEqual([]);
  });
});
