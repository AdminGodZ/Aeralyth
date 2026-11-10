import { describe, expect, it } from "vitest";

import { createFolderZipSink } from "@/features/dashboard/folder-zip-sink";

function bytes(length: number, value: number) {
  return new Uint8Array(length).fill(value);
}

describe("folder ZIP sink", () => {
  it("parks small and large writes in order and reports their ranges", async () => {
    let queued = 0;
    let written = 0;
    const sink = createFolderZipSink({
      onQueued: (count) => {
        queued += count;
      },
      onWritten: (count) => {
        written += count;
      },
      onError: (error) => {
        throw error;
      },
    });
    const sizes = [10, 0, 100_000, 5, 8_192, 8_193, 70_000, 1, 60_000, 7_000];
    const ranges = sizes.map((size, index) =>
      sink.write(bytes(size, index + 1)),
    );
    const blob = await sink.close();

    expect(blob.size).toBe(sizes.reduce((sum, size) => sum + size, 0));
    expect(queued).toBe(blob.size);
    expect(written).toBe(blob.size);
    let offset = 0;
    for (const [index, range] of ranges.entries()) {
      expect(range).toEqual({ start: offset, end: offset + sizes[index] });
      offset = range.end;
      const slice = new Uint8Array(
        await blob.slice(range.start, range.end).arrayBuffer(),
      );
      expect(slice.every((byte) => byte === index + 1)).toBe(true);
    }
  });

  it("copies small writes, so the caller may reuse its buffer", async () => {
    const sink = createFolderZipSink({
      onQueued() {},
      onWritten() {},
      onError() {},
    });
    const scratch = bytes(16, 1);
    sink.write(scratch);
    scratch.fill(2);
    sink.write(scratch);
    const blob = await sink.close();
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      Uint8Array.of(...bytes(16, 1), ...bytes(16, 2)),
    );
  });

  it("holds queued bytes until the stream has taken them", async () => {
    let held = 0;
    const sink = createFolderZipSink({
      onQueued: (count) => {
        held += count;
      },
      onWritten: (count) => {
        held -= count;
      },
      onError() {},
    });
    sink.write(bytes(50_000, 1));
    sink.write(bytes(50_000, 2));
    expect(held).toBe(100_000);
    await sink.close();
    expect(held).toBe(0);
  });

  it("stops accepting data once aborted", async () => {
    const errors: unknown[] = [];
    const sink = createFolderZipSink({
      onQueued() {},
      onWritten() {},
      onError: (error) => errors.push(error),
    });
    sink.write(bytes(20_000, 1));
    sink.abort(new Error("stop"));
    sink.write(bytes(20_000, 2));
    await expect(sink.close()).rejects.toThrow();
    expect(errors.length).toBeGreaterThan(0);
  });
});
