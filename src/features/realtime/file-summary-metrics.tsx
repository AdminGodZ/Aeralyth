"use client";

import {
  FileText,
  Folder,
  HardDrive,
  type LucideIcon,
  Share2,
  Star,
} from "lucide-react";
import { formatBytes } from "@/lib/format";
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
    <div className="dashboard-card p-5">
      <p className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </p>
      <p className="mt-4 truncate text-[1.625rem] leading-8 font-semibold tracking-tight tabular-nums">
        {value}
      </p>
    </div>
  );
}
