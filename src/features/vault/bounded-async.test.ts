import { describe, expect, it } from "vitest";

import {
  concurrencyForHardware,
  mapWithConcurrency,
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
