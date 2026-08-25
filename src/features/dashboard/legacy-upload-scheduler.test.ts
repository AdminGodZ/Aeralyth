import { describe, expect, it, vi } from "vitest";

import {
  LEGACY_CONCURRENT_FILE_MAX_BYTES,
  scheduleLegacyUploads,
} from "@/features/dashboard/legacy-upload-scheduler";

describe("legacy upload scheduler", () => {
  it("runs at most three small files concurrently", async () => {
    const gates = Array.from({ length: 5 }, () =>
      Promise.withResolvers<void>(),
    );
    let active = 0;
    let maximumActive = 0;
    const upload = vi.fn(async (index: number) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gates[index]?.promise;
      active -= 1;
      return index * 2;
    });

    const scheduled = scheduleLegacyUploads(
      [0, 1, 2, 3, 4],
      new AbortController().signal,
      () => LEGACY_CONCURRENT_FILE_MAX_BYTES,
      upload,
    );
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    expect(maximumActive).toBe(3);

    gates[0]?.resolve();
    gates[1]?.resolve();
    gates[2]?.resolve();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(5));
    gates[3]?.resolve();
    gates[4]?.resolve();

    await expect(scheduled).resolves.toEqual([0, 2, 4, 6, 8]);
    expect(maximumActive).toBe(3);
  });

  it("gives a large file exclusive access to the upload slots", async () => {
    const largeGate = Promise.withResolvers<void>();
    const started: number[] = [];
    const scheduled = scheduleLegacyUploads(
      [0, 1, 2],
      new AbortController().signal,
      (index) => (index === 0 ? LEGACY_CONCURRENT_FILE_MAX_BYTES + 1 : 1),
      async (index) => {
        started.push(index);
        if (index === 0) await largeGate.promise;
        return index;
      },
    );

    await vi.waitFor(() => expect(started).toEqual([0]));
    largeGate.resolve();
    await expect(scheduled).resolves.toEqual([0, 1, 2]);
  });

  it("aborts sibling uploads and preserves the original failure", async () => {
    const failure = new Error("upload failed");
    const siblingAborted = Promise.withResolvers<void>();
    const scheduled = scheduleLegacyUploads(
      [0, 1],
      new AbortController().signal,
      () => 1,
      async (index, signal) => {
        if (index === 0) {
          await Promise.resolve();
          throw failure;
        }
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              siblingAborted.resolve();
              reject(signal.reason);
            },
            { once: true },
          );
        });
        return index;
      },
    );

    await expect(scheduled).rejects.toBe(failure);
    await siblingAborted.promise;
  });
});
