import { describe, expect, it } from "vitest";

import {
  BoundedBatchPipeline,
  BoundedRollingPipeline,
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

describe("bounded rolling pipeline", () => {
  it("starts its first input and refills a free slot while the first input is slow", async () => {
    const operation = new AbortController();
    const releases = new Map<number, () => void>();
    const started: number[] = [];
    const pipeline = new BoundedRollingPipeline<number, number>(
      4,
      128,
      () => 32,
      async (value) => {
        started.push(value);
        await new Promise<void>((resolve) => releases.set(value, resolve));
        return value;
      },
      operation.signal,
      (error) => operation.abort(error),
    );
    await pipeline.push(1);
    expect(started).toEqual([1]);
    for (const value of [2, 3, 4]) await pipeline.push(value);
    const fifth = pipeline.push(5);
    expect(pipeline.processingBytes).toBe(128);
    releases.get(2)?.();
    await fifth;
    expect(started).toEqual([1, 2, 3, 4, 5]);
    expect(pipeline.processingBytes).toBe(128);
    for (const value of [5, 4, 3, 1]) releases.get(value)?.();
    expect(await pipeline.finish()).toEqual([1, 2, 3, 4, 5]);
    expect(pipeline.processingBytes).toBe(0);
  });

  it("uses byte weights as well as slots and aborts blocked producers on failure", async () => {
    const operation = new AbortController();
    let fail: ((error: Error) => void) | undefined;
    const pipeline = new BoundedRollingPipeline<number, number>(
      4,
      100,
      (value) => value,
      async () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
      operation.signal,
      (error) => operation.abort(error),
    );
    await pipeline.push(60);
    const pending = pipeline.push(50);
    const rejected = expect(pending).rejects.toThrow("failed part");
    fail?.(new Error("failed part"));
    await rejected;
    await expect(pipeline.finish()).rejects.toThrow("failed part");
    await pipeline.stop();
    expect(pipeline.processingBytes).toBe(0);
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
