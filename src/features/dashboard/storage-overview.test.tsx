import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StorageContent } from "./storage-content";
import {
  formatStorageBytes,
  isStorageOverview,
  type StorageOverview,
  storagePercentage,
} from "./storage-overview";

const overview: StorageOverview = {
  account: {
    storagePath: "s3 storage",
    totalBytes: 10 * 1024 ** 3,
    availableBytes: 10 * 1024 ** 3 - 13 * 1024 ** 2,
    systemUsedBytes: 13 * 1024 ** 2,
    aeralythUsedBytes: 13 * 1024 ** 2,
  },
  provider: "Railway S3",
  bucketName: "example-bucket",
  region: "ams",
  bucketUsage: {
    status: "ready",
    usage: {
      usedBytes: 332815584,
      objectCount: 350,
      measuredAt: 1700000000000,
    },
    refreshing: false,
    stale: false,
  },
};

describe("storage overview", () => {
  it("rounds the label to one decimal without rounding away the progress value", () => {
    const percentage = storagePercentage(13 * 1024 ** 2, 10 * 1024 ** 3);
    expect(percentage.toFixed(1)).toBe("0.1");
    expect(percentage).toBeGreaterThan(0.1);
    const html = renderToStaticMarkup(
      <StorageContent initialState={{ status: "ready", data: overview }} />,
    );
    expect(html).toContain("0.1%");
    expect(html).toContain(`value="${percentage}"`);
    expect(html).toContain("Your account");
    expect(html).toContain("Storage bucket");
    expect(html).toContain("332.8 MB");
    expect(html).toContain("350");
  });

  it("uses decimal byte units matching the provider and handles invalid totals", () => {
    expect(formatStorageBytes(332815584)).toBe("332.8 MB");
    expect(formatStorageBytes(0)).toBe("0 B");
    expect(formatStorageBytes(Number.NaN)).toBe("0 B");
    expect(storagePercentage(1, 0)).toBe(0);
    expect(storagePercentage(-1, 10)).toBe(0);
    expect(storagePercentage(12, 10)).toBe(120);
  });

  it("does not show unknown bucket usage as zero or an account quota as bucket capacity", () => {
    for (const status of ["loading", "unavailable", "notConfigured"] as const) {
      const html = renderToStaticMarkup(
        <StorageContent
          initialState={{
            status: "ready",
            data: { ...overview, bucketUsage: { status } },
          }}
        />,
      );
      expect(html).not.toContain("332.8 MB");
      expect(html).not.toContain("Bucket capacity");
      expect(html).toContain("0.1%");
    }
  });

  it("validates complete snapshots and rejects malformed or negative data", () => {
    expect(isStorageOverview(overview)).toBe(true);
    expect(isStorageOverview(null)).toBe(false);
    expect(
      isStorageOverview({ ...overview, bucketUsage: { status: "ready" } }),
    ).toBe(false);
    expect(
      isStorageOverview({
        ...overview,
        account: { ...overview.account, availableBytes: -1 },
      }),
    ).toBe(false);
  });
});
