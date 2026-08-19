"use client";

import { File as FileIcon, Folder, Search, ShieldAlert } from "lucide-react";
import { useDeferredValue, useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  getUploadSelectionError,
  type UploadExclusionReviewItem,
} from "@/features/dashboard/upload-selection-policy";

export type UploadExclusionReviewFile = {
  file: File;
  relativePath: string;
};

const INITIAL_VISIBLE_ITEMS = 200;

export function UploadExclusionReviewDialog({
  items,
  autoIncludedFiles,
  gitIgnoreFileCount,
  onClose,
  onContinue,
}: {
  items: UploadExclusionReviewItem<UploadExclusionReviewFile>[];
  autoIncludedFiles: UploadExclusionReviewFile[];
  gitIgnoreFileCount: number;
  onClose: () => void;
  onContinue: (selectedFiles: UploadExclusionReviewFile[]) => void;
}) {
  const idPrefix = useId().replaceAll(":", "");
  const [includedItemIndexes, setIncludedItemIndexes] = useState(
    () => new Set<number>(),
  );
  const [query, setQuery] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_VISIBLE_ITEMS);
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();
  const matchingItems = useMemo(
    () =>
      items.flatMap((item, index) =>
        !normalizedQuery ||
        item.path.toLocaleLowerCase().includes(normalizedQuery)
          ? [{ item, index }]
          : [],
      ),
    [items, normalizedQuery],
  );
  const visibleItems = matchingItems.slice(0, visibleLimit);
  const selectedFiles = useMemo(
    () =>
      items.flatMap((item, index) =>
        includedItemIndexes.has(index) ? item.files : [],
      ),
    [includedItemIndexes, items],
  );
  const effectiveFiles = useMemo(
    () => [...autoIncludedFiles, ...selectedFiles],
    [autoIncludedFiles, selectedFiles],
  );
  const selectionError =
    effectiveFiles.length === 0
      ? "Choose at least one excluded file or folder to include."
      : getUploadSelectionError(effectiveFiles, false);
  const reviewFileCount = items.reduce(
    (total, item) => total + item.files.length,
    0,
  );
  const excludedFileCount = reviewFileCount - selectedFiles.length;
  const hasHiddenFolders = items.some(
    (item) => item.reason === "hidden-folder",
  );

  function setItemIncluded(index: number, included: boolean) {
    setIncludedItemIndexes((current) => {
      const next = new Set(current);
      if (included) {
        next.add(index);
      } else {
        next.delete(index);
      }
      return next;
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] gap-4 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review upload exclusions</DialogTitle>
          <DialogDescription>
            {formatExclusionDescription(hasHiddenFolders, gitIgnoreFileCount)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-md"
            onClick={() => setIncludedItemIndexes(new Set(items.keys()))}
          >
            Include all
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="rounded-md"
            onClick={() => setIncludedItemIndexes(new Set())}
          >
            Exclude all
          </Button>
        </div>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Find an excluded file or folder…"
            aria-label="Find an excluded file or folder"
            className="h-9 pl-9"
          />
        </div>

        <div className="min-h-0 overflow-hidden rounded-lg border">
          <div className="flex items-center justify-between gap-4 border-b bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <span>
              {formatCount(autoIncludedFiles.length, "file", "files")} included
              automatically
            </span>
            <span>
              {formatCount(reviewFileCount, "excluded file", "excluded files")}
            </span>
          </div>
          <div className="max-h-[min(44dvh,28rem)] overflow-y-auto overscroll-contain">
            {visibleItems.length > 0 ? (
              <ul className="divide-y" aria-label="Excluded upload items">
                {visibleItems.map(({ item, index }) => {
                  const included = includedItemIndexes.has(index);
                  const checkboxId = `${idPrefix}-excluded-item-${String(index)}`;
                  const Icon = item.kind === "folder" ? Folder : FileIcon;

                  return (
                    <li
                      key={`${item.kind}:${item.path}`}
                      className="[contain-intrinsic-size:0_62px] [content-visibility:auto]"
                    >
                      <label
                        htmlFor={checkboxId}
                        className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/20"
                      >
                        <Checkbox
                          id={checkboxId}
                          checked={included}
                          onCheckedChange={(checked) =>
                            setItemIncluded(index, checked === true)
                          }
                          aria-label={`Include ${item.path}`}
                        />
                        <Icon
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {item.path}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {item.kind === "folder"
                              ? `${formatCount(item.files.length, "file", "files")} · `
                              : ""}
                            {formatFileBytes(item.sizeBytes)} ·{" "}
                            {item.reason === "hidden-folder"
                              ? "hidden folder"
                              : "ignored by .gitignore"}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs font-medium text-muted-foreground">
                          {included ? "Include" : "Exclude"}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                No excluded items match “{query}”.
              </p>
            )}

            {matchingItems.length > visibleItems.length ? (
              <div className="flex justify-center border-t p-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setVisibleLimit(
                      (current) => current + INITIAL_VISIBLE_ITEMS,
                    )
                  }
                >
                  Show more excluded items
                </Button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2.5">
          <ShieldAlert
            className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          <p className="text-xs leading-5 text-muted-foreground">
            Hidden folders and files such as .env may contain secrets or
            repository metadata. Include them only if you intend to store them
            in Aeralyth.
          </p>
        </div>

        <div aria-live="polite">
          {selectionError ? (
            <p role="alert" className="text-xs text-destructive">
              {selectionError}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {formatCount(
                selectedFiles.length,
                "excluded file",
                "excluded files",
              )}{" "}
              added · {formatCount(excludedFileCount, "file", "files")} will
              remain excluded
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            className="rounded-md"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="rounded-md"
            disabled={Boolean(selectionError)}
            onClick={() => onContinue(selectedFiles)}
          >
            Continue with {effectiveFiles.length.toLocaleString()}{" "}
            {effectiveFiles.length === 1 ? "file" : "files"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatExclusionDescription(
  hasHiddenFolders: boolean,
  gitIgnoreFileCount: number,
) {
  if (hasHiddenFolders && gitIgnoreFileCount > 0) {
    return `Hidden folders and items matched by ${formatCount(
      gitIgnoreFileCount,
      ".gitignore file",
      ".gitignore files",
    )} are excluded by default.`;
  }
  if (hasHiddenFolders) {
    return "Hidden folders are excluded by default.";
  }
  return `Items matched by ${formatCount(
    gitIgnoreFileCount,
    ".gitignore file",
    ".gitignore files",
  )} are excluded by default.`;
}

function formatCount(value: number, singular: string, plural: string) {
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}

function formatFileBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let unitIndex = 0;
  let size = value;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const precision = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}
