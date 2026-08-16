import { describe, expect, it } from "vitest";

import {
  BoundedBatchPipeline,
  mapWithConcurrency,
  WeightedSemaphore,
} from "@/features/vault/bounded-async";
import { ExactStreamReader } from "@/features/vault/buffered-bytes";
import {
  encodeCreateSharePublication,
  encodeNodePublication,
} from "@/features/vault/vault-wire";

const NETWORK_CHUNK_BYTES = 64 * 1024;
const CRYPTO_CHUNK_BYTES = 4 * 1024 * 1024;

describe("vault performance regression budgets", () => {
  it("keeps publication wire bytes raw and cheaper than base64 JSON", () => {
    const manifest = new Uint8Array(1024 * 1024).fill(5);
    const wrappers = Array.from({ length: 64 }, (_, index) =>
      new Uint8Array(8 * 1024).fill(index),
    );
    const record = {
      bootstrapCbor: new Uint8Array(8 * 1024).fill(3),
      bootstrapSignature: new Uint8Array(64).fill(4),
      encryptedManifest: manifest,
      wrappers,
    };
    let binary: Uint8Array = new Uint8Array();
    let json = "";
    const samples = 7;
    const timings = compareMedianDurations(
      samples,
      () => {
        binary = encodeNodePublication([], record);
      },
      () => {
        json = JSON.stringify({
          parts: [],
          bootstrapCbor: Buffer.from(record.bootstrapCbor).toString(
            "base64url",
          ),
          bootstrapSignature: Buffer.from(record.bootstrapSignature).toString(
            "base64url",
          ),
          encryptedManifest: Buffer.from(record.encryptedManifest).toString(
            "base64url",
          ),
          wrappers: record.wrappers.map((wrapper) =>
            Buffer.from(wrapper).toString("base64url"),
          ),
        });
      },
    );
    const jsonBytes = new TextEncoder().encode(json).byteLength;

    expect(jsonBytes / binary.byteLength).toBeGreaterThan(1.32);
    expect(timings.binaryMedianMs).toBeLessThan(timings.jsonMedianMs);
    reportMetric("vault_binary_publication_budget", {
      rawMaterialBytes:
        record.bootstrapCbor.byteLength +
        record.bootstrapSignature.byteLength +
        record.encryptedManifest.byteLength +
        wrappers.reduce((total, wrapper) => total + wrapper.byteLength, 0),
      binaryBytes: binary.byteLength,
      base64JsonBytes: jsonBytes,
      wireRatio: jsonBytes / binary.byteLength,
      samples,
      binaryMedianEncodeMs: timings.binaryMedianMs,
      base64JsonMedianEncodeMs: timings.jsonMedianMs,
    });
  });

  it("keeps representative share publications raw with one exact output buffer", () => {
    const wrappers = Array.from({ length: 1024 }, (_, index) =>
      new Uint8Array(4 * 1024).fill(index & 0xff),
    );
    const envelopes = Array.from({ length: 128 }, (_, index) => ({
      canonicalCbor: new Uint8Array(512).fill(index),
      signature: new Uint8Array(64).fill(index),
    }));
    const publication = {
      shareId: "shr_representative",
      rootNodeId: "fil_representative",
      recipientId: "usr_representative",
      recipientKeyVersion: 7,
      wrappers,
      envelopes,
      ownerEpochKey: {
        wrapperId: new Uint8Array(16).fill(3),
        ciphertext: new Uint8Array(48).fill(4),
      },
    };
    let binary: Uint8Array = new Uint8Array();
    let json = "";
    const samples = 7;
    const timings = compareMedianDurations(
      samples,
      () => {
        binary = encodeCreateSharePublication(publication);
      },
      () => {
        json = JSON.stringify({
          ...publication,
          wrappers: wrappers.map((wrapper) =>
            Buffer.from(wrapper).toString("base64url"),
          ),
          envelopes: envelopes.map((envelope) => ({
            canonicalCbor: Buffer.from(envelope.canonicalCbor).toString(
              "base64url",
            ),
            signature: Buffer.from(envelope.signature).toString("base64url"),
          })),
          ownerEpochKey: {
            wrapperId: Buffer.from(
              publication.ownerEpochKey.wrapperId,
            ).toString("base64url"),
            ciphertext: Buffer.from(
              publication.ownerEpochKey.ciphertext,
            ).toString("base64url"),
          },
        });
      },
    );
    const jsonBytes = new TextEncoder().encode(json).byteLength;
    const rawMaterialBytes =
      wrappers.reduce((total, wrapper) => total + wrapper.byteLength, 0) +
      envelopes.reduce(
        (total, envelope) =>
          total +
          envelope.canonicalCbor.byteLength +
          envelope.signature.byteLength,
        0,
      ) +
      publication.ownerEpochKey.wrapperId.byteLength +
      publication.ownerEpochKey.ciphertext.byteLength;

    const ownsExactOutputBuffer =
      binary.byteOffset === 0 && binary.byteLength === binary.buffer.byteLength;
    expect(ownsExactOutputBuffer).toBe(true);
    expect(jsonBytes / binary.byteLength).toBeGreaterThan(1.32);
    expect(timings.binaryMedianMs).toBeLessThan(timings.jsonMedianMs);
    reportMetric("vault_binary_share_publication_budget", {
      rawMaterialBytes,
      binaryBytes: binary.byteLength,
      base64JsonBytes: jsonBytes,
      wireRatio: jsonBytes / binary.byteLength,
      ownsExactOutputBuffer,
      samples,
      binaryMedianEncodeMs: timings.binaryMedianMs,
      base64JsonMedianEncodeMs: timings.jsonMedianMs,
    });
  });

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

function compareMedianDurations(
  samples: number,
  encodeBinary: () => void,
  encodeJson: () => void,
): { binaryMedianMs: number; jsonMedianMs: number } {
  encodeBinary();
  encodeJson();
  const binary = new Array<number>(samples);
  const json = new Array<number>(samples);
  const measure = (operation: () => void): number => {
    const started = performance.now();
    operation();
    return performance.now() - started;
  };
  for (let index = 0; index < samples; index += 1) {
    if (index % 2 === 0) {
      binary[index] = measure(encodeBinary);
      json[index] = measure(encodeJson);
    } else {
      json[index] = measure(encodeJson);
      binary[index] = measure(encodeBinary);
    }
  }
  binary.sort((left, right) => left - right);
  json.sort((left, right) => left - right);
  return {
    binaryMedianMs: binary[Math.floor(samples / 2)] ?? Number.POSITIVE_INFINITY,
    jsonMedianMs: json[Math.floor(samples / 2)] ?? Number.POSITIVE_INFINITY,
  };
}
