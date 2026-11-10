import ignore, { type Ignore } from "ignore";
import {
  baseName,
  parentDirectory,
  shallowestDirectoryLookup,
} from "@/lib/paths";

export type GitIgnoreSelection = {
  file: File;
  relativePath: string;
};

type IgnoreMatcher = {
  directory: string;
  matcher: Ignore;
};

export type GitIgnoreSelectionPartition<T extends GitIgnoreSelection> = {
  includedSelections: T[];
  ignoredSelections: T[];
  hiddenDirectorySelections: T[];
  gitIgnoreFileCount: number;
  /** Every selection's normalized path below the selected folder. */
  rootRelativePaths: Map<T, string>;
};

// An empty, ".", or ".." segment anywhere in a path.
const UNNORMALIZED_SEGMENT = /(?:^|\/)\.{0,2}(?:\/|$)/;

export async function filterGitIgnoredSelections<T extends GitIgnoreSelection>(
  selections: readonly T[],
): Promise<T[]> {
  const partition = await partitionGitIgnoredSelections(selections);
  return partition.includedSelections;
}

export async function partitionGitIgnoredSelections<
  T extends GitIgnoreSelection,
>(selections: readonly T[]): Promise<GitIgnoreSelectionPartition<T>> {
  const rootRelativePaths = normalizeSelections(selections);
  const hiddenDirectory = shallowestDirectoryLookup((directory) =>
    baseName(directory).startsWith("."),
  );

  const ignoreFiles: { selection: T; directory: string }[] = [];
  for (const [selection, path] of rootRelativePaths) {
    if (baseName(path) !== ".gitignore") {
      continue;
    }
    const directory = parentDirectory(path);
    if (hiddenDirectory(directory) === null) {
      ignoreFiles.push({ selection, directory });
    }
  }
  ignoreFiles.sort((left, right) => {
    const depth = pathDepth(left.directory) - pathDepth(right.directory);
    return depth || left.directory.localeCompare(right.directory);
  });

  const matchers: IgnoreMatcher[] = [];
  // Rules only apply below their own directory and are read shallowest first,
  // so a directory decided while loading is never changed by rules read later.
  const ignoredDirectory = shallowestDirectoryLookup((directory) =>
    testPath(directory, true, matchers),
  );
  for (const { selection, directory } of ignoreFiles) {
    if (ignoredDirectory(directory) !== null) {
      continue;
    }

    let patterns: string;
    try {
      // Parent rules must be applied before deciding whether a nested .gitignore is reachable.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      patterns = await selection.file.text();
    } catch {
      throw new Error(
        `Aeralyth could not read ${selection.relativePath}; the folder was not uploaded.`,
      );
    }
    matchers.push({ directory, matcher: ignore().add(patterns) });
  }

  const includedSelections: T[] = [];
  const ignoredSelections: T[] = [];
  const hiddenDirectorySelections: T[] = [];
  for (const [selection, path] of rootRelativePaths) {
    const directory = parentDirectory(path);
    if (
      ignoredDirectory(directory) !== null ||
      testPath(path, false, matchers)
    ) {
      ignoredSelections.push(selection);
    } else if (hiddenDirectory(directory) !== null) {
      hiddenDirectorySelections.push(selection);
    } else {
      includedSelections.push(selection);
    }
  }

  return {
    includedSelections,
    ignoredSelections,
    hiddenDirectorySelections,
    gitIgnoreFileCount: ignoreFiles.length,
    rootRelativePaths,
  };
}

function normalizeSelections<T extends GitIgnoreSelection>(
  selections: readonly T[],
): Map<T, string> {
  const paths = selections.map(({ relativePath, file }) =>
    normalizePath(relativePath || file.name),
  );
  const selectionRoot = getSelectionRoot(paths);
  const prefixLength = selectionRoot === null ? 0 : selectionRoot.length + 1;

  return new Map(
    selections.map((selection, index) => [
      selection,
      paths[index].slice(prefixLength),
    ]),
  );
}

function getSelectionRoot(paths: string[]): string | null {
  const firstPath = paths[0];
  const separator = firstPath?.indexOf("/") ?? -1;
  if (firstPath === undefined || separator < 0) {
    return null;
  }

  const prefix = firstPath.slice(0, separator + 1);
  return paths.every((path) => path.startsWith(prefix))
    ? prefix.slice(0, -1)
    : null;
}

function normalizePath(path: string): string {
  // Browser folder picks are already normalized, so most paths skip the rebuild.
  if (
    !path.includes("\\") &&
    !path.includes("\0") &&
    !UNNORMALIZED_SEGMENT.test(path)
  ) {
    return path;
  }

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

function testPath(
  path: string,
  isDirectory: boolean,
  matchers: IgnoreMatcher[],
): boolean {
  let ignored = false;

  for (const { directory, matcher } of matchers) {
    const relativePath = relativeToDirectory(path, directory);
    if (!relativePath) {
      continue;
    }

    const result = matcher.test(
      isDirectory ? `${relativePath}/` : relativePath,
    );
    if (result.ignored) {
      ignored = true;
    } else if (result.unignored) {
      ignored = false;
    }
  }

  return ignored;
}

function relativeToDirectory(path: string, directory: string): string | null {
  if (!directory) {
    return path;
  }
  if (!path.startsWith(`${directory}/`)) {
    return null;
  }
  return path.slice(directory.length + 1);
}

function pathDepth(path: string): number {
  return path ? path.split("/").length : 0;
}
