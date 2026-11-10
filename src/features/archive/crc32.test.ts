import { crc32 as referenceCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";

import { crc32, crc32Combine } from "@/features/archive/crc32";

function patterned(length: number, seed: number) {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

describe("CRC-32", () => {
  it("matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it.each([1, 7, 8, 9, 63, 4096, 100_003])(
    "matches zlib for %i bytes at any alignment",
    (length) => {
      const bytes = patterned(length + 3, length);
      for (const offset of [0, 1, 3]) {
        const view = bytes.subarray(offset, offset + length);
        expect(crc32(view)).toBe(referenceCrc32(view));
      }
    },
  );

  it("continues a running checksum from a seed", () => {
    const bytes = patterned(70_000, 7);
    const head = crc32(bytes.subarray(0, 12_345));
    expect(crc32(bytes.subarray(12_345), head)).toBe(referenceCrc32(bytes));
  });

  it("combines the checksums of adjacent ranges", () => {
    const bytes = patterned(300_000, 11);
    for (const split of [0, 1, 65_535, 150_000, 299_999, 300_000]) {
      expect(
        crc32Combine(
          crc32(bytes.subarray(0, split)),
          crc32(bytes.subarray(split)),
          bytes.length - split,
        ),
      ).toBe(referenceCrc32(bytes));
    }
    const ranges = [0, 40_000, 40_001, 170_000, 300_000];
    let combined = 0;
    for (let index = 1; index < ranges.length; index++) {
      const range = bytes.subarray(ranges[index - 1], ranges[index]);
      combined = crc32Combine(combined, crc32(range), range.length);
    }
    expect(combined).toBe(referenceCrc32(bytes));
  });

  it("rejects an invalid range length", () => {
    expect(() => crc32Combine(1, 2, -1)).toThrow(RangeError);
    expect(() => crc32Combine(1, 2, 1.5)).toThrow(RangeError);
  });
});
