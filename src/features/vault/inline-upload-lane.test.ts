import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VAULT_INLINE_FILE_MAX_BYTES } from "@/features/vault/encrypted-upload";
import {
  INLINE_BATCH_MAX_BYTES,
  INLINE_BATCH_MAX_FILES,
  InlineUploadLane,
  InlineUploadsUnavailableError,
} from "@/features/vault/inline-upload-lane";
import {
  VaultApiError,
  type VaultInlineUploadResult,
} from "@/features/vault/vault-api";
import type { InlineUploadEntry } from "@/features/vault/vault-wire";

type Publish = (
  csrfToken: string,
  uploads: InlineUploadEntry[],
  signal?: AbortSignal,
) => Promise<{ results: VaultInlineUploadResult[] }>;

function entry(marker: number, bytes = 8): InlineUploadEntry {
  return {
    parentId: null,
    chunkCount: 1,
    record: {
      bootstrapCbor: Uint8Array.of(marker),
      bootstrapSignature: new Uint8Array(64),
      encryptedManifest: new Uint8Array(16),
      wrappers: [],
    },
    content: new Uint8Array(bytes).fill(marker || 1),
  };
}

const published = (upload: InlineUploadEntry): VaultInlineUploadResult => ({
  published: {
    nodeId: `node-${upload.record.bootstrapCbor[0]}`,
    generationNumber: 1,
    generationId: "generation",
    recordVersion: 1,
    recordHash: "hash",
    shareSyncRequired: false,
  },
});

function lane(publish: Publish, maxRequests = 3, signal?: AbortSignal) {
  return new InlineUploadLane({
    csrfToken: "csrf",
    signal: signal ?? new AbortController().signal,
    maxRequests: () => maxRequests,
    publish,
  });
}

