import {
  filterGitIgnoredSelections,
  type GitIgnoreSelection,
} from "@/features/dashboard/gitignore-filter";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_SELECTION_FILES = 1000;

type UploadSelectionLike = {
  file: {
    name: string;
    size: number;
  };
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
>(
  selections: readonly T[],
): Promise<{
  files: T[];
  ignoredFiles: number;
  error: string | null;
}> {
  const files = await filterGitIgnoredSelections(selections);
  return {
    files,
    ignoredFiles: selections.length - files.length,
    error: getUploadSelectionError(files, false),
  };
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
