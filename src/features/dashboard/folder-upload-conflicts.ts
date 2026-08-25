import {
  mapWithConcurrency,
  WeightedSemaphore,
} from "@/features/vault/bounded-async";

export const UPLOAD_PATH_LOOKUP_CONCURRENCY = 4;
export const UPLOAD_TREE_REQUEST_CONCURRENCY = 1;

export type UploadTreeEntry = {
  id: string;
  name: string;
  entryType: "file" | "folder";
  e2eeState: "legacy" | "staged" | "encrypted";
  generationNumber?: number;
  recordVersion?: number;
  recordHash?: string;
};

export type ExistingUploadNode = UploadTreeEntry;

export type FolderUploadResolution = {
  existingFolders: Map<string, ExistingUploadNode>;
  replacementFiles: Map<string, ExistingUploadNode>;
  conflictPaths: string[];
};

export class UploadPathConflictError extends Error {
  constructor(path: string, reason: "type" | "ambiguous") {
    super(
      reason === "type"
        ? `“${path}” already exists as a different item type. Rename it before uploading this folder.`
        : `More than one existing item matches “${path}”. Rename the duplicates before uploading this folder.`,
    );
    this.name = "UploadPathConflictError";
  }
}

export function folderUploadCreatesRepository(
  surface: "files" | "repositories" | "shared",
): boolean {
  return surface === "repositories";
}

export async function resolveFolderUploadConflicts({
  relativePaths,
  parentFolderId,
  loadChildren,
}: {
  relativePaths: string[];
  parentFolderId: string | null;
  loadChildren(parentId: string | null): Promise<UploadTreeEntry[]>;
}): Promise<FolderUploadResolution> {
  const filePaths = Array.from(
    new Set(
      relativePaths.flatMap((path) => {
        const normalized = normalizeUploadPath(path);
        return normalized ? [normalized] : [];
      }),
    ),
  );
  const folderPaths = collectFolderPaths(filePaths);
  const existingFolders = new Map<string, ExistingUploadNode>();
  const replacementFiles = new Map<string, ExistingUploadNode>();
  const childrenByParent = new Map<
    string,
    Promise<Map<string, UploadTreeEntry[]>>
  >();
  // Keep local path matching parallel, but align recursive API calls with the
  // backend's default per-user admission boundary so sibling lookups cannot
  // shed one another with 503 responses.
  const treeRequestSlots = new WeightedSemaphore(
    UPLOAD_TREE_REQUEST_CONCURRENCY,
  );

  const childrenFor = async (parentId: string | null) => {
    const cacheKey = parentId ?? "__root__";
    let pending = childrenByParent.get(cacheKey);
    if (!pending) {
      pending = treeRequestSlots.acquire().then(async (release) => {
        try {
          return indexChildren(await loadChildren(parentId));
        } finally {
          release();
        }
      });
      childrenByParent.set(cacheKey, pending);
    }
    return pending;
  };

  const foldersByDepth = groupFoldersByDepth(folderPaths);
  async function resolveFolderDepth(depthIndex: number): Promise<void> {
    const sameDepth = foldersByDepth[depthIndex];
    if (!sameDepth) return;
    await mapWithConcurrency(
      sameDepth,
      UPLOAD_PATH_LOOKUP_CONCURRENCY,
      async (folderPath) => {
        const parentPath = parentDirectory(folderPath);
        const parentId = parentPath
          ? existingFolders.get(parentPath)?.id
          : parentFolderId;
        if (parentPath && !parentId) return;

        const children = await childrenFor(parentId ?? null);
        const match = uniqueMatch(children, baseName(folderPath), folderPath);
        if (!match) return;
        if (match.entryType !== "folder") {
          throw new UploadPathConflictError(folderPath, "type");
        }
        existingFolders.set(folderPath, match);
      },
    );
    await resolveFolderDepth(depthIndex + 1);
  }
  await resolveFolderDepth(0);

  await mapWithConcurrency(
    filePaths,
    UPLOAD_PATH_LOOKUP_CONCURRENCY,
    async (filePath) => {
      const parentPath = parentDirectory(filePath);
      const parentId = parentPath
        ? existingFolders.get(parentPath)?.id
        : parentFolderId;
      if (parentPath && !parentId) return;

      const children = await childrenFor(parentId ?? null);
      const match = uniqueMatch(children, baseName(filePath), filePath);
      if (!match) return;
      if (match.entryType !== "file") {
        throw new UploadPathConflictError(filePath, "type");
      }
      replacementFiles.set(filePath, match);
    },
  );

  return {
    existingFolders,
    replacementFiles,
    conflictPaths: Array.from(replacementFiles.keys()).sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}

export function normalizeUploadPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .filter((component) => component && component !== ".")
    .join("/");
}

function collectFolderPaths(filePaths: string[]): string[] {
  const folders = new Set<string>();
  for (const filePath of filePaths) {
    let current = parentDirectory(filePath);
    while (current) {
      folders.add(current);
      current = parentDirectory(current);
    }
  }
  return Array.from(folders).sort((left, right) => {
    const depthDifference = pathDepth(left) - pathDepth(right);
    return depthDifference || left.localeCompare(right);
  });
}

function groupFoldersByDepth(folderPaths: string[]): string[][] {
  const groups: string[][] = [];
  for (const folderPath of folderPaths) {
    const index = pathDepth(folderPath) - 1;
    const group = groups[index];
    if (group) {
      group.push(folderPath);
    } else {
      groups[index] = [folderPath];
    }
  }
  return groups;
}

function indexChildren(entries: UploadTreeEntry[]) {
  const index = new Map<string, UploadTreeEntry[]>();
  for (const entry of entries) {
    const key = comparableName(entry.name);
    const matches = index.get(key);
    if (matches) {
      matches.push(entry);
    } else {
      index.set(key, [entry]);
    }
  }
  return index;
}

function uniqueMatch(
  children: Map<string, UploadTreeEntry[]>,
  name: string,
  path: string,
) {
  const matches = children.get(comparableName(name)) ?? [];
  if (matches.length > 1) {
    throw new UploadPathConflictError(path, "ambiguous");
  }
  return matches[0];
}

function comparableName(name: string) {
  return name.normalize("NFC").toLocaleLowerCase();
}

function parentDirectory(path: string) {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function baseName(path: string) {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? path : path.slice(separator + 1);
}

function pathDepth(path: string) {
  return path.split("/").length;
}
