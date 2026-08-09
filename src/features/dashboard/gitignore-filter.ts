import ignore, { type Ignore } from "ignore";

export type GitIgnoreSelection = {
  file: File;
  relativePath: string;
};

type NormalizedSelection<T extends GitIgnoreSelection> = {
  selection: T;
  path: string;
};

type IgnoreMatcher = {
  directory: string;
  matcher: Ignore;
};

export async function filterGitIgnoredSelections<T extends GitIgnoreSelection>(
  selections: readonly T[],
): Promise<T[]> {
  if (selections.length === 0) {
    return [];
  }

  const normalizedSelections = normalizeSelections(selections);
  const uploadableSelections = normalizedSelections.filter(
    ({ path }) => !isGitMetadataPath(path),
  );
  const ignoreFiles = uploadableSelections.filter(
    ({ path }) => baseName(path) === ".gitignore",
  );

  if (ignoreFiles.length === 0) {
    return uploadableSelections.map(({ selection }) => selection);
  }

  ignoreFiles.sort((left, right) => {
    const leftDirectory = parentDirectory(left.path);
    const rightDirectory = parentDirectory(right.path);
    const depth = pathDepth(leftDirectory) - pathDepth(rightDirectory);
    return depth || leftDirectory.localeCompare(rightDirectory);
  });

  const activeMatchers: IgnoreMatcher[] = [];
  for (const { selection, path } of ignoreFiles) {
    const directory = parentDirectory(path);
    if (directory && isIgnored(directory, true, activeMatchers)) {
      continue;
    }

    let patterns: string;
    try {
      patterns = await selection.file.text();
    } catch {
      throw new Error(
        `Aeralyth could not read ${selection.relativePath}; the folder was not uploaded.`,
      );
    }
    activeMatchers.push({ directory, matcher: ignore().add(patterns) });
  }

  return uploadableSelections.flatMap(({ selection, path }) =>
    isIgnored(path, false, activeMatchers) ? [] : [selection],
  );
}

function isGitMetadataPath(path: string): boolean {
  return path.split("/").includes(".git");
}

function normalizeSelections<T extends GitIgnoreSelection>(
  selections: readonly T[],
): NormalizedSelection<T>[] {
  const paths = selections.map(({ relativePath, file }) =>
    normalizePath(relativePath || file.name),
  );
  const selectionRoot = getSelectionRoot(paths);

  return selections.map((selection, index) => {
    const path = paths[index];
    if (!path) {
      throw new Error("The selected folder contains an invalid path.");
    }

    return {
      selection,
      path: selectionRoot ? path.slice(selectionRoot.length + 1) : path,
    };
  });
}

function getSelectionRoot(paths: string[]): string | null {
  const roots = new Set(paths.map((path) => path.split("/", 1)[0]));
  if (roots.size !== 1 || paths.some((path) => !path.includes("/"))) {
    return null;
  }

  return Array.from(roots)[0] ?? null;
}

function normalizePath(path: string): string {
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

function isIgnored(
  path: string,
  isDirectory: boolean,
  matchers: IgnoreMatcher[],
): boolean {
  const segments = path.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const directory = segments.slice(0, index).join("/");
    if (testPath(directory, true, matchers)) {
      return true;
    }
  }

  return testPath(path, isDirectory, matchers);
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

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function baseName(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? path : path.slice(separator + 1);
}

function pathDepth(path: string): number {
  return path ? path.split("/").length : 0;
}
