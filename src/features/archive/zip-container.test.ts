import { deflateRawSync } from "node:zlib";
import {
  BlobReader,
  Reader,
  Uint8ArrayWriter,
  ZipReader,
} from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { crc32 } from "@/features/archive/crc32";
import {
  encodeCentralDirectory,
  encodeLocalFileHeader,
  encodeZipEntryName,
  localFileHeaderSize,
  needsZip64Sizes,
  writeLocalFileHeader,
  ZIP_METHOD_DEFLATE,
  ZIP_METHOD_STORE,
  type ZipCentralEntry,
  type ZipEntryHeader,
} from "@/features/archive/zip-container";

const GIBIBYTE = 1024 ** 3;

function fileEntry(
  path: string,
  content: Uint8Array,
  options: { deflate?: boolean; lastModified?: number } = {},
) {
  const data = options.deflate
    ? new Uint8Array(deflateRawSync(content, { level: 1 }))
    : content;
  const header: ZipEntryHeader = {
    name: encodeZipEntryName(path),
    directory: false,
    method: options.deflate ? ZIP_METHOD_DEFLATE : ZIP_METHOD_STORE,
    level: options.deflate ? 1 : 0,
    crc32: crc32(content),
    compressedSize: data.length,
    uncompressedSize: content.length,
    lastModified: options.lastModified ?? Date.UTC(2026, 5, 15, 12, 30, 44),
  };
  return { header, data };
}

function archiveOf(
  entries: Array<{ header: ZipEntryHeader; data: Uint8Array }>,
) {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const central: ZipCentralEntry[] = [];
  let offset = 0;
  for (const { header, data } of entries) {
    const local = encodeLocalFileHeader(header);
    parts.push(local, new Uint8Array(data));
    central.push({ ...header, offset });
    offset += local.length + data.length;
  }
  parts.push(encodeCentralDirectory(central, offset));
  return new Blob(parts);
}

/** Serves a few byte ranges of an otherwise all-zero archive. */
class SparseReader extends Reader<void> {
  constructor(
    size: number,
    private readonly segments: Array<[offset: number, bytes: Uint8Array]>,
  ) {
    super();
    this.size = size;
  }

  override async readUint8Array(index: number, length: number) {
    const output = new Uint8Array(length);
    for (const [offset, bytes] of this.segments) {
      const start = Math.max(index, offset);
      const end = Math.min(index + length, offset + bytes.length);
      if (start < end) {
        output.set(bytes.subarray(start - offset, end - offset), start - index);
      }
    }
    return output;
  }
}

async function readAll(archive: Blob) {
  const reader = new ZipReader(new BlobReader(archive), {
    useWebWorkers: false,
  });
  try {
    return await Promise.all(
      (await reader.getEntries()).map(async (entry) => ({
        entry,
        data: entry.directory
          ? null
          : await entry.getData(new Uint8ArrayWriter(), {
              checkSignature: true,
            }),
      })),
    );
  } finally {
    await reader.close();
  }
}

