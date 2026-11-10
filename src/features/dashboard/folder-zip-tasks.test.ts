import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { crc32 } from "@/features/archive/crc32";
import {
  instantiateRawDeflater,
  storedDeflateSize,
} from "@/features/archive/raw-deflate";
import {
  FOLDER_ZIP_BATCH_META_FIELDS,
  FOLDER_ZIP_BATCH_REFERENCE,
  type FolderZipBatchEntry,
  type FolderZipTaskContext,
  type FolderZipTaskResult,
  runFolderZipTask,
} from "@/features/dashboard/folder-zip-tasks";

const lastModified = Date.UTC(2026, 5, 15, 12, 30, 44);

async function context(
  overrides: Partial<FolderZipTaskContext> = {},
): Promise<FolderZipTaskContext> {
  return {
    deflater: await instantiateRawDeflater(
      await readFile(
        fileURLToPath(
          import.meta.resolve("@zip.js/zip.js/dist/zip-module.wasm"),
        ),
      ),
    ),
    nativeDeflate: false,
    emitPart() {
      throw new Error("Unexpected stream part.");
    },
    ...overrides,
  };
}

function text(length: number) {
  return new TextEncoder()
    .encode("folder zip ".repeat(length / 11 + 1))
    .subarray(0, length);
}

