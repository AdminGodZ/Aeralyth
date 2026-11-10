import {
  type GitIgnoreSelection,
  type GitIgnoreSelectionPartition,
  partitionGitIgnoredSelections,
} from "@/features/dashboard/gitignore-filter";
import {
  baseName,
  parentDirectory,
  shallowestDirectoryLookup,
} from "@/lib/paths";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_SELECTION_FILES = 5000;

const SIZE_MEASUREMENT_SLICE_MS = 8;
const SIZE_MEASUREMENT_REPORT_INTERVAL_MS = 100;

type UploadSelectionLike = {
  file: {
    name: string;
    size: number;
  };
};

export type PreparedFolderUploadSelection<T extends GitIgnoreSelection> = {
  files: T[];
  uploadableFiles: T[];
  excludedFiles: T[];
  reviewItems: UploadExclusionReviewItem<T>[];
  gitIgnoreFileCount: number;
  error: string | null;
};

export type UploadExclusionReviewItem<T extends GitIgnoreSelection> = {
  kind: "file" | "folder";
  path: string;
  files: T[];
  reason: "gitignore" | "hidden-folder";
};

export function getUploadSelectionCountError(
  fileCount: number,
  requiresSingleFile: boolean,
): string | null {
  if (!Number.isSafeInteger(fileCount) || fileCount < 0) {
    return "The selected files could not be read.";
  }
  if (fileCount > MAX_SELECTION_FILES) {
    return `Choose no more than ${MAX_SELECTION_FILES.toLocaleString()} files at once.`;
  }
  if (requiresSingleFile && fileCount !== 1) {
    return "Choose exactly one file to replace the shared file.";
  }
  return null;
}

export async function prepareFolderUploadSelection<
  T extends GitIgnoreSelection,
>(selections: readonly T[]): Promise<PreparedFolderUploadSelection<T>> {
  const partition = await partitionGitIgnoredSelections(selections);
  const includedSelections = new Set(partition.includedSelections);

  return {
    files: partition.includedSelections,
    uploadableFiles: [...selections],
    excludedFiles: selections.filter(
      (selection) => !includedSelections.has(selection),
    ),
    reviewItems: buildUploadExclusionReviewItems(partition),
    gitIgnoreFileCount: partition.gitIgnoreFileCount,
    error: getUploadSelectionError(partition.includedSelections, false),
  };
}

export function finalizeFolderUploadSelection<T extends GitIgnoreSelection>(
  prepared: PreparedFolderUploadSelection<T>,
  selectedFiles: readonly T[],
): {
  files: T[];
  ignoredFiles: number;
  error: string | null;
} {
  const excludedSelections = new Set(prepared.excludedFiles);
  const selectedExcludedSelections = new Set(
    selectedFiles.filter((selection) => excludedSelections.has(selection)),
  );
  const includedSelections = new Set([
    ...prepared.files,
    ...selectedExcludedSelections,
  ]);
  const files = prepared.uploadableFiles.filter((selection) =>
    includedSelections.has(selection),
  );

  return {
    files,
    ignoredFiles:
      prepared.excludedFiles.length - selectedExcludedSelections.size,
    error:
      files.length === 0
        ? "Choose at least one file to upload."
        : getUploadSelectionError(files, false),
  };
}

/**
 * Sums each review item's bytes while the review is open. A browser stats a
 * picked file the first time its size is read, which takes seconds across an
 * ignored dependency folder, so the work runs in short slices that keep the
 * page responsive instead of holding the review back.
 */
export async function measureUploadExclusionReviewItems<
  T extends GitIgnoreSelection,
>(
  items: readonly UploadExclusionReviewItem<T>[],
  onMeasured: (
    sizes: ReadonlyMap<UploadExclusionReviewItem<T>, number>,
  ) => void,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;

  const sizes = new Map<UploadExclusionReviewItem<T>, number>();
  let reportedCount = 0;
  let reportedAt = Number.NEGATIVE_INFINITY;
  let sliceEndsAt = performance.now() + SIZE_MEASUREMENT_SLICE_MS;
  // Smallest first, so most rows are filled in before a large folder is summed.
  const pendingItems = [...items].sort(
    (left, right) => left.files.length - right.files.length,
  );

  for (const item of pendingItems) {
    let sizeBytes = 0;
    for (const { file } of item.files) {
      sizeBytes += file.size;
      if (performance.now() < sliceEndsAt) continue;

      if (
        sizes.size > reportedCount &&
        performance.now() - reportedAt >= SIZE_MEASUREMENT_REPORT_INTERVAL_MS
      ) {
        onMeasured(new Map(sizes));
        reportedCount = sizes.size;
        reportedAt = performance.now();
      }
      // The next slice waits for the page, so it cannot start any earlier.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await yieldToPage();
      if (signal.aborted) return;
      sliceEndsAt = performance.now() + SIZE_MEASUREMENT_SLICE_MS;
    }
    sizes.set(item, sizeBytes);
  }

  if (sizes.size > reportedCount) {
    onMeasured(sizes);
  }
}

// A plain task, so rendering, input, and React's own scheduled work run between slices.
function yieldToPage(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

function buildUploadExclusionReviewItems<T extends GitIgnoreSelection>({
  includedSelections,
  ignoredSelections,
  hiddenDirectorySelections,
  rootRelativePaths,
}: GitIgnoreSelectionPartition<T>): UploadExclusionReviewItem<T>[] {
  const includedDirectories = new Set<string>();
  for (const selection of includedSelections) {
    let directory = parentDirectory(rootRelativePaths.get(selection) ?? "");
    while (directory && !includedDirectories.has(directory)) {
      includedDirectories.add(directory);
      directory = parentDirectory(directory);
    }
  }

  const items = new Map<string, UploadExclusionReviewItem<T>>();
  function addToItem(
    selection: T,
    folder: string | null,
    reason: UploadExclusionReviewItem<T>["reason"],
  ) {
    const kind = folder === null ? "file" : "folder";
    const path = folder ?? rootRelativePaths.get(selection) ?? "";
    if (!path) return;

    const key = `${kind}:${path}`;
    const existing = items.get(key);
    if (existing) {
      existing.files.push(selection);
      if (reason === "hidden-folder") {
        existing.reason = reason;
      }
    } else {
      items.set(key, { kind, path, files: [selection], reason });
    }
  }

  // A wholly ignored folder is reviewed as one item; ignored files that sit
  // beside included ones stay separate.
  const ignoredFolder = shallowestDirectoryLookup(
    (directory) => !includedDirectories.has(directory),
  );
  for (const selection of ignoredSelections) {
    const path = rootRelativePaths.get(selection) ?? "";
    addToItem(selection, ignoredFolder(parentDirectory(path)), "gitignore");
  }

  const hiddenFolder = shallowestDirectoryLookup((directory) =>
    baseName(directory).startsWith("."),
  );
  for (const selection of hiddenDirectorySelections) {
    const path = rootRelativePaths.get(selection) ?? "";
    addToItem(selection, hiddenFolder(parentDirectory(path)), "hidden-folder");
  }

  return Array.from(items.values()).sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

export function getUploadSelectionError(
  selections: readonly UploadSelectionLike[],
  requiresSingleFile: boolean,
): string | null {
  const countError = getUploadSelectionCountError(
    selections.length,
    requiresSingleFile,
  );
  if (countError) return countError;

  for (const { file } of selections) {
    if (file.size > MAX_UPLOAD_BYTES) {
      return `${file.name} exceeds the 2 GB upload limit.`;
    }
  }
  return null;
}
