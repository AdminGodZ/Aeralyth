"use client";

import {
  FileText,
  Folder,
  HardDrive,
  type LucideIcon,
  Share2,
  Star,
} from "lucide-react";
import { useFileSummary } from "./realtime-provider";
import type { FileSummary } from "./summary-resource";

export function FileSummaryMetrics({
  initialSummary,
}: {
  initialSummary: FileSummary;
}) {
  const summary = useFileSummary(initialSummary);
  return (
    <div className="shrink-0 space-y-2">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <FileMetric
          icon={FileText}
          label="Files"
          value={String(summary.totalFiles)}
        />
        <FileMetric
          icon={Folder}
          label="Folders"
          value={String(summary.totalFolders)}
        />
        <FileMetric
          icon={Star}
          label="Favorites"
          value={String(summary.favoriteFiles)}
        />
        <FileMetric
          icon={Share2}
          label="Shared with me"
          value={String(summary.sharedFiles)}
        />
        <FileMetric
          icon={HardDrive}
          label="Storage used"
          value={formatBytes(summary.usedBytes)}
        />
      </div>
      {summary.treeOperationPending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Updating files…
        </p>
      ) : null}
    </div>
  );
}

function FileMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="grid h-24 grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-3 rounded-md border px-4">
      <span className="flex size-10 items-center justify-center text-primary">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-col justify-center">
        <p className="truncate text-sm leading-5 text-muted-foreground">
          {label}
        </p>
        <p className="mt-0.5 truncate font-display text-2xl font-semibold leading-7 tabular-nums">
          {value}
        </p>
      </div>
    </div>
  );
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

  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${
    units[unitIndex]
  }`;
}
