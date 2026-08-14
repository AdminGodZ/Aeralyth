import { describe, expect, it } from "vitest";

import {
  BoundedBatchPipeline,
  mapWithConcurrency,
  WeightedSemaphore,
} from "@/features/vault/bounded-async";
import { ExactStreamReader } from "@/features/vault/buffered-bytes";

const NETWORK_CHUNK_BYTES = 64 * 1024;
const CRYPTO_CHUNK_BYTES = 4 * 1024 * 1024;

describe("vault performance regression budgets", () => {
  it("copies fragmented downloads into one exact crypto buffer", async () => {
    let allocatedBytes = 0;
    let allocations = 0;
    const fragmentCount = CRYPTO_CHUNK_BYTES / NETWORK_CHUNK_BYTES;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < fragmentCount; index += 1) {
          controller.enqueue(new Uint8Array(NETWORK_CHUNK_BYTES));
        }
        controller.close();
      },
    });
    const reader = new ExactStreamReader(stream.getReader(), (length) => {
      allocations += 1;
      allocatedBytes += length;
      return new Uint8Array(length);
    });

    const output = await reader.readExactly(CRYPTO_CHUNK_BYTES);
    const previousAccumulatorCopyBytes =
      (NETWORK_CHUNK_BYTES * fragmentCount * (fragmentCount + 1)) / 2;

    expect(output).toHaveLength(CRYPTO_CHUNK_BYTES);
    expect(allocations).toBe(1);
    expect(allocatedBytes).toBe(CRYPTO_CHUNK_BYTES);
    expect(previousAccumulatorCopyBytes / allocatedBytes).toBeGreaterThan(30);
    expect(await reader.isAtEnd()).toBe(true);
    await reader.cancel();

    reportMetric("encrypted_download_copy_budget", {
      ciphertextBytes: CRYPTO_CHUNK_BYTES,
      allocatedBytes,
      allocationCount: allocations,
      modeledPreviousCopyBytes: previousAccumulatorCopyBytes,
    });
  });

  it("overlaps a four-part upload batch with one bounded lookahead part", async () => {
    const partBytes = 32 * 1024 * 1024;
    const batchSize = 4;
    let activeBatchParts = 0;
    let peakActiveBatches = 0;
    let activeBatches = 0;
    let peakResidentParts = 0;
    const releases: Array<() => void> = [];
    const processedBatches: number[][] = [];
    const pipeline = new BoundedBatchPipeline<number, number>(
      batchSize,
      1,
      async (batch) => {
        processedBatches.push(batch);
        activeBatches += 1;
        activeBatchParts = batch.length;
        peakActiveBatches = Math.max(peakActiveBatches, activeBatches);
        await new Promise<void>((resolve) => releases.push(resolve));
        activeBatchParts = 0;
        activeBatches -= 1;
        return batch;
      },
    );
    const sampleResidentParts = () => {
      peakResidentParts = Math.max(
        peakResidentParts,
        activeBatchParts + pipeline.bufferedInputs,
      );
    };

    await Promise.all([0, 1, 2, 3].map((part) => pipeline.push(part)));
    sampleResidentParts();
    const firstLookahead = pipeline.push(4);
    await Promise.resolve();
    sampleResidentParts();
    releases.shift()?.();
    await firstLookahead;

    await Promise.all([5, 6, 7].map((part) => pipeline.push(part)));
    sampleResidentParts();
    const secondLookahead = pipeline.push(8);
    await Promise.resolve();
    sampleResidentParts();
    releases.shift()?.();
    await secondLookahead;

    const finishing = pipeline.finish();
    await Promise.resolve();
    sampleResidentParts();
    releases.shift()?.();
    const completed = await finishing;

    expect(completed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(processedBatches).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8]]);
    expect(peakActiveBatches).toBe(1);
    expect(peakResidentParts).toBeLessThanOrEqual(batchSize + 1);

    reportMetric("encrypted_upload_pipeline_budget", {
      batchSize,
      lookaheadParts: 1,
      peakActiveBatches,
      peakResidentBytes: peakResidentParts * partBytes,
      maximumResidentBytes: (batchSize + 1) * partBytes,
    });
  });

  it("limits small files while large files consume the global budget", async () => {
    const capacity = 3;
    const semaphore = new WeightedSemaphore(capacity);
    const weights = [1, 1, 1, capacity, 1, 1];
    let activeWeight = 0;
    let peakWeight = 0;
    let peakSmallFiles = 0;
    let activeSmallFiles = 0;
    const largeFileActiveWeights: number[] = [];

    await mapWithConcurrency(weights, capacity, async (weight) => {
      const release = await semaphore.acquire(weight);
      activeWeight += weight;
      peakWeight = Math.max(peakWeight, activeWeight);
      if (weight === capacity) {
        largeFileActiveWeights.push(activeWeight);
      } else {
        activeSmallFiles += 1;
        peakSmallFiles = Math.max(peakSmallFiles, activeSmallFiles);
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (weight !== capacity) activeSmallFiles -= 1;
      activeWeight -= weight;
      release();
      return weight;
    });

    expect(peakWeight).toBe(capacity);
    expect(peakSmallFiles).toBe(capacity);
    expect(largeFileActiveWeights).toEqual([capacity]);

    reportMetric("encrypted_file_scheduler_budget", {
      capacity,
      peakWeight,
      peakSmallFiles,
      largeFileActiveWeights,
    });
  });
});

function reportMetric(name: string, values: Record<string, unknown>): void {
  console.info(JSON.stringify({ metric: name, ...values }));
}
