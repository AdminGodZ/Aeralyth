import { describe, expect, it, vi } from "vitest";

import { prefetchArchiveEntries } from "@/features/archive/archive-entry-prefetch";
import {
  ARCHIVE_PLAN_BATCH_SIZE,
  ARCHIVE_PLAN_REFILL,
} from "@/features/archive/archive-plan-batches";
import {
  VAULT_CRYPTO_CHUNK_BYTES,
  type VaultDownloadPlan,
  type VaultManifest,
} from "@/features/vault/protocol";

type Entry = {
  id: string;
  entryType: "file" | "folder";
  e2eeState: string;
  sizeBytes: number;
};

const MiB = 1024 * 1024;

function files(sizes: readonly number[], e2eeState = "legacy"): Entry[] {
  return sizes.map((sizeBytes, index) => ({
    id: `file-${index}`,
    entryType: "file",
    e2eeState,
    sizeBytes,
  }));
}

/** Content sources that record how many are open and what they delivered. */
function sources(entries: readonly Entry[], delayMs = 0) {
  const state = {
    open: 0,
    peakOpen: 0,
    opened: [] as number[],
    canceled: [] as number[],
    pulledBytes: new Map<number, number>(),
    chunksByIndex: new Map<number, Uint8Array[]>(),
    signals: [] as AbortSignal[],
  };
  const openSource = vi.fn(
    (entry: Entry, _encrypted: unknown, signal: AbortSignal) => {
      const index = entries.indexOf(entry);
      state.opened.push(index);
      state.signals.push(signal);
      state.open += 1;
      state.peakOpen = Math.max(state.peakOpen, state.open);
      let remaining = entry.sizeBytes;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        state.open -= 1;
      };
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          if (remaining === 0) {
            finish();
            controller.close();
            return;
          }
          const bytes = Math.min(remaining, VAULT_CRYPTO_CHUNK_BYTES);
          remaining -= bytes;
          state.pulledBytes.set(
            index,
            (state.pulledBytes.get(index) ?? 0) + bytes,
          );
          const chunk = new Uint8Array(bytes).fill(index + 1);
          state.chunksByIndex.set(index, [
            ...(state.chunksByIndex.get(index) ?? []),
            chunk,
          ]);
          controller.enqueue(chunk);
        },
        cancel() {
          state.canceled.push(index);
          finish();
        },
      });
    },
  );
  return { state, openSource };
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const values = new Set<number>();
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) return { bytes, values };
    bytes += result.value.byteLength;
    for (const value of new Set(result.value)) values.add(value);
  }
}

