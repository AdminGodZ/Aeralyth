"use client";

import { Cloud, HardDrive } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  formatStorageBytes,
  isStorageOverview,
  type StorageOverviewState,
  storagePercentage,
} from "@/features/dashboard/storage-overview";

const measurementTime = new Intl.DateTimeFormat("en", {
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
  const ProviderIcon = bucketName ? Cloud : HardDrive;

  return (
    <div className="flex flex-1 flex-col gap-5 px-4 py-5 sm:px-6">
      <section
        className="overflow-hidden rounded-xl border"
        aria-labelledby="account-storage-title"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b p-5">
          <div>
            <h2 id="account-storage-title" className="font-medium">
              Your account
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Your files and Trash, within your account quota.
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
        <dl className="grid grid-cols-2 gap-5 p-5 xl:grid-cols-4">
          <StorageMetric
            label="Used"
            value={formatStorageBytes(account.aeralythUsedBytes)}
          />
          <StorageMetric
            label="Remaining"
            value={
              quotaKnown ? formatStorageBytes(account.availableBytes) : "—"
            }
          />
          <StorageMetric
            label="Account quota"
            value={
              quotaKnown ? formatStorageBytes(account.totalBytes) : "Not set"
            }
          />
          <StorageMetric
            label="Utilization"
            value={quotaKnown ? percentLabel : "—"}
          />
        </dl>
        {quotaKnown ? (
          <div className="px-5 pb-5">
            <progress
              className="storage-usage-meter"
              value={Math.min(100, percent)}
              max={100}
              aria-label="Account quota used"
              aria-valuetext={`${percentLabel} of your account quota used`}
            />
            <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>{percentLabel} used</span>
              <span>
                {formatStorageBytes(account.availableBytes)} remaining
              </span>
            </div>
          </div>
        ) : null}
      </section>

      <section
        className="overflow-hidden rounded-xl border"
        aria-labelledby="bucket-storage-title"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b p-5">
          <div>
            <h2 id="bucket-storage-title" className="font-medium">
              Storage bucket
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Total object storage across all accounts.
            </p>
          </div>
          {region ? (
            <Badge variant="secondary">{region.toUpperCase()}</Badge>
          ) : null}
        </div>
        {bucketUsage.status === "notConfigured" ? (
          <p className="p-5 text-sm text-muted-foreground">
            This environment uses local storage. Bucket totals appear when S3 is
            configured.
          </p>
        ) : (
          <>
            <dl className="grid gap-5 p-5 sm:grid-cols-2 xl:grid-cols-3">
              <StorageMetric
                label="Bucket used"
                value={
                  bucketReady
                    ? formatStorageBytes(bucketUsage.usage.usedBytes)
                    : "—"
                }
              />
              <StorageMetric
                label="Objects"
                value={
                  bucketReady
                    ? bucketUsage.usage.objectCount.toLocaleString("en")
                    : "—"
                }
              />
              <div className="min-w-0 sm:col-span-2 xl:col-span-1">
                <dt className="text-sm text-muted-foreground">Bucket</dt>
                <dd className="mt-2 break-all text-sm font-medium">
                  {bucketName}
                </dd>
                <dd className="mt-1 text-xs text-muted-foreground">
                  {provider}
                </dd>
              </div>
            </dl>
            <div
              className="flex flex-wrap justify-between gap-2 border-t px-5 py-3 text-xs text-muted-foreground"
              role="status"
            >
              <span>
                {bucketUsage.status === "loading"
                  ? "Measuring bucket usage…"
                  : bucketUsage.status === "unavailable"
                    ? "Bucket usage is temporarily unavailable. We’ll retry shortly."
                    : bucketReady && bucketUsage.stale
                      ? "Showing the last measurement. The latest refresh failed."
                      : bucketReady && bucketUsage.refreshing
                        ? "Updating bucket measurement…"
                        : bucketReady
                          ? `Measured at ${measurementTime.format(bucketUsage.usage.measuredAt)} UTC`
                          : null}
              </span>
              <span>Completed objects · Refreshes every minute</span>
            </div>
          </>
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

function StorageMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-2 font-display text-2xl font-semibold tabular-nums">
        {value}
      </dd>
    </div>
  );
}