describe("inline upload lane", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends files submitted together in one request after a short wait", async () => {
    const publish = vi.fn<Publish>(async (_csrf, uploads) => ({
      results: uploads.map(published),
    }));
    const uploads = lane(publish);

    const results = Promise.all([1, 2, 3].map((n) => uploads.submit(entry(n))));
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);

    expect(publish).toHaveBeenCalledTimes(1);
    expect((await results).map((result) => result.nodeId)).toEqual([
      "node-1",
      "node-2",
      "node-3",
    ]);
  });

  it("sends a full batch immediately and never exceeds the file limit", async () => {
    const sizes: number[] = [];
    const publish: Publish = async (_csrf, uploads) => {
      sizes.push(uploads.length);
      return { results: uploads.map(published) };
    };
    const uploads = lane(publish);

    const results = Promise.all(
      Array.from({ length: INLINE_BATCH_MAX_FILES + 5 }, (_, n) =>
        uploads.submit(entry(n % 200)),
      ),
    );
    // The full batch left without waiting for the linger timer.
    expect(sizes).toEqual([INLINE_BATCH_MAX_FILES]);
    await vi.advanceTimersByTimeAsync(10);
    await results;

    expect(sizes).toEqual([INLINE_BATCH_MAX_FILES, 5]);
  });

  it("splits by bytes and runs no more requests than the caller allows", async () => {
    let active = 0;
    let peak = 0;
    const sizes: number[] = [];
    const publish: Publish = async (_csrf, uploads) => {
      active += 1;
      peak = Math.max(peak, active);
      sizes.push(uploads.length);
      await new Promise((resolve) => setTimeout(resolve, 50));
      active -= 1;
      return { results: uploads.map(published) };
    };
    const uploads = lane(publish, 2);

    // Each file is half of the initial one-mebibyte batch target.
    const results = Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        uploads.submit(entry(n + 1, 512 * 1024)),
      ),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await results;

    expect(peak).toBe(2);
    expect(sizes.reduce((total, size) => total + size, 0)).toBe(8);
    expect(sizes.slice(0, 2)).toEqual([2, 2]);
  });

  it("packs the largest inline files within the batch byte limit", async () => {
    const batches: number[][] = [];
    const publish: Publish = async (_csrf, uploads) => {
      batches.push(uploads.map((upload) => upload.content.length));
      return { results: uploads.map(published) };
    };
    const uploads = lane(publish, 1);

    // The ciphertext of the largest file the upload routes inline.
    const results = Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        uploads.submit(entry(n + 1, VAULT_INLINE_FILE_MAX_BYTES + 16)),
      ),
    );
    await vi.advanceTimersByTimeAsync(100);
    await results;

    expect(batches.flat()).toHaveLength(8);
    // Above the initial target each file goes alone; once fast requests
    // raised it, two share a request and a third never fits.
    expect(batches[0]).toHaveLength(1);
    expect(Math.max(...batches.map((batch) => batch.length))).toBe(2);
    for (const batch of batches) {
      expect(
        batch.reduce((total, bytes) => total + bytes, 0),
      ).toBeLessThanOrEqual(INLINE_BATCH_MAX_BYTES);
    }
  });

  it("retries only the files the server shed for capacity", async () => {
    const calls: number[][] = [];
    const publish: Publish = async (_csrf, uploads) => {
      const markers = uploads.map((upload) => upload.record.bootstrapCbor[0]);
      calls.push(markers);
      return {
        results: uploads.map((upload) =>
          upload.record.bootstrapCbor[0] === 2 && calls.length === 1
            ? { failed: { status: 429, message: "too many uploads" } }
            : published(upload),
        ),
      };
    };
    const uploads = lane(publish);

    const results = Promise.all([1, 2, 3].map((n) => uploads.submit(entry(n))));
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await results).map((result) => result.nodeId)).toEqual([
      "node-1",
      "node-2",
      "node-3",
    ]);
    expect(calls).toEqual([[1, 2, 3], [2]]);
  });

  it("rejects a file the server refuses and wipes its ciphertext", async () => {
    const publish: Publish = async (_csrf, uploads) => ({
      results: uploads.map((upload) =>
        upload.record.bootstrapCbor[0] === 2
          ? { failed: { status: 409, message: "node head changed" } }
          : published(upload),
      ),
    });
    const uploads = lane(publish);
    const refused = entry(2);

    const kept = uploads.submit(entry(1));
    const rejected = uploads.submit(refused);
    const outcome = expect(rejected).rejects.toMatchObject({
      status: 409,
      message: "node head changed",
    });
    await vi.advanceTimersByTimeAsync(10);

    await outcome;
    expect((await kept).nodeId).toBe("node-1");
    expect(Array.from(refused.content)).toEqual(Array(8).fill(0));
  });

  it("gives up on the lane when the API has no inline route", async () => {
    const publish = vi.fn<Publish>(async () => {
      throw new VaultApiError("not found", 404);
    });
    const uploads = lane(publish, 1);

    const first = uploads.submit(entry(1));
    const firstOutcome = expect(first).rejects.toBeInstanceOf(
      InlineUploadsUnavailableError,
    );
    await vi.advanceTimersByTimeAsync(10);
    await firstOutcome;

    expect(uploads.available).toBe(false);
    await expect(uploads.submit(entry(2))).rejects.toBeInstanceOf(
      InlineUploadsUnavailableError,
    );
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("closes the lane when the API cannot process a batch at all", async () => {
    const publish = vi.fn<Publish>(async () => {
      throw new VaultApiError(
        "vault binary publication header is invalid",
        400,
      );
    });
    const uploads = lane(publish);

    const first = uploads.submit(entry(1));
    const outcome = expect(first).rejects.toBeInstanceOf(
      InlineUploadsUnavailableError,
    );
    await vi.advanceTimersByTimeAsync(10);
    await outcome;

    expect(uploads.available).toBe(false);
  });

  it("hands a file the API could not store back to the client-driven path", async () => {
    const publish: Publish = async (_csrf, uploads) => ({
      results: uploads.map((upload) =>
        upload.record.bootstrapCbor[0] === 2
          ? { failed: { status: 502, message: "Bad Gateway" } }
          : published(upload),
      ),
    });
    const uploads = lane(publish);

    const kept = uploads.submit(entry(1));
    const handedBack = uploads.submit(entry(2));
    const outcome = expect(handedBack).rejects.toBeInstanceOf(
      InlineUploadsUnavailableError,
    );
    await vi.advanceTimersByTimeAsync(10);

    await outcome;
    expect((await kept).nodeId).toBe("node-1");
    // One bad object does not close the lane for the files that follow.
    expect(uploads.available).toBe(true);
  });

  it("closes the lane when the API keeps failing to store whole batches", async () => {
    const publish = vi.fn<Publish>(async (_csrf, uploads) => ({
      results: uploads.map(() => ({
        failed: { status: 502, message: "Bad Gateway" },
      })),
    }));
    const uploads = lane(publish);

    for (const marker of [1, 2]) {
      const handedBack = uploads.submit(entry(marker));
      const outcome = expect(handedBack).rejects.toBeInstanceOf(
        InlineUploadsUnavailableError,
      );
      await vi.advanceTimersByTimeAsync(10);
      await outcome;
    }

    expect(uploads.available).toBe(false);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("fails a batch whose outcome is unknown instead of uploading it twice", async () => {
    const publish = vi
      .fn<Publish>()
      .mockRejectedValueOnce(new VaultApiError("gateway timeout", 504))
      .mockImplementation(async (_csrf, uploads) => ({
        results: uploads.map(published),
      }));
    const uploads = lane(publish);

    const failed = uploads.submit(entry(1));
    const failedOutcome = expect(failed).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(10);
    await failedOutcome;

    const next = uploads.submit(entry(2));
    await vi.advanceTimersByTimeAsync(10);
    expect((await next).nodeId).toBe("node-2");
    expect(uploads.available).toBe(true);
  });

  it("resends a timed-out batch in smaller requests", async () => {
    const sizes: number[] = [];
    const publish: Publish = async (_csrf, uploads) => {
      sizes.push(uploads.length);
      if (sizes.length === 1) {
        throw new VaultApiError("control body deadline exceeded", 408);
      }
      return { results: uploads.map(published) };
    };
    const uploads = lane(publish, 1);

    const results = Promise.all(
      Array.from({ length: 4 }, (_, n) =>
        uploads.submit(entry(n + 1, 256 * 1024)),
      ),
    );
    await vi.advanceTimersByTimeAsync(5_000);

    expect((await results).map((result) => result.nodeId)).toEqual([
      "node-1",
      "node-2",
      "node-3",
      "node-4",
    ]);
    // One mebibyte timed out; the retry fits half a mebibyte per request.
    expect(sizes).toEqual([4, 2, 2]);
  });

  it("rejects queued and retrying files when the upload is cancelled", async () => {
    const controller = new AbortController();
    const publish: Publish = async (_csrf, uploads) => ({
      results: uploads.map(() => ({
        failed: { status: 503, message: "busy" },
      })),
    });
    const uploads = lane(publish, 3, controller.signal);

    const retrying = uploads.submit(entry(1));
    const retryingOutcome = expect(retrying).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(10);
    const queued = uploads.submit(entry(2));
    const queuedOutcome = expect(queued).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));

    await retryingOutcome;
    await queuedOutcome;
    await expect(uploads.submit(entry(3))).rejects.toThrow("cancelled");
  });

  it("halves the next batch after a slow request", async () => {
    const sizes: number[] = [];
    const publish: Publish = async (_csrf, uploads) => {
      sizes.push(uploads.length);
      await new Promise((resolve) => setTimeout(resolve, 7_000));
      return { results: uploads.map(published) };
    };
    const uploads = lane(publish, 1);

    const results = Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        uploads.submit(entry(n + 1, 256 * 1024)),
      ),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await results;

    // One mebibyte first, then half a mebibyte, then the 256 KiB floor.
    expect(sizes).toEqual([4, 2, 1, 1]);
  });
});
