import {
  type GitIgnoreSelection,
  partitionGitIgnoredSelections,
} from "@/features/dashboard/gitignore-filter";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_SELECTION_FILES = 5000;

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
  sizeBytes: number;
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
  const excludedSelectionSet = new Set([
    ...partition.ignoredSelections,
    ...partition.hiddenDirectorySelections,
  ]);
  const excludedFiles = selections.filter((selection) =>
    excludedSelectionSet.has(selection),
  );
  const uploadableSelections = new Set([
    ...partition.includedSelections,
    ...excludedFiles,
  ]);
  const uploadableFiles = selections.filter((selection) =>
    uploadableSelections.has(selection),
  );

  return {
    files: partition.includedSelections,
    uploadableFiles,
    excludedFiles,
    reviewItems: buildUploadExclusionReviewItems(
      uploadableFiles,
      partition.includedSelections,
      partition.ignoredSelections,
      partition.hiddenDirectorySelections,
    ),
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

function buildUploadExclusionReviewItems<T extends GitIgnoreSelection>(
  uploadableFiles: readonly T[],
  includedFiles: readonly T[],
  gitIgnoredFiles: readonly T[],
  hiddenDirectoryFiles: readonly T[],
): UploadExclusionReviewItem<T>[] {
  const paths = getRootRelativePaths(uploadableFiles);
  const pathsBySelection = new Map(
    uploadableFiles.map((selection, index) => [selection, paths[index] ?? ""]),
  );
  const hiddenDirectoryFileSet = new Set(hiddenDirectoryFiles);
  const includedDirectories = new Set<string>();
  for (const selection of includedFiles) {
    const path = pathsBySelection.get(selection);
    if (!path) continue;
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      includedDirectories.add(segments.slice(0, depth).join("/"));
    }
  }

  const items = new Map<string, UploadExclusionReviewItem<T>>();
  for (const selection of [...gitIgnoredFiles, ...hiddenDirectoryFiles]) {
    const path = pathsBySelection.get(selection);
    if (!path) continue;
    const segments = path.split("/");
    let kind: UploadExclusionReviewItem<T>["kind"] = "file";
    let itemPath = path;
    let reason: UploadExclusionReviewItem<T>["reason"] = "gitignore";
    if (hiddenDirectoryFileSet.has(selection)) {
      const hiddenDirectoryIndex = segments
        .slice(0, -1)
        .findIndex((segment) => segment.startsWith("."));
      if (hiddenDirectoryIndex >= 0) {
        kind = "folder";
        itemPath = segments.slice(0, hiddenDirectoryIndex + 1).join("/");
        reason = "hidden-folder";
      }
    } else {
      for (let depth = 1; depth < segments.length; depth += 1) {
        const directory = segments.slice(0, depth).join("/");
        if (!includedDirectories.has(directory)) {
          kind = "folder";
          itemPath = directory;
          break;
        }
      }
    }

    const key = `${kind}:${itemPath}`;
    const existing = items.get(key);
    if (existing) {
      existing.files.push(selection);
      existing.sizeBytes += selection.file.size;
      if (reason === "hidden-folder") {
        existing.reason = reason;
      }
    } else {
      items.set(key, {
        kind,
        path: itemPath,
        files: [selection],
        sizeBytes: selection.file.size,
        reason,
      });
    }
  }

  return Array.from(items.values()).sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function getRootRelativePaths<T extends GitIgnoreSelection>(
  selections: readonly T[],
) {
  const paths = selections.map(({ relativePath, file }) =>
    normalizeSelectionPath(relativePath || file.name),
  );
  const roots = new Set(paths.map((path) => path.split("/", 1)[0]));
  const selectionRoot =
    roots.size === 1 && paths.every((path) => path.includes("/"))
      ? (roots.values().next().value ?? null)
      : null;

  return paths.map((path) =>
    selectionRoot ? path.slice(selectionRoot.length + 1) : path,
  );
}

function normalizeSelectionPath(path: string) {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === "." || segment === ".." || segment.includes("\0"),
    )
  ) {
    throw new Error("The selected folder contains an invalid path.");
  }
  return segments.join("/");
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