describe("ZIP container", () => {
  it("writes stored, deflated, empty, Unicode and directory entries a reader accepts", async () => {
    const text = new TextEncoder().encode("archive me ".repeat(2000));
    const lastModified = Date.UTC(2024, 0, 2, 12, 0, 1);
    const entries = [
      {
        header: {
          name: encodeZipEntryName("folder/"),
          directory: true,
          method: ZIP_METHOD_STORE,
          level: 0,
          crc32: 0,
          compressedSize: 0,
          uncompressedSize: 0,
          lastModified,
        } satisfies ZipEntryHeader,
        data: new Uint8Array(0),
      },
      fileEntry("folder/text.txt", text, { deflate: true, lastModified }),
      fileEntry("folder/raw.bin", Uint8Array.of(1, 2, 3, 250)),
      fileEntry("folder/empty", new Uint8Array(0)),
      fileEntry("folder/Grüße/日本語 🚀.txt", text.subarray(0, 100)),
    ];
    const read = await readAll(archiveOf(entries));

    expect(read.map(({ entry }) => entry.filename)).toEqual([
      "folder/",
      "folder/text.txt",
      "folder/raw.bin",
      "folder/empty",
      "folder/Grüße/日本語 🚀.txt",
    ]);
    expect(read[0].entry.directory).toBe(true);
    expect(read[1].data).toEqual(text);
    expect(read[1].entry.compressionMethod).toBe(ZIP_METHOD_DEFLATE);
    // The extended timestamp keeps the odd second that MS-DOS time drops.
    expect(read[1].entry.lastModDate.getTime()).toBe(lastModified);
    expect(read[2].data).toEqual(Uint8Array.of(1, 2, 3, 250));
    expect(read[3].data).toEqual(new Uint8Array(0));
    expect(read[4].data).toEqual(text.subarray(0, 100));
    for (const { entry } of read) {
      expect(entry.bitFlag?.dataDescriptor).toBe(false);
      expect(entry.zip64).toBe(false);
    }
    // Only names that need it carry the UTF-8 flag.
    expect(read[1].entry.bitFlag?.languageEncodingFlag).toBe(false);
    expect(read[4].entry.bitFlag?.languageEncodingFlag).toBe(true);
  });

  it("sizes local headers exactly and writes them in place", () => {
    const { header } = fileEntry("a/b.txt", Uint8Array.of(1, 2, 3));
    const encoded = encodeLocalFileHeader(header);
    expect(encoded.length).toBe(
      localFileHeaderSize(header.name.length, header.lastModified),
    );
    const target = new Uint8Array(encoded.length + 10).fill(0xee);
    expect(writeLocalFileHeader(target.subarray(4), 3, header)).toBe(
      encoded.length,
    );
    expect(target.subarray(7, 7 + encoded.length)).toEqual(encoded);
    expect(target.subarray(0, 7)).toEqual(new Uint8Array(7).fill(0xee));
    expect(target.subarray(7 + encoded.length)).toEqual(
      new Uint8Array(3).fill(0xee),
    );
  });

  it("clamps timestamps outside the MS-DOS range and omits the Unix field when it cannot hold them", () => {
    const view = (lastModified: number) => {
      const header = encodeLocalFileHeader({
        ...fileEntry("t", new Uint8Array(0)).header,
        lastModified,
      });
      return new DataView(header.buffer);
    };
    const early = view(Date.UTC(1970, 0, 1, 12));
    expect(early.getUint16(10, true)).toBe(0);
    expect(early.getUint16(12, true)).toBe(0x21);
    expect(early.getUint16(28, true)).toBe(9);
    const beforeEpoch = view(-86_400_000);
    expect(beforeEpoch.getUint16(28, true)).toBe(0);
    const invalid = view(Number.NaN);
    expect(invalid.getUint16(12, true)).toBe(0x21);
    expect(invalid.getUint16(28, true)).toBe(0);
    const late = view(Date.UTC(2200, 0, 1));
    expect(late.getUint16(12, true) >>> 9).toBe(127);
    expect(late.getUint16(28, true)).toBe(0);
  });

  it("rejects entry paths that do not fit the name length field", () => {
    expect(() => encodeZipEntryName("a".repeat(65_536))).toThrow(
      "longer than 65,535 bytes",
    );
    expect(encodeZipEntryName("a".repeat(65_535)).length).toBe(65_535);
  });

  it("switches to ZIP64 records beyond 65,534 entries", async () => {
    const entries = Array.from({ length: 66_000 }, (_, index) =>
      fileEntry(`e/${index}`, new Uint8Array(0)),
    );
    const reader = new ZipReader(new BlobReader(archiveOf(entries)), {
      useWebWorkers: false,
    });
    try {
      const read = await reader.getEntries();
      expect(read.length).toBe(66_000);
      expect(read[65_999].filename).toBe("e/65999");
    } finally {
      await reader.close();
    }
  });

  it("writes ZIP64 sizes and offsets a reader resolves", async () => {
    const large: ZipEntryHeader = {
      name: encodeZipEntryName("large.bin"),
      directory: false,
      method: ZIP_METHOD_STORE,
      level: 0,
      crc32: 0x12345678,
      compressedSize: 5 * GIBIBYTE,
      uncompressedSize: 5 * GIBIBYTE,
      lastModified: Date.UTC(2026, 0, 1),
    };
    const medium = { ...large, name: encodeZipEntryName("medium.bin") };
    medium.compressedSize = medium.uncompressedSize = 4 * GIBIBYTE - 64;
    const small = fileEntry("after/small.txt", Uint8Array.of(9, 8, 7));
    expect(needsZip64Sizes(large)).toBe(true);
    expect(needsZip64Sizes(medium)).toBe(false);

    const largeHeader = encodeLocalFileHeader(large);
    const mediumHeader = encodeLocalFileHeader(medium);
    const smallHeader = encodeLocalFileHeader(small.header);
    expect(largeHeader.length).toBe(
      localFileHeaderSize(large.name.length, large.lastModified, true),
    );
    const mediumOffset = largeHeader.length + large.compressedSize;
    const smallOffset =
      mediumOffset + mediumHeader.length + medium.compressedSize;
    const directoryOffset =
      smallOffset + smallHeader.length + small.data.length;
    const directory = encodeCentralDirectory(
      [
        { ...large, offset: 0 },
        { ...medium, offset: mediumOffset },
        { ...small.header, offset: smallOffset },
      ],
      directoryOffset,
    );

    // A 9 GiB archive that only materializes its headers; the entry data
    // reads as zeros.
    const reader = new ZipReader(
      new SparseReader(directoryOffset + directory.length, [
        [0, largeHeader],
        [mediumOffset, mediumHeader],
        [smallOffset, smallHeader],
        [smallOffset + smallHeader.length, small.data],
        [directoryOffset, directory],
      ]),
      { useWebWorkers: false },
    );
    try {
      const [first, second, third] = await reader.getEntries();
      expect(first.uncompressedSize).toBe(5 * GIBIBYTE);
      expect(first.compressedSize).toBe(5 * GIBIBYTE);
      expect(first.zip64).toBe(true);
      expect(first.offset).toBe(0);
      expect(second.uncompressedSize).toBe(4 * GIBIBYTE - 64);
      expect(second.offset).toBe(mediumOffset);
      expect(third.offset).toBe(smallOffset);
      expect(third.offset).toBeGreaterThan(2 ** 32);
      if (third.directory) throw new Error("Expected a file entry.");
      // Reading through the local header checks the ZIP64 offset end to end.
      expect(
        await third.getData(new Uint8ArrayWriter(), { checkSignature: true }),
      ).toEqual(Uint8Array.of(9, 8, 7));
    } finally {
      await reader.close();
    }
  });
});
