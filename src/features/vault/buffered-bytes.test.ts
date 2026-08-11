import { describe, expect, it } from "vitest";

import {
  ExactStreamReader,
  FixedSizeBufferAssembler,
} from "@/features/vault/buffered-bytes";

describe("fixed-size byte buffering", () => {
  it("allocates once for a part instead of once per appended chunk", () => {
    let allocations = 0;
    const assembler = new FixedSizeBufferAssembler(32, (length) => {
      allocations += 1;
      return new Uint8Array(length);
    });
    const completed: Uint8Array[] = [];

    for (let index = 0; index < 8; index += 1) {
      const chunk = new Uint8Array(4).fill(index + 1);
      completed.push(...assembler.append(chunk));
      expect(chunk).toEqual(new Uint8Array(4));
    }

    expect(allocations).toBe(1);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toEqual(
      Uint8Array.from({ length: 32 }, (_, index) => Math.floor(index / 4) + 1),
    );
    expect(assembler.finish()).toBeNull();
  });

  it("splits boundaries and returns the final short range without copying", () => {
    let allocations = 0;
    const assembler = new FixedSizeBufferAssembler(8, (length) => {
      allocations += 1;
      return new Uint8Array(length);
    });
    const source = Uint8Array.from({ length: 12 }, (_, index) => index + 1);
    const completed = assembler.append(source);
    const final = assembler.finish();

    expect(allocations).toBe(2);
    expect(completed).toEqual([Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])]);
    expect(final).toEqual(Uint8Array.from([9, 10, 11, 12]));
    expect(final?.buffer.byteLength).toBe(8);
    expect(source).toEqual(new Uint8Array(12));
  });
});

describe("exact stream reads", () => {
  it("fills exact owned chunks across fragmented stream boundaries", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(new Uint8Array());
        controller.enqueue(Uint8Array.from([3, 4, 5]));
        controller.enqueue(Uint8Array.from([6, 7]));
        controller.close();
      },
    });
    const reader = new ExactStreamReader(stream.getReader());

    const first = await reader.readExactly(4);
    const second = await reader.readExactly(3);

    expect(first).toEqual(Uint8Array.from([1, 2, 3, 4]));
    expect(first?.byteOffset).toBe(0);
    expect(first?.byteLength).toBe(first?.buffer.byteLength);
    expect(second).toEqual(Uint8Array.from([5, 6, 7]));
    expect(await reader.isAtEnd()).toBe(true);
    await reader.cancel();
  });

  it("returns null and wipes a partial output when the stream ends early", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.close();
      },
    });
    const reader = new ExactStreamReader(stream.getReader());

    expect(await reader.readExactly(3)).toBeNull();
    await reader.cancel();
  });
});
