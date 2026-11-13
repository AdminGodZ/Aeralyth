"use client";

import {
  Boxes,
  Cloud,
  Database,
  Gauge,
  HardDrive,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { StorageMatrix } from "@/features/dashboard/storage-matrix";
import {
  formatStorageBytes,
  isStorageOverview,
  type StorageOverviewState,
  storagePercentage,
} from "@/features/dashboard/storage-overview";
import { cn } from "@/lib/utils";

const measurementTime = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
});

export function StorageContent({
  initialState,
}: {
  initialState: StorageOverviewState;
}) {
  const [state, setState] = useState(initialState);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [activeAccountKey, setActiveAccountKey] = useState<string | null>(null);
  const [activeBucketKey, setActiveBucketKey] = useState<string | null>(null);

  useEffect(() => {
    setState(initialState);
    setRefreshFailed(false);
    let current = initialState;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;

    function schedule() {
      if (
        disposed ||
        current.status === "unauthorized" ||
        current.status === "forbidden"
      )
        return;
      const bucket =
        current.status === "ready" ? current.data.bucketUsage : null;
      const pending =
        bucket?.status === "loading" ||
        (bucket?.status === "ready" && bucket.refreshing);
      timer = setTimeout(refresh, pending ? 3_000 : 60_000);
    }

    async function refresh() {
      clearTimeout(timer);
      if (document.hidden) return;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      try {
        const response = await fetch("/api/admin/storage", {
          cache: "no-store",
          credentials: "same-origin",
          signal: request.signal,
        });
        if (disposed || request.signal.aborted) return;
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (response.status === 403) {
          current = { status: "forbidden" };
          setState(current);
          return;
        }
        if (!response.ok) throw new Error("Storage refresh failed");
        const data: unknown = await response.json();
        if (!isStorageOverview(data))
          throw new Error("Invalid storage response");
        if (disposed || request.signal.aborted) return;
        current = { status: "ready", data };
        setState(current);
        setRefreshFailed(false);
      } catch {
        if (!disposed && !request.signal.aborted) setRefreshFailed(true);
      } finally {
        if (!disposed && !request.signal.aborted) schedule();
      }
    }

    function onVisibilityChange() {
      if (document.hidden) {
        clearTimeout(timer);
        controller?.abort();
      } else {
        void refresh();
      }
    }

    if (!document.hidden) schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [initialState]);

  if (state.status !== "ready") {
    return (
      <div className="px-4 py-5 sm:px-6">
        <section className="rounded-xl border p-5">
          <h2 className="font-medium">Storage unavailable</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {state.status === "forbidden"
              ? "Storage details are available to administrators."
              : "Storage details could not be loaded. We’ll try again shortly."}
          </p>
        </section>
      </div>
    );
  }

  const { account, provider, bucketName, region, bucketUsage } = state.data;
  const percent = storagePercentage(
    account.aeralythUsedBytes,
    account.totalBytes,
  );
  const percentLabel = `${percent.toFixed(1)}%`;
  const quotaKnown = account.totalBytes > 0;
  const bucketReady = bucketUsage.status === "ready";
  const bucketPending =
    bucketUsage.status === "loading" ||
    (bucketUsage.status === "ready" && bucketUsage.refreshing);
  const bucketBytes = bucketReady ? bucketUsage.usage.usedBytes : 0;
  // The two figures are measured separately, so the account can briefly lead the bucket.
  const ownBucketBytes = Math.min(account.aeralythUsedBytes, bucketBytes);
  const ProviderIcon = bucketName ? Cloud : HardDrive;

  return (
    <div className="storage-overview flex flex-1 flex-col gap-5 px-4 py-5 sm:px-6">
      <section
        className="overflow-hidden rounded-xl border"
        aria-labelledby="account-storage-title"
      >
        <div className="flex flex-col gap-5 p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2
                id="account-storage-title"
                className="text-sm font-medium text-muted-foreground"
              >
                Your account
              </h2>
              <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
                <span className="font-display text-3xl font-semibold tabular-nums">
                  {formatStorageBytes(account.aeralythUsedBytes)}
                </span>
                <span className="text-sm text-muted-foreground">
                  {quotaKnown
                    ? `of ${formatStorageBytes(account.totalBytes)} used`
                    : "used"}
                </span>
              </p>
            </div>
            <Badge variant="outline" className="gap-2">
              <ProviderIcon
                className="size-3.5 text-primary"
                aria-hidden="true"
              />
              {provider}
            </Badge>
          </div>
          {quotaKnown ? (
            <>
              <StorageMatrix
                segments={[
                  {
                    key: "used",
                    value: account.aeralythUsedBytes,
                    color: "var(--storage-tone-own)",
                  },
                ]}
                total={account.totalBytes}
                restKey="free"
                activeKey={activeAccountKey}
                onActiveKeyChange={setActiveAccountKey}
              />
              <progress
                className="sr-only"
                value={Math.min(100, percent)}
                max={100}
                aria-label="Account quota used"
                aria-valuetext={`${percentLabel} of your account quota used`}
              />
            </>
          ) : null}
          <dl className="-mx-2.5 grid gap-x-4 gap-y-0.5 sm:grid-cols-2 xl:grid-cols-4">
            <StorageLegendItem
              marker={<StorageTone color="var(--storage-tone-own)" />}
              label="Used"
              value={formatStorageBytes(account.aeralythUsedBytes)}
              active={activeAccountKey === "used"}
              onActiveChange={(active) =>
                setActiveAccountKey(active ? "used" : null)
              }
            />
            <StorageLegendItem
              marker={<StorageTone />}
              label="Remaining"
              value={
                quotaKnown ? formatStorageBytes(account.availableBytes) : "—"
              }
              active={activeAccountKey === "free"}
              onActiveChange={(active) =>
                setActiveAccountKey(active ? "free" : null)
              }
            />
            <StorageLegendItem
              marker={<StorageLegendIcon icon={Database} />}
              label="Account quota"
              value={
                quotaKnown ? formatStorageBytes(account.totalBytes) : "Not set"
              }
            />
            <StorageLegendItem
              marker={<StorageLegendIcon icon={Gauge} />}
              label="Utilization"
              value={quotaKnown ? percentLabel : "—"}
            />
          </dl>
        </div>
        <p className="border-t px-5 py-3 text-xs text-muted-foreground sm:px-6">
          Your files and Trash, within your account quota.
        </p>
      </section>

      <section
        className="overflow-hidden rounded-xl border"
        aria-labelledby="bucket-storage-title"
      >
        <div className="flex flex-col gap-5 p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2
                id="bucket-storage-title"
                className="text-sm font-medium text-muted-foreground"
              >
                Storage bucket
              </h2>
              {bucketUsage.status === "notConfigured" ? null : (
                <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
                  <span
                    className={cn(
                      "font-display text-3xl font-semibold tabular-nums",
                      !bucketReady && "text-muted-foreground",
                    )}
                  >
                    {bucketReady ? formatStorageBytes(bucketBytes) : "—"}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    across all accounts
                  </span>
                </p>
              )}
            </div>
            {region ? (
              <Badge variant="secondary">{region.toUpperCase()}</Badge>
            ) : null}
          </div>
          {bucketUsage.status === "notConfigured" ? (
            <p className="text-sm text-muted-foreground">
              This environment uses local storage. Bucket totals appear when S3
              is configured.
            </p>
          ) : (
            <>
              <StorageMatrix
                segments={[
                  {
                    key: "own",
                    value: ownBucketBytes,
                    color: "var(--storage-tone-own)",
                  },
                  {
                    key: "rest",
                    value: bucketBytes - ownBucketBytes,
                    color: "var(--storage-tone-rest)",
                  },
                ]}
                total={bucketBytes}
                activeKey={activeBucketKey}
                onActiveKeyChange={setActiveBucketKey}
                scanning={bucketPending}
              />
              <dl className="-mx-2.5 grid gap-x-4 gap-y-0.5 sm:grid-cols-2 xl:grid-cols-4">
                <StorageLegendItem
                  marker={<StorageTone color="var(--storage-tone-own)" />}
                  label="Your account"
                  value={
                    bucketReady
                      ? formatStorageBytes(account.aeralythUsedBytes)
                      : "—"
                  }
                  active={activeBucketKey === "own"}
                  onActiveChange={(active) =>
                    setActiveBucketKey(active ? "own" : null)
                  }
                />
                <StorageLegendItem
                  marker={<StorageTone color="var(--storage-tone-rest)" />}
                  label="Rest of bucket"
                  value={
                    bucketReady
                      ? formatStorageBytes(bucketBytes - ownBucketBytes)
                      : "—"
                  }
                  active={activeBucketKey === "rest"}
                  onActiveChange={(active) =>
                    setActiveBucketKey(active ? "rest" : null)
                  }
                />
                <StorageLegendItem
                  marker={<StorageLegendIcon icon={Boxes} />}
                  label="Objects"
                  value={
                    bucketReady
                      ? bucketUsage.usage.objectCount.toLocaleString("en")
                      : "—"
                  }
                />
                <StorageLegendItem
                  marker={<StorageLegendIcon icon={ProviderIcon} />}
                  label="Bucket"
                  value={bucketName ?? "—"}
                />
              </dl>
            </>
          )}
        </div>
        {bucketUsage.status === "notConfigured" ? null : (
          <div
            className="flex flex-wrap justify-between gap-2 border-t px-5 py-3 text-xs text-muted-foreground sm:px-6"
            role="status"
          >
            <span>
              {bucketUsage.status === "loading"
                ? "Measuring bucket usage…"
                : bucketUsage.status === "unavailable"
                  ? "Bucket usage is temporarily unavailable. We’ll retry shortly."
                  : bucketReady && bucketUsage.stale
                    ? `Showing an older measurement from ${measurementTime.format(bucketUsage.usage.measuredAt)} UTC.`
                    : bucketReady && bucketUsage.refreshing
                      ? "Updating bucket measurement…"
                      : bucketReady
                        ? `Measured at ${measurementTime.format(bucketUsage.usage.measuredAt)} UTC`
                        : null}
            </span>
            <span>Completed objects · Reconciles every 15 minutes</span>
          </div>
        )}
      </section>
      {refreshFailed ? (
        <p className="text-sm text-muted-foreground" role="status">
          The latest refresh failed. Displayed values are from the last
          successful update.
        </p>
      ) : null}
    </div>
  );
}

function StorageLegendItem({
  marker,
  label,
  value,
  active = false,
  onActiveChange,
}: {
  marker: ReactNode;
  label: string;
  value: string;
  active?: boolean;
  /** Present on entries that have a matching part of the bar to highlight. */
  onActiveChange?: (active: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-200",
        active && "bg-muted",
      )}
      onPointerEnter={onActiveChange ? () => onActiveChange(true) : undefined}
      onPointerLeave={onActiveChange ? () => onActiveChange(false) : undefined}
    >
      {marker}
      <dt className="shrink-0 text-sm">{label}</dt>
      <dd
        className="ml-auto min-w-0 truncate pl-2 font-mono text-sm tabular-nums text-muted-foreground"
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function StorageTone({ color }: { color?: string }) {
  return (
    <span
      className={cn(
        "size-2.5 shrink-0 rounded-[3px]",
        !color && "border border-dashed border-muted-foreground/70",
      )}
      style={color ? { background: color } : undefined}
      aria-hidden="true"
    />
  );
}

function StorageLegendIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <Icon
      className="size-3.5 shrink-0 text-muted-foreground"
      aria-hidden="true"
    />
  );
}
