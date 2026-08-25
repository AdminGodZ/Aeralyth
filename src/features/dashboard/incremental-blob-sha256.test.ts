import { describe, expect, it } from "vitest";

import {
  BLOB_HASH_CHUNK_BYTES,
  incrementalBlobSha256,
} from "@/features/dashboard/incremental-blob-sha256";

describe("incremental Blob SHA-256", () => {
  it("matches Web Crypto while processing bounded stream chunks", async () => {
    const bytes = new Uint8Array(8 * 1024 * 1024 + 137);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (index * 31 + 17) & 0xff;
    }
    const blob = new Blob([bytes]);
    const chunkSizes: number[] = [];

    const [actual, expected] = await Promise.all([
      incrementalBlobSha256(blob, undefined, (size) => chunkSizes.push(size)),
      crypto.subtle.digest("SHA-256", bytes),
    ]);

    expect(actual).toEqual(new Uint8Array(expected));
    expect(chunkSizes.length).toBeGreaterThan(1);
    expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(BLOB_HASH_CHUNK_BYTES);
    expect(chunkSizes.reduce((sum, size) => sum + size, 0)).toBe(blob.size);
  });

  it("honors cancellation before reading the Blob", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Upload canceled", "AbortError");
    controller.abort(reason);

    await expect(
      incrementalBlobSha256(new Blob([Uint8Array.of(1)]), controller.signal),
    ).rejects.toBe(reason);
  });
});
