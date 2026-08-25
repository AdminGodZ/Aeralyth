import { describe, expect, it, vi } from "vitest";

import {
  createAnimationFrameProgressCoalescer,
  createIntervalProgressCoalescer,
} from "@/features/uploads/progress-coalescer";

describe("progress coalescing", () => {
  it("turns ten thousand transfer events into one latest frame snapshot", () => {
    const emitted: number[] = [];
    const frames: FrameRequestCallback[] = [];
    const coalescer = createAnimationFrameProgressCoalescer(
      (value: number) => emitted.push(value),
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
      vi.fn(),
    );

    for (let value = 1; value <= 10_000; value += 1) {
      coalescer.publish(value);
    }
    expect(frames).toHaveLength(1);
    frames[0](16);
    expect(emitted).toEqual([10_000]);
  });

  it("publishes start and final states immediately and cancels stale frames", () => {
    const emitted: number[] = [];
    const cancel = vi.fn();
    const coalescer = createAnimationFrameProgressCoalescer(
      (value: number) => emitted.push(value),
      () => 7,
      cancel,
    );

    coalescer.publish(0, true);
    coalescer.publish(50);
    coalescer.publish(100, true);

    expect(cancel).toHaveBeenCalledWith(7);
    expect(emitted).toEqual([0, 100]);
  });

  it("limits worker progress while retaining the latest forced result", () => {
    let timestamp = 0;
    const emitted: number[] = [];
    const coalescer = createIntervalProgressCoalescer(
      (value: number) => emitted.push(value),
      100,
      () => timestamp,
    );

    coalescer.publish(0, true);
    for (let value = 1; value <= 10_000; value += 1) {
      timestamp = value / 100;
      coalescer.publish(value);
    }
    coalescer.publish(10_000, true);

    expect(emitted.length).toBeLessThanOrEqual(102);
    expect(emitted.at(0)).toBe(0);
    expect(emitted.at(-1)).toBe(10_000);
  });
});