function random(length: number, seed: number) {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function entry(
  path: string,
  content: Uint8Array | null,
  level = 1,
): FolderZipBatchEntry {
  return {
    path,
    directory: content === null,
    file: content === null ? null : new Blob([new Uint8Array(content)]),
    size: content?.length ?? 0,
    lastModified,
    level,
  };
}

function batchMeta(result: FolderZipTaskResult, index: number) {
  if (result.kind !== "batch") throw new Error("Expected a batch result.");
  const [checksum, compressedSize, flags, headerOffset, headerSize] =
    result.meta.subarray(
      index * FOLDER_ZIP_BATCH_META_FIELDS,
      (index + 1) * FOLDER_ZIP_BATCH_META_FIELDS,
    );
  return {
    checksum,
    compressedSize,
    method: flags & 0xff,
    reference: (flags & FOLDER_ZIP_BATCH_REFERENCE) !== 0,
    headerOffset,
    headerSize,
    data: new Uint8Array(result.segment).subarray(
      headerOffset + headerSize,
      headerOffset + headerSize + compressedSize,
    ),
  };
}

describe("folder ZIP batch task", () => {
  it("frames each entry with a complete local header", async () => {
    const readme = text(5_000);
    const icon = random(3_000, 1);
    const { result, transfer } = await runFolderZipTask(
      {
        kind: "batch",
        id: 7,
        referenceBytes: 1024 * 1024,
        entries: [
          entry("dir/", null, 0),
          entry("dir/readme.md", readme),
          entry("dir/empty", new Uint8Array(0)),
          entry("dir/icon.png", icon, 0),
          entry("dir/noise.bin", icon),
        ],
      },
      await context(),
    );
    if (result.kind !== "batch") throw new Error("Expected a batch result.");
    expect(result.id).toBe(7);
    expect(transfer).toContain(result.segment);

    const directory = batchMeta(result, 0);
    expect(directory).toMatchObject({ headerOffset: 0, compressedSize: 0 });
    const deflated = batchMeta(result, 1);
    expect(deflated.method).toBe(8);
    expect(deflated.checksum).toBe(crc32(readme));
    expect(inflateRawSync(deflated.data).equals(readme)).toBe(true);
    expect(batchMeta(result, 2)).toMatchObject({ method: 0, checksum: 0 });
    const stored = batchMeta(result, 3);
    expect(stored.method).toBe(0);
    expect(stored.data).toEqual(icon);
    // Data that deflate cannot shrink is stored as it is.
    const fallback = batchMeta(result, 4);
    expect(fallback.method).toBe(0);
    expect(fallback.data).toEqual(icon);

    // Headers and data are contiguous and in entry order.
    const view = new DataView(result.segment);
    let offset = 0;
    for (let index = 0; index < 5; index++) {
      const meta = batchMeta(result, index);
      expect(meta.headerOffset).toBe(offset);
      expect(view.getUint32(offset, true)).toBe(0x04034b50);
      expect(view.getUint32(offset + 14, true)).toBe(meta.checksum);
      expect(view.getUint32(offset + 18, true)).toBe(meta.compressedSize);
      offset += meta.headerSize + meta.compressedSize;
    }
    expect(result.segment.byteLength).toBe(offset);
  });

  it("leaves large stored entries out of the segment", async () => {
    const photo = random(300_000, 2);
    const noise = random(600_000, 3);
    const note = text(2_000);
    const { result } = await runFolderZipTask(
      {
        kind: "batch",
        id: 0,
        referenceBytes: 200_000,
        entries: [
          entry("photo.jpg", photo, 0),
          entry("note.txt", note),
          // Deflate is tried, sampled as pointless, and the entry is stored.
          entry("noise.bin", noise),
        ],
      },
      await context(),
    );
    const first = batchMeta(result, 0);
    expect(first).toMatchObject({
      method: 0,
      reference: true,
      compressedSize: photo.length,
      checksum: crc32(photo),
    });
    const second = batchMeta(result, 1);
    expect(second.reference).toBe(false);
    // The next header follows the referenced entry's header directly.
    expect(second.headerOffset).toBe(first.headerSize);
    const third = batchMeta(result, 2);
    expect(third).toMatchObject({
      method: 0,
      reference: true,
      checksum: crc32(noise),
    });
    expect(result.kind === "batch" && result.segment.byteLength).toBe(
      third.headerOffset + third.headerSize,
    );
  });

  it("deflates with CompressionStream when zlib is unavailable", async () => {
    const readme = text(50_000);
    const { result } = await runFolderZipTask(
      {
        kind: "batch",
        id: 0,
        referenceBytes: 1024 * 1024,
        entries: [entry("readme.md", readme)],
      },
      await context({ deflater: null, nativeDeflate: true }),
    );
    const meta = batchMeta(result, 0);
    expect(meta.method).toBe(8);
    expect(inflateRawSync(meta.data).equals(readme)).toBe(true);

    const stored = await runFolderZipTask(
      {
        kind: "batch",
        id: 0,
        referenceBytes: 1024 * 1024,
        entries: [entry("readme.md", readme)],
      },
      await context({ deflater: null, nativeDeflate: false }),
    );
    expect(batchMeta(stored.result, 0).method).toBe(0);
  });
});

describe("folder ZIP range task", () => {
  it("only checksums a stored range", async () => {
    const content = random(100_000, 4);
    const { result, transfer } = await runFolderZipTask(
      {
        kind: "range",
        id: 3,
        path: "movie.mp4",
        file: new Blob([content]),
        start: 10_000,
        end: 60_000,
        level: 0,
        final: false,
      },
      await context(),
    );
    expect(result).toEqual({
      kind: "range",
      id: 3,
      crc32: crc32(content.subarray(10_000, 60_000)),
      output: null,
    });
    expect(transfer).toEqual([]);
  });

  it("deflates ranges that concatenate into one stream", async () => {
    const content = text(900_000);
    const file = new Blob([content]);
    const taskContext = await context();
    const outputs: Uint8Array[] = [];
    for (const [start, end] of [
      [0, 400_000],
      [400_000, 800_000],
      [800_000, 900_000],
    ]) {
      const { result } = await runFolderZipTask(
        {
          kind: "range",
          id: 0,
          path: "big.log",
          file,
          start,
          end,
          level: 1,
          final: end === content.length,
        },
        taskContext,
      );
      if (result.kind !== "range" || !result.output) {
        throw new Error("Expected deflate output.");
      }
      expect(result.crc32).toBe(crc32(content.subarray(start, end)));
      outputs.push(new Uint8Array(result.output));
    }
    expect(inflateRawSync(Buffer.concat(outputs)).equals(content)).toBe(true);
  });

  it("wraps a range that does not compress in stored blocks", async () => {
    const content = random(700_000, 5);
    const { result } = await runFolderZipTask(
      {
        kind: "range",
        id: 0,
        path: "noise.dat",
        file: new Blob([content]),
        start: 0,
        end: content.length,
        level: 1,
        final: true,
      },
      await context(),
    );
    if (result.kind !== "range" || !result.output) {
      throw new Error("Expected deflate output.");
    }
    expect(result.output.byteLength).toBe(
      storedDeflateSize(content.length, true),
    );
    expect(inflateRawSync(new Uint8Array(result.output)).equals(content)).toBe(
      true,
    );
  });
});

describe("folder ZIP stream task", () => {
  it("emits the deflate stream in order and returns the checksum", async () => {
    const content = text(3_000_000);
    const parts: Uint8Array[] = [];
    const { result } = await runFolderZipTask(
      { kind: "stream", id: 9, path: "big.log", file: new Blob([content]) },
      await context({
        deflater: null,
        nativeDeflate: true,
        emitPart(id, part) {
          expect(id).toBe(9);
          parts.push(new Uint8Array(part));
        },
      }),
    );
    expect(result).toEqual({ kind: "stream", id: 9, crc32: crc32(content) });
    expect(inflateRawSync(Buffer.concat(parts)).equals(content)).toBe(true);
  });

  it("stops when the run is canceled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runFolderZipTask(
        {
          kind: "stream",
          id: 0,
          path: "big.log",
          file: new Blob([text(100_000)]),
        },
        await context({
          deflater: null,
          nativeDeflate: true,
          emitPart() {},
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