const noPlans = {
  getPlans: async (): Promise<VaultDownloadPlan[]> => {
    throw new Error("unexpected plan request");
  },
  openNode: async (): Promise<VaultManifest> => {
    throw new Error("unexpected open");
  },
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("prefetchArchiveEntries", () => {
  it("opens content ahead but hands entries over in order", async () => {
    const entries = [
      ...files([10, 20]),
      { id: "folder", entryType: "folder", e2eeState: "legacy", sizeBytes: 0 },
      ...files([30, 40, 50, 60, 70, 80]),
    ] satisfies Entry[];
    const { state, openSource } = sources(entries, 2);
    const prefetch = prefetchArchiveEntries(entries, {
      ...noPlans,
      openSource,
      maxRequests: 3,
    });

    const first = prefetch.take(0);
    await Promise.resolve();
    await Promise.resolve();
    // The writer has not read entry 0 yet, but the next files are opening;
    // the folder needs no request.
    expect(state.opened).toEqual([0, 1, 3]);

    for (const [index, entry] of entries.entries()) {
      const { opening, source } = index === 0 ? first : prefetch.take(index);
      expect(opening).toBeUndefined();
      if (entry.entryType === "folder") {
        expect(source).toBeNull();
        continue;
      }
      const content = await readAll((await source) as ReadableStream);
      expect(content).toEqual({
        bytes: entry.sizeBytes,
        values: new Set([index + 1]),
      });
      expect(state.peakOpen).toBeLessThanOrEqual(3);
    }
    expect(state.opened).toEqual([0, 1, 3, 4, 5, 6, 7, 8]);
    expect(state.open).toBe(0);
  });

  it("never holds more than the request limit open, even for large files", async () => {
    const entries = files(Array(12).fill(10 * MiB));
    const { state, openSource } = sources(entries);
    const prefetch = prefetchArchiveEntries(entries, {
      ...noPlans,
      openSource,
      maxRequests: 4,
    });

    for (const index of entries.keys()) {
      const { source } = prefetch.take(index);
      await settle();
      expect(state.open).toBeLessThanOrEqual(4);
      expect((await readAll((await source) as ReadableStream)).bytes).toBe(
        10 * MiB,
      );
    }
    expect(state.peakOpen).toBe(4);
    expect(state.open).toBe(0);
  });

  it("reads small files whole and keeps large ones at their first chunk", async () => {
    const entries = files([1 * MiB, 10 * MiB, 2 * MiB, 10 * MiB]);
    const { state, openSource } = sources(entries);
    const prefetch = prefetchArchiveEntries(entries, {
      ...noPlans,
      openSource,
    });

    const { source } = prefetch.take(0);
    await settle();
    expect(state.opened).toEqual([0, 1, 2, 3]);
    expect(state.pulledBytes.get(0)).toBe(1 * MiB);
    expect(state.pulledBytes.get(2)).toBe(2 * MiB);
    // A large file holds only what its source queued on its own.
    expect(state.pulledBytes.get(1)).toBe(VAULT_CRYPTO_CHUNK_BYTES);
    expect(state.pulledBytes.get(3)).toBe(VAULT_CRYPTO_CHUNK_BYTES);
    // The small files ended their requests; the large ones keep theirs.
    expect(state.open).toBe(2);
    await readAll((await source) as ReadableStream);
  });

  it("stays within the byte budget for content not taken yet", async () => {
    const entries = files([3 * MiB, 3 * MiB, 3 * MiB, 10 * MiB, 3 * MiB]);
    const { state, openSource } = sources(entries);
    const prefetch = prefetchArchiveEntries(entries, {
      ...noPlans,
      openSource,
      maxBufferedBytes: 8 * MiB,
    });

    const sourcesTaken = [prefetch.take(0).source];
    await settle();
    // Entry 0 is being archived; entries 1 and 2 fill the 8 MiB budget.
    expect(state.opened).toEqual([0, 1, 2]);

    sourcesTaken.push(prefetch.take(1).source);
    await settle();
    // Entry 3 reserves one 4 MiB chunk beside entry 2; entry 4 must wait.
    expect(state.opened).toEqual([0, 1, 2, 3]);

    sourcesTaken.push(prefetch.take(2).source);
    await settle();
    expect(state.opened).toEqual([0, 1, 2, 3, 4]);
    for (const source of sourcesTaken) {
      await readAll((await source) as ReadableStream);
    }
  });

  it("cancels every prefetched request and wipes buffered content on close", async () => {
    const entries = files([10 * MiB, 1 * MiB, 10 * MiB, 1 * MiB, 10 * MiB]);
    const { state, openSource } = sources(entries);
    let pendingSignal: AbortSignal | undefined;
    const prefetch = prefetchArchiveEntries(entries, {
      ...noPlans,
      openSource: (entry, encrypted, signal) => {
        if (entry === entries[4]) {
          pendingSignal = signal;
          // An open still waiting for response headers.
          return new Promise<ReadableStream<Uint8Array>>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          );
        }
        return openSource(entry, encrypted, signal);
      },
    });

    const { source } = prefetch.take(0);
    const reader = ((await source) as ReadableStream).getReader();
    await reader.read();
    await settle();
    expect(state.opened).toEqual([0, 1, 2, 3]);

    const reason = new Error("stop");
    await prefetch.close(reason);

    expect(state.open).toBe(0);
    expect(state.canceled.sort()).toEqual([0, 2]);
    expect(pendingSignal?.aborted).toBe(true);
    expect(state.signals.every((signal) => signal.aborted)).toBe(true);
    // The small files read ahead were wiped.
    for (const index of [1, 3]) {
      const chunks = state.chunksByIndex.get(index) ?? [];
      expect(chunks).toHaveLength(1);
      expect(chunks[0].every((byte) => byte === 0)).toBe(true);
    }
    // The writer sees a failure, not a truncated file.
    await expect(reader.read()).rejects.toBe(reason);
  });

  it("aborts with the archive signal", async () => {
    const entries = files([1 * MiB, 10 * MiB, 10 * MiB]);
    const { state, openSource } = sources(entries);
    const controller = new AbortController();
    const prefetch = prefetchArchiveEntries(entries, {
      ...noPlans,
      openSource,
      signal: controller.signal,
    });

    prefetch.take(0);
    await settle();
    controller.abort();

    expect(state.signals.every((signal) => signal.aborted)).toBe(true);
    await prefetch.close(controller.signal.reason);
    expect(state.open).toBe(0);
  });

  it("surfaces a failure only when its entry is taken", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const entries = files([10, 20, 30, 40, 50]);
      const { state, openSource } = sources(entries);
      const prefetch = prefetchArchiveEntries(entries, {
        ...noPlans,
        openSource: (entry, encrypted, signal) => {
          if (entry === entries[2]) {
            return new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.error(new Error("entry 2 failed"));
              },
            });
          }
          if (entry === entries[3]) throw new Error("entry 3 failed");
          return openSource(entry, encrypted, signal);
        },
      });

      const first = prefetch.take(0);
      await settle();
      for (const index of [0, 1]) {
        const { source } = index === 0 ? first : prefetch.take(index);
        expect(await readAll((await source) as ReadableStream)).toEqual({
          bytes: entries[index].sizeBytes,
          values: new Set([index + 1]),
        });
      }
      await expect(prefetch.take(2).source).rejects.toThrow("entry 2 failed");
      // Entry 3 failed too, but the writer never reaches it.
      await prefetch.close(new Error("archive failed"));
      await settle();
      expect(state.open).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("requests plans in batches just ahead of the lookahead window", async () => {
    const entries = files(Array(150).fill(10), "encrypted");
    const getPlans = vi.fn(async (nodeIds: readonly string[]) =>
      nodeIds.map((nodeId) => ({ nodeId }) as unknown as VaultDownloadPlan),
    );
    const openNode = vi.fn(
      async (nodeId: string) =>
        ({ name: nodeId, plaintextBytes: 10 }) as unknown as VaultManifest,
    );
    const { openSource } = sources(entries);
    const prefetch = prefetchArchiveEntries(entries, {
      getPlans,
      openNode,
      openSource,
      lookahead: 3,
    });
    const planned = () => getPlans.mock.calls.flatMap(([nodeIds]) => nodeIds);

    for (const index of entries.keys()) {
      const { opening, source } = prefetch.take(index);
      // Never the whole archive: at most one batch beyond the window.
      expect(planned().length).toBeLessThanOrEqual(
        index + 4 + ARCHIVE_PLAN_REFILL + ARCHIVE_PLAN_BATCH_SIZE,
      );
      await expect(opening).resolves.toMatchObject({
        plan: { nodeId: entries[index].id },
      });
      await readAll((await source) as ReadableStream);
    }
    expect(getPlans).toHaveBeenCalledTimes(3);
    for (const [nodeIds] of getPlans.mock.calls) {
      expect(nodeIds.length).toBeLessThanOrEqual(ARCHIVE_PLAN_BATCH_SIZE);
    }
    expect(planned()).toEqual(entries.map((entry) => entry.id));
    expect(openNode.mock.calls.map(([nodeId]) => nodeId)).toEqual(
      entries.map((entry) => entry.id),
    );
  });

  it("surfaces a refused plan only when its entry is taken", async () => {
    const entries = files([10, 10, 10], "encrypted");
    const refused = new Error("not found");
    const prefetch = prefetchArchiveEntries(entries, {
      getPlans: async (nodeIds) =>
        nodeIds.map((nodeId) =>
          nodeId === entries[1].id
            ? refused
            : ({ nodeId } as unknown as VaultDownloadPlan),
        ),
      openNode: async (nodeId) =>
        ({ name: nodeId, plaintextBytes: 10 }) as unknown as VaultManifest,
      openSource: sources(entries).openSource,
    });

    const first = prefetch.take(0);
    await expect(first.opening).resolves.toMatchObject({
      plan: { nodeId: entries[0].id },
    });
    await readAll((await first.source) as ReadableStream);
    const second = prefetch.take(1);
    await expect(second.opening).rejects.toBe(refused);
    await expect(second.source).rejects.toBe(refused);
    await prefetch.close();
  });

  it("rejects taking entries out of order", () => {
    const prefetch = prefetchArchiveEntries(files([1, 2]), {
      ...noPlans,
      openSource: () => new ReadableStream(),
    });
    expect(() => prefetch.take(1)).toThrow("in order");
  });
});
