import { BlobReader, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import {
  BoundedBlobWriter,
  ZIP_ARCHIVE_SAFETY_LIMIT_ERROR,
} from "@/features/dashboard/bounded-blob-writer";

describe("bounded ZIP output", () => {
  it("rejects the chunk that would exceed the limit before retaining it", async () => {
    const writer = new BoundedBlobWriter(4);

    await writer.writeUint8Array(Uint8Array.of(1, 2, 3));
    await expect(writer.writeUint8Array(Uint8Array.of(4, 5))).rejects.toThrow(
      ZIP_ARCHIVE_SAFETY_LIMIT_ERROR,
    );

    const archive = await writer.getData();
    expect(archive.size).toBe(3);
    expect(new Uint8Array(await archive.arrayBuffer())).toEqual(
      Uint8Array.of(1, 2, 3),
    );
  });

  it("integrates with the ZIP writer without falling back to an unbounded Blob", async () => {
    const output = new BoundedBlobWriter(4_096);
    const zip = new ZipWriter(output, { useWebWorkers: false });

    await zip.add("folder/file.txt", new BlobReader(new Blob(["hello"])));
    const archive = await zip.close();

    expect(archive.type).toBe("application/zip");
    expect(archive.size).toBeGreaterThan(5);
    expect(archive.size).toBeLessThanOrEqual(4_096);
  });
});
