"use client";

import { Cloud, HardDrive } from "lucide-react";
import { useEffect, useState } from "react";
import { StorageMatrix } from "@/features/dashboard/storage-matrix";
import {
  formatStorageBytes,
  isStorageOverview,
  type StorageOverview,
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
      <div className="storage-overview px-4 py-5 sm:px-6">
        <section className="dashboard-card p-5 sm:p-6">
          <h2 className={cardLabel}>Storage unavailable</h2>
          <p className="mt-3 text-sm text-muted-foreground">
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
  const bucketNote =
    bucketUsage.status === "loading"
      ? "Measuring bucket usage…"
      : bucketUsage.status === "unavailable"
        ? "Bucket usage is temporarily unavailable. We’ll retry shortly."
        : bucketReady && bucketUsage.stale
          ? "Showing an older measurement."
          : bucketReady && bucketUsage.refreshing
            ? "Updating bucket measurement…"
            : null;
  const ProviderIcon = bucketName ? Cloud : HardDrive;

  return (
    <div className="storage-overview flex flex-1 flex-col gap-4 px-4 py-5 sm:px-6">
      <dl className="grid gap-4 sm:grid-cols-3">
        <StorageStatCard
          label="Used"
          value={formatStorageBytes(account.aeralythUsedBytes)}
          note={quotaKnown ? `${percentLabel} of quota` : "no quota set"}
        />
        <StorageStatCard
          label="Remaining"
          value={quotaKnown ? formatStorageBytes(account.availableBytes) : "—"}
          note="until the quota"
        />
        <StorageStatCard
          label="Account quota"
          value={
            quotaKnown ? formatStorageBytes(account.totalBytes) : "Not set"
          }
          note="files and Trash"
        />
      </dl>

      <section
        className="dashboard-card p-5 sm:p-6"
        aria-labelledby="account-storage-title"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="account-storage-title" className={cardLabel}>
              Your account
            </h2>
            <StorageFigure
              value={
                quotaKnown
                  ? percentLabel
                  : formatStorageBytes(account.aeralythUsedBytes)
              }
              note={
                quotaKnown
                  ? `of ${formatStorageBytes(account.totalBytes)} used`
                  : "used"
              }
            />
          </div>
          <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <ProviderIcon className="size-3.5" aria-hidden="true" />
            {provider}
          </p>
        </div>
        {quotaKnown ? (
          <>
            <StorageMatrix
              className="mt-6 h-28"
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
            <ul className="mt-5 flex flex-wrap gap-x-2 gap-y-1">
              <StorageLegendItem
                tone="var(--storage-tone-own)"
                label="Used"
                value={formatStorageBytes(account.aeralythUsedBytes)}
                active={activeAccountKey === "used"}
                onActiveChange={(active) =>
                  setActiveAccountKey(active ? "used" : null)
                }
              />
              <StorageLegendItem
                label="Remaining"
                value={formatStorageBytes(account.availableBytes)}
                active={activeAccountKey === "free"}
                onActiveChange={(active) =>
                  setActiveAccountKey(active ? "free" : null)
                }
              />
            </ul>
          </>
        ) : null}
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <section
          className="dashboard-card p-5 sm:p-6"
          aria-labelledby="bucket-storage-title"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="bucket-storage-title" className={cardLabel}>
                Storage bucket
              </h2>
              {bucketUsage.status === "notConfigured" ? null : (
                <StorageFigure
                  value={bucketReady ? formatStorageBytes(bucketBytes) : "—"}
                  note="across all accounts"
                />
              )}
            </div>
            <BucketStatus bucketUsage={bucketUsage} />
          </div>
          {bucketUsage.status === "notConfigured" ? (
            <p className="mt-3 text-sm text-muted-foreground">
              This environment uses local storage. Bucket totals appear when S3
              is configured.
            </p>
          ) : (
            <>
              <StorageMatrix
                className="mt-6 h-20"
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
              <ul className="mt-5 flex flex-wrap gap-x-2 gap-y-1">
                <StorageLegendItem
                  tone="var(--storage-tone-own)"
                  label="Your account"
                  value={bucketReady ? formatStorageBytes(ownBucketBytes) : "—"}
                  active={activeBucketKey === "own"}
                  onActiveChange={(active) =>
                    setActiveBucketKey(active ? "own" : null)
                  }
                />
                <StorageLegendItem
                  tone="var(--storage-tone-rest)"
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
              </ul>
              {bucketNote ? (
                <p
                  className="mt-3 text-[13px] text-muted-foreground"
                  role="status"
                >
                  {bucketNote}
                </p>
              ) : null}
            </>
          )}
        </section>

        <section
          className="dashboard-card p-5 sm:p-6"
          aria-labelledby="storage-details-title"
        >
          <h2 id="storage-details-title" className={cardLabel}>
            Details
          </h2>
          <dl className="mt-5 space-y-3.5">
            <StorageDetail label="Provider" value={provider} />
            <StorageDetail label="Bucket" value={bucketName ?? "—"} mono />
            <StorageDetail
              label="Region"
              value={region ? region.toUpperCase() : "—"}
            />
            <StorageDetail
              label="Objects"
              value={
                bucketReady
                  ? bucketUsage.usage.objectCount.toLocaleString("en")
                  : "—"
              }
            />
            <StorageDetail
              label="Last measured"
              value={
                bucketReady
                  ? `${measurementTime.format(bucketUsage.usage.measuredAt)} UTC`
                  : "—"
              }
            />
            <StorageDetail label="Reconciles" value="Every 15 minutes" />
          </dl>
        </section>
      </div>
      {refreshFailed ? (
        <p className="px-1 text-sm text-muted-foreground" role="status">
          The latest refresh failed. Displayed values are from the last
          successful update.
        </p>
      ) : null}
    </div>
  );
}

