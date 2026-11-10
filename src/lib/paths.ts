export function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

export function baseName(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? path : path.slice(separator + 1);
}

/**
 * Returns a lookup for the shallowest directory on a path that satisfies
 * `matches`. Each directory is decided once, so the files that share a
 * directory cost a single map read instead of a walk up their ancestors.
 */
export function shallowestDirectoryLookup(
  matches: (directory: string) => boolean,
): (directory: string) => string | null {
  const resolved = new Map<string, string | null>([["", null]]);

  return function lookup(directory: string): string | null {
    const known = resolved.get(directory);
    if (known !== undefined) {
      return known;
    }

    const shallowest =
      lookup(parentDirectory(directory)) ??
      (matches(directory) ? directory : null);
    resolved.set(directory, shallowest);
    return shallowest;
  };
}
