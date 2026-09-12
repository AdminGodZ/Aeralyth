import type { StorageStats } from "@/lib/api";

export type BucketUsageState =
  | { status: "notConfigured" | "loading" | "unavailable" }
  | {
      status: "ready";
      usage: { usedBytes: number; objectCount: number; measuredAt: number };
      refreshing: boolean;
      stale: boolean;
    };

export type StorageOverview = {
  account: StorageStats;
  provider: string;
  bucketName: string | null;
  region: string | null;
  bucketUsage: BucketUsageState;
};

export type StorageOverviewState =
  | { status: "ready"; data: StorageOverview }
  | { status: "unauthorized" | "forbidden" }
  | { status: "unavailable"; retryable?: boolean };

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isStorageOverview(value: unknown): value is StorageOverview {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<StorageOverview>;
  const account = data.account;
  const bucket = data.bucketUsage;
  return Boolean(
    typeof data.provider === "string" &&
      (data.bucketName === null || typeof data.bucketName === "string") &&
      (data.region === null || typeof data.region === "string") &&
      account &&
      typeof account.storagePath === "string" &&
      isNonnegativeNumber(account.totalBytes) &&
      isNonnegativeNumber(account.availableBytes) &&
      isNonnegativeNumber(account.systemUsedBytes) &&
      isNonnegativeNumber(account.aeralythUsedBytes) &&
      bucket &&
      (bucket.status === "notConfigured" ||
        bucket.status === "loading" ||
        bucket.status === "unavailable" ||
        (bucket.status === "ready" &&
          bucket.usage &&
          isNonnegativeNumber(bucket.usage.usedBytes) &&
          isNonnegativeNumber(bucket.usage.objectCount) &&
          isNonnegativeNumber(bucket.usage.measuredAt) &&
          typeof bucket.refreshing === "boolean" &&
          typeof bucket.stale === "boolean")),
  );
}

export function storagePercentage(used: number, total: number) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.max(0, (used / total) * 100);
}

export function formatStorageBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1000 && unit < units.length - 1) {
    size /= 1000;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