const cardLabel = "text-[13px] font-medium text-muted-foreground";

/** A card's headline figure with a quiet note beside it. */
function StorageFigure({ value, note }: { value: string; note: string }) {
  return (
    <p className="mt-3 flex flex-wrap items-baseline gap-x-2">
      <span
        className={cn(
          "text-[1.75rem] leading-9 font-semibold tracking-tight tabular-nums",
          value === "—" && "text-muted-foreground",
        )}
      >
        {value}
      </span>
      <span className="text-[13px] text-muted-foreground">{note}</span>
    </p>
  );
}

function StorageStatCard({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="dashboard-card p-5 sm:p-6">
      <dt className={cardLabel}>{label}</dt>
      <dd className="mt-5 flex flex-wrap items-baseline gap-x-2">
        <span className="text-[1.625rem] leading-8 font-semibold tracking-tight tabular-nums">
          {value}
        </span>
        <span className="text-[13px] text-muted-foreground">{note}</span>
      </dd>
    </div>
  );
}

function BucketStatus({
  bucketUsage,
}: {
  bucketUsage: StorageOverview["bucketUsage"];
}) {
  const [tone, label] =
    bucketUsage.status === "ready"
      ? bucketUsage.stale
        ? (["warn", "Stale"] as const)
        : bucketUsage.refreshing
          ? (["busy", "Updating"] as const)
          : (["ok", "Up to date"] as const)
      : bucketUsage.status === "loading"
        ? (["busy", "Measuring"] as const)
        : bucketUsage.status === "unavailable"
          ? (["error", "Unavailable"] as const)
          : (["idle", "Local storage"] as const);
  return (
    <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <span
        className="storage-status-dot"
        data-tone={tone}
        aria-hidden="true"
      />
      {label}
    </p>
  );
}

function StorageLegendItem({
  tone,
  label,
  value,
  active,
  onActiveChange,
}: {
  /** Omitted for the unused remainder of a bar. */
  tone?: string;
  label: string;
  value: string;
  active: boolean;
  onActiveChange: (active: boolean) => void;
}) {
  return (
    <li
      className={cn(
        "-ml-2 flex items-center gap-2 rounded-lg px-2 py-1 text-[13px] transition-colors duration-200",
        active && "bg-white/[6%]",
      )}
      onPointerEnter={() => onActiveChange(true)}
      onPointerLeave={() => onActiveChange(false)}
    >
      <span
        className={cn("size-2 shrink-0 rounded-[2px]", !tone && "bg-white/15")}
        style={tone ? { background: tone } : undefined}
        aria-hidden="true"
      />
      <span>{label}</span>
      <span className="text-muted-foreground tabular-nums">{value}</span>
    </li>
  );
}

function StorageDetail({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0 text-right",
          // Identifiers truncate; prose such as a timestamp wraps instead.
          mono ? "truncate font-mono text-[13px]" : "text-balance",
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}
