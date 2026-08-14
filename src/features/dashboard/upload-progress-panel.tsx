"use client";

import {
  Check,
  CircleAlert,
  Clock3,
  File,
  LoaderCircle,
  ShieldCheck,
  X,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export type UploadProgressItem = {
  name: string;
  path: string;
  sizeBytes: number;
};

export type UploadProgressSession = {
  items: UploadProgressItem[];
  ignoredFiles: number;
  totalBytes: number;
  uploadedBytes: number;
  completedFiles: number;
  activeFileIndex: number | null;
  activeFileUploadedBytes: number;
  startedAt: number;
  updatedAt: number;
  status: "uploading" | "failed";
  error: string | null;
};

export function UploadProgressPanel({
  session,
  onCancel,
  onDismiss,
}: {
  session: UploadProgressSession;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const failed = session.status === "failed";
  const [open, setOpen] = useState(failed);
  const activeItem =
    session.activeFileIndex === null
      ? null
      : (session.items[session.activeFileIndex] ?? null);
  const percentage = getUploadPercentage(session);
  const activeFilePercentage = getActiveFilePercentage(session, activeItem);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "flex w-[22rem] max-w-[calc(100vw-2rem)] items-center overflow-hidden rounded-xl border bg-background/95 shadow-lg shadow-black/10 backdrop-blur-sm transition-colors sm:w-[26rem]",
          failed ? "border-destructive/40" : "border-border/80",
        )}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className="group min-w-0 flex-1 px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            aria-label={
              failed ? "Show upload failure details" : "Show upload details"
            }
          >
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full",
                  failed
                    ? "bg-destructive/10 text-destructive"
                    : "bg-primary/10 text-primary",
                )}
              >
                {failed ? (
                  <CircleAlert className="size-4" aria-hidden="true" />
                ) : (
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                )}
              </span>

              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {getHeadline(session, activeItem)}
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {formatCompletedFiles(session)} ·{" "}
                  {formatBytes(session.uploadedBytes)} of{" "}
                  {formatBytes(session.totalBytes)}
                </span>
                <span className="mt-2 flex items-center gap-2.5">
                  <Progress
                    value={percentage}
                    className={cn(
                      "h-1 flex-1",
                      failed
                        ? "bg-destructive/15 [&_[data-slot=progress-indicator]]:bg-destructive"
                        : undefined,
                    )}
                    aria-label={`Upload ${Math.round(percentage)}% complete`}
                  />
                  <span
                    className={cn(
                      "min-w-8 shrink-0 text-right text-xs font-medium tabular-nums",
                      failed ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {failed ? "Failed" : `${Math.round(percentage)}%`}
                  </span>
                </span>
              </span>
            </div>
          </button>
        </PopoverTrigger>

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="mr-2 shrink-0 rounded-lg"
          onClick={failed ? onDismiss : onCancel}
          aria-label={failed ? "Dismiss upload failure" : "Cancel upload"}
          title={failed ? "Dismiss" : "Cancel upload"}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <PopoverContent
        align="end"
        sideOffset={10}
        className="max-h-[min(42rem,var(--radix-popover-content-available-height))] w-[28rem] max-w-[calc(100vw-1.5rem)] overflow-y-auto overscroll-contain rounded-xl p-0 shadow-xl"
      >
        <div className="border-b px-4 py-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold">
                {failed ? "Upload needs attention" : "Upload in progress"}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatCompletedFiles(session)}
              </p>
            </div>
            <span
              className={cn(
                "rounded-full px-2 py-1 text-xs font-medium tabular-nums",
                failed
                  ? "bg-destructive/10 text-destructive"
                  : "bg-primary/10 text-primary",
              )}
            >
              {failed ? "Stopped" : `${Math.round(percentage)}%`}
            </span>
          </div>
        </div>

        <div className="space-y-4 p-4">
          {failed && session.error ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3"
            >
              <div className="flex items-start gap-2.5">
                <CircleAlert
                  className="mt-0.5 size-4 shrink-0 text-destructive"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-destructive">
                    {activeItem?.name ?? "The upload could not finish"}
                  </p>
                  <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
                    {session.error}
                  </p>
                  {session.completedFiles > 0 ? (
                    <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                      {formatCompletedFiles(session)} before this error. Those
                      completed files remain in Aeralyth.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="flex items-end justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {activeItem?.name ??
                    (session.completedFiles === session.items.length
                      ? "Finalizing upload"
                      : "Preparing files")}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {activeItem?.path ?? "Checking the uploaded objects"}
                </p>
              </div>
              <p className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {activeItem
                  ? `${formatBytes(session.activeFileUploadedBytes)} / ${formatBytes(activeItem.sizeBytes)}`
                  : formatBytes(session.uploadedBytes)}
              </p>
            </div>
            <Progress
              value={activeFilePercentage}
              aria-label={
                activeItem
                  ? `${activeItem.name} upload progress`
                  : "Upload finalization progress"
              }
            />
          </div>

          <UploadMetrics session={session} />

          {session.ignoredFiles > 0 ? (
            <div className="flex items-start gap-2.5 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5">
              <ShieldCheck
                className="mt-0.5 size-4 shrink-0 text-primary"
                aria-hidden="true"
              />
              <p className="text-xs leading-5 text-muted-foreground">
                <span className="font-medium text-foreground">
                  {session.ignoredFiles.toLocaleString()}{" "}
                  {session.ignoredFiles === 1 ? "file" : "files"} excluded.
                </span>{" "}
                Left out during folder review or removed as Git metadata.
              </p>
            </div>
          ) : null}

          <UploadActivityList session={session} />
        </div>

        <div className="flex items-center justify-between gap-3 border-t bg-muted/20 px-4 py-3">
          <p className="text-[11px] text-muted-foreground" aria-live="polite">
            {failed
              ? "Review the failed file before trying the folder again."
              : "You can keep working while this finishes."}
          </p>
          <Button
            type="button"
            variant={failed ? "default" : "secondary"}
            size="sm"
            className="shrink-0 rounded-lg"
            onClick={failed ? onDismiss : onCancel}
          >
            {failed ? "Done" : "Cancel upload"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function UploadMetrics({ session }: { session: UploadProgressSession }) {
  const elapsedSeconds = Math.max(
    0.001,
    (session.updatedAt - session.startedAt) / 1000,
  );
  const bytesPerSecond = session.uploadedBytes / elapsedSeconds;
  const remainingBytes = Math.max(
    0,
    session.totalBytes - session.uploadedBytes,
  );
  const etaSeconds =
    bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : null;

  return (
    <dl className="grid grid-cols-3 divide-x rounded-lg border bg-muted/15 py-2.5">
      <Metric
        label="Files"
        value={`${session.completedFiles}/${session.items.length}`}
      />
      <Metric
        label="Speed"
        value={
          bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : "Starting"
        }
      />
      <Metric
        label="Remaining"
        value={etaSeconds === null ? "Calculating" : formatDuration(etaSeconds)}
        icon={<Clock3 className="size-3" aria-hidden="true" />}
      />
    </dl>
  );
}

function Metric({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 px-2.5 first:pl-3 last:pr-3">
      <dt className="flex items-center gap-1 truncate text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-xs font-medium tabular-nums">
        {value}
      </dd>
    </div>
  );
}

function UploadActivityList({ session }: { session: UploadProgressSession }) {
  const { start, end } = getVisibleItemWindow(session);
  const visibleItems = session.items.slice(start, end);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs font-medium">File activity</p>
        <p className="text-[11px] text-muted-foreground">
          {session.items.length.toLocaleString()} total
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border">
        {start > 0 ? (
          <p className="border-b bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
            {start.toLocaleString()} earlier {start === 1 ? "file" : "files"}
          </p>
        ) : null}
        {visibleItems.map((item, offset) => {
          const index = start + offset;
          return (
            <UploadActivityRow
              key={`${item.path}:${String(index)}`}
              item={item}
              index={index}
              session={session}
            />
          );
        })}
        {end < session.items.length ? (
          <p className="border-t bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
            {(session.items.length - end).toLocaleString()} more queued
          </p>
        ) : null}
      </div>
    </div>
  );
}

function UploadActivityRow({
  item,
  index,
  session,
}: {
  item: UploadProgressItem;
  index: number;
  session: UploadProgressSession;
}) {
  const completed = index < session.completedFiles;
  const active = index === session.activeFileIndex;
  const failed = active && session.status === "failed";
  const statusLabel = completed
    ? "Uploaded"
    : failed
      ? "Failed"
      : active
        ? "Uploading"
        : "Queued";

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 px-3 py-2.5 not-last:border-b",
        active ? "bg-primary/5" : "bg-card",
      )}
    >
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full",
          completed
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : failed
              ? "bg-destructive/10 text-destructive"
              : active
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground",
        )}
      >
        {completed ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : failed ? (
          <CircleAlert className="size-3.5" aria-hidden="true" />
        ) : active ? (
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <File className="size-3.5" aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{item.name}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {item.path}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span
          className={cn(
            "block text-[11px]",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {statusLabel}
        </span>
        <span className="block text-[10px] tabular-nums text-muted-foreground">
          {formatBytes(item.sizeBytes)}
        </span>
      </span>
    </div>
  );
}

function getVisibleItemWindow(session: UploadProgressSession) {
  const maximumVisibleItems = 7;
  const anchor =
    session.activeFileIndex ?? Math.max(0, session.completedFiles - 1);
  const latestStart = Math.max(0, session.items.length - maximumVisibleItems);
  const start = Math.min(Math.max(0, anchor - 2), latestStart);

  return {
    start,
    end: Math.min(session.items.length, start + maximumVisibleItems),
  };
}

function getUploadPercentage(session: UploadProgressSession) {
  if (session.totalBytes > 0) {
    const bytesPercentage = (session.uploadedBytes / session.totalBytes) * 100;
    return session.status === "uploading" &&
      session.completedFiles < session.items.length
      ? Math.min(99, bytesPercentage)
      : Math.min(100, bytesPercentage);
  }
  if (session.items.length === 0) {
    return 0;
  }

  return Math.min(100, (session.completedFiles / session.items.length) * 100);
}

function getActiveFilePercentage(
  session: UploadProgressSession,
  activeItem: UploadProgressItem | null,
) {
  if (!activeItem) {
    return getUploadPercentage(session);
  }
  if (activeItem.sizeBytes <= 0) {
    return session.status === "failed" ? 0 : 100;
  }

  const percentage =
    (session.activeFileUploadedBytes / activeItem.sizeBytes) * 100;
  return session.status === "uploading" ? Math.min(99, percentage) : percentage;
}

function getHeadline(
  session: UploadProgressSession,
  activeItem: UploadProgressItem | null,
) {
  if (session.status === "failed") {
    return activeItem?.name ?? "Upload could not finish";
  }
  if (activeItem) {
    return activeItem.name;
  }
  if (session.completedFiles === session.items.length) {
    return "Finalizing upload";
  }

  return "Preparing upload";
}

function formatCompletedFiles(session: UploadProgressSession) {
  const total = session.items.length;
  const completed = Math.min(session.completedFiles, total);

  return `${completed.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? "file" : "files"}`;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 1) {
    return "< 1 sec";
  }
  if (seconds < 60) {
    return `~${Math.ceil(seconds)} sec`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.ceil(seconds % 60);
  return remainingSeconds > 0
    ? `~${minutes}m ${remainingSeconds}s`
    : `~${minutes} min`;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let unitIndex = 0;
  let size = value;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const formattedSize =
    size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1);

  return `${formattedSize} ${units[unitIndex]}`;
}
