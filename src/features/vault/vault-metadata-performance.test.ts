import { describe, expect, it } from "vitest";

import {
  recordVaultMetadataPerformance,
  vaultMetadataPerformanceSummary,
  vaultPerformanceNow,
} from "@/features/vault/vault-metadata-performance";

describe("vault metadata performance telemetry", () => {
  it("keeps bounded numeric percentile summaries without plaintext fields", () => {
    recordVaultMetadataPerformance("batch_request", vaultPerformanceNow() - 8, {
      nodeCount: 50,
      cacheHits: 10,
      cacheMisses: 40,
    });
    recordVaultMetadataPerformance("batch_request", vaultPerformanceNow() - 4, {
      nodeCount: 50,
      cacheHits: 50,
      cacheMisses: 0,
    });

    const summary = vaultMetadataPerformanceSummary("batch_request");
    expect(summary.samples).toBeGreaterThanOrEqual(2);
    expect(summary.p50).toBeGreaterThanOrEqual(0);
    expect(summary.p95).toBeGreaterThanOrEqual(summary.p50);
    expect(summary.p99).toBeGreaterThanOrEqual(summary.p95);

    const entries = performance.getEntriesByName(
      "aeralyth:vault:batch_request",
    );
    expect(entries).toHaveLength(1);
    const detail = entries.at(-1) as PerformanceMeasure;
    expect(detail.detail).toEqual(
      expect.objectContaining({
        nodeCount: 50,
        cacheHits: 50,
        cacheMisses: 0,
      }),
    );
    expect(detail.detail).not.toHaveProperty("name");
    expect(detail.detail).not.toHaveProperty("filename");
  });
});
