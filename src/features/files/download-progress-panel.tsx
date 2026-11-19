"use client";

import { FileDown, FolderArchive, LoaderCircle, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { popupSurfaceClassName } from "@/components/ui/popup-surface";
import { Progress } from "@/components/ui/progress";
import type { FolderArchiveProgress } from "@/features/files/folder-archive";
import { cn } from "@/lib/utils";

export type DownloadProgress = FolderArchiveProgress;

export function DownloadProgressPanel({
  fileName,
  kind,
  progress,
  onCancel,
}: {
  fileName: string;
  kind: "file" | "folder";
  progress: DownloadProgress;
  onCancel(): void;
}) {
  const percentage = progress.percentage;
  const roundedPercentage = percentage === null ? null : Math.round(percentage);
  const DoneIcon = kind === "folder" ? FolderArchive : FileDown;

  return (
    <div
      className={cn(
        "flex w-[22rem] max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl px-3 py-2.5 shadow-lg shadow-black/10 sm:w-[26rem]",
        popupSurfaceClassName,
      )}
      role="status"
      aria-live="polite"
      aria-label={`Preparing ${fileName} for download`}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        {percentage === 100 ? (
          <DoneIcon className="size-4" aria-hidden="true" />
        ) : (
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{fileName}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {progress.label}
        </p>
        <div className="mt-2 flex items-center gap-2.5">
          <Progress
            value={percentage}
            className="h-1 flex-1"
            aria-label={
              roundedPercentage === null
                ? "Preparing download"
                : `Download ${roundedPercentage}% complete`
            }
          />
          <span className="min-w-8 shrink-0 text-right text-xs font-medium tabular-nums text-muted-foreground">
            {roundedPercentage === null ? "…" : `${roundedPercentage}%`}
          </span>
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0 rounded-lg"
        onClick={onCancel}
        aria-label="Cancel download"
        title="Cancel download"
      >
        <X className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
