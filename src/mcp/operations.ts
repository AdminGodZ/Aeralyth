import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  type FolderUploadResolution,
  resolveFolderUploadConflicts,
  type UploadTreeEntry,
} from "@/features/dashboard/folder-upload-conflicts";
import { partitionGitIgnoredSelections } from "@/features/dashboard/gitignore-filter";
import {
  readEncryptedFilePrefix,
  readEncryptedFileStream,
} from "@/features/vault/encrypted-download";
import {
  createEncryptedFolder,
  uploadEncryptedSelections,
} from "@/features/vault/encrypted-upload";
import {
  getVaultMetadataPlans,
  mutateFileTree,
} from "@/features/vault/vault-api";
import {
  getItemNameError,
  normalizeItemName,
  renameVaultNode,
} from "@/features/vault/vault-rename";
import {
  collectLocalSelections,
  guessMimeType,
  type LocalSelection,
  localNameFor,
  pathKind,
  resolveLocalPath,
  writeStreamAtomically,
} from "@/mcp/local-files";
import type {
  AeralythSession,
  FolderListing,
  ListView,
  VaultEntry,
} from "@/mcp/session";

type Connection = Awaited<ReturnType<AeralythSession["connect"]>>;

export type Target = { path?: string; id?: string };

/** A resolved file or folder; the root folder has a null id. */
export type ResolvedNode = {
  id: string | null;
  type: "file" | "folder";
  name: string;
  /** Absolute vault path when known (always when resolved from a path). */
  path: string | null;
  parentId: string | null;
  size: number | null;
  mimeType: string | null;
};

export type Progress = (done: number, total?: number, message?: string) => void;

const MAX_PATH_SEGMENTS = 64;
const MAX_UPLOAD_FILES = 10_000;
const MAX_DOWNLOAD_FILES = 10_000;
const REPLACEMENT_PLAN_BATCH = 100;
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export class VaultNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultNotFoundError";
  }
}

/** Splits a vault path into names; "/" and "" are the root folder. */
export function splitVaultPath(value: string): string[] {
  const segments = value
    .trim()
    .split("/")
    .filter((segment) => segment !== "")
    // Vault names are stored in NFC; macOS paths often arrive decomposed.
    .map((segment) => segment.normalize("NFC"));
  if (segments.length > MAX_PATH_SEGMENTS) {
    throw new Error("That vault path is too deep.");
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(
        "Vault paths are absolute, like /Documents/notes.md; “.” and “..” are not supported.",
      );
    }
  }
  return segments;
}

export function joinVaultPath(
  parent: string | null,
  name: string,
): string | null {
  if (parent === null) return null;
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

export class VaultOperations {
  constructor(private readonly session: AeralythSession) {}

  async resolve(
    connection: Connection,
    target: Target,
    signal?: AbortSignal,
  ): Promise<ResolvedNode> {
    if (target.id !== undefined && target.path !== undefined) {
      throw new Error("Pass either path or id, not both.");
    }
    if (target.id !== undefined) {
      const { manifest } = await this.session.describe(
        connection,
        target.id,
        signal,
      );
      return {
        id: target.id,
        type: manifest.entryType,
        name: manifest.name,
        path: null,
        parentId: manifest.parentId,
        size: manifest.entryType === "file" ? manifest.plaintextBytes : null,
        mimeType: manifest.mimeType,
      };
    }
    const segments = splitVaultPath(target.path ?? "/");
    let node: ResolvedNode = {
      id: null,
      type: "folder",
      name: "",
      path: "/",
      parentId: null,
      size: null,
      mimeType: null,
    };
    for (const [index, segment] of segments.entries()) {
      if (node.type !== "folder") {
        throw new VaultNotFoundError(`${node.path} is a file, not a folder.`);
      }
      // Each level is listed once, after its parent is known.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const entry = await this.findChild(connection, node, segment, signal);
      node = {
        id: entry.id,
        type: entry.type,
        name: entry.name,
        path: `/${segments.slice(0, index + 1).join("/")}`,
        parentId: node.id,
        size: entry.size,
        mimeType: entry.mimeType,
      };
    }
    return node;
  }

  async list(
    connection: Connection,
    target: Target,
    {
      view,
      maxEntries,
      signal,
    }: { view: ListView; maxEntries: number; signal?: AbortSignal },
  ): Promise<FolderListing> {
    if (view !== "files" && view !== "shared") {
      if (target.path || target.id) {
        throw new Error(
          `The ${view} view is not a folder; leave out path and id.`,
        );
      }
      return this.session.list(connection, {
        folderId: null,
        view,
        signal,
        maxEntries,
      });
    }
    const folder =
      view === "shared" && !target.id && !target.path
        ? null
        : await this.resolve(connection, target, signal);
    if (folder && folder.type !== "folder") {
      throw new Error(`${folder.path ?? folder.name} is a file, not a folder.`);
    }
    const listing = await this.session.list(connection, {
      folderId: folder?.id ?? null,
      view,
      signal,
      maxEntries,
    });
    return view === "files" ? listing : { ...listing, path: null };
  }

  /** Walks folders breadth first and returns entries whose names match. */
  async search(
    connection: Connection,
    target: Target,
    {
      query,
      type,
      maxResults,
      maxFolders,
      signal,
      progress,
    }: {
      query: string;
      type?: "file" | "folder";
      maxResults: number;
      maxFolders: number;
      signal?: AbortSignal;
      progress: Progress;
    },
  ): Promise<{
    matches: Array<VaultEntry & { path: string | null }>;
    foldersSearched: number;
    complete: boolean;
  }> {
    const start = await this.resolve(connection, target, signal);
    if (start.type !== "folder")
      throw new Error(`${start.path} is not a folder.`);
    const needle = query.toLocaleLowerCase();
    const matches: Array<VaultEntry & { path: string | null }> = [];
    const queue: Array<{ id: string | null; path: string | null }> = [
      { id: start.id, path: start.path },
    ];
    let foldersSearched = 0;
    while (queue.length > 0 && matches.length < maxResults) {
      if (foldersSearched >= maxFolders) {
        return { matches, foldersSearched, complete: false };
      }
      const folder = queue.shift() as {
        id: string | null;
        path: string | null;
      };
      // Breadth first keeps shallow matches first and bounds the walk.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const listing = await this.session.list(connection, {
        folderId: folder.id,
        signal,
      });
      foldersSearched += 1;
      progress(
        foldersSearched,
        undefined,
        `Searched ${foldersSearched} folders`,
      );
      for (const entry of listing.entries) {
        const entryPath = joinVaultPath(folder.path, entry.name);
        if (
          entry.name.toLocaleLowerCase().includes(needle) &&
          (!type || entry.type === type)
        ) {
          matches.push({ ...entry, path: entryPath });
          if (matches.length >= maxResults) break;
        }
        if (entry.type === "folder")
          queue.push({ id: entry.id, path: entryPath });
      }
    }
    return { matches, foldersSearched, complete: queue.length === 0 };
  }

  async readFile(
    connection: Connection,
    target: Target,
    { maxBytes, signal }: { maxBytes: number; signal?: AbortSignal },
  ): Promise<
    ResolvedNode & {
      kind: "text" | "image" | "binary";
      text?: string;
      base64?: string;
      truncated: boolean;
    }
  > {
    const node = await this.resolve(connection, target, signal);
    if (node.type !== "file" || !node.id) {
      throw new Error(
        `${node.path ?? node.name} is a folder; use list_folder.`,
      );
    }
    const { plan, manifest } = await this.session.describe(
      connection,
      node.id,
      signal,
    );
    const mimeType = manifest.mimeType || guessMimeType(manifest.name) || null;
    const described = { ...node, mimeType, size: manifest.plaintextBytes };
    if (manifest.plaintextBytes === 0) {
      return { ...described, kind: "text", text: "", truncated: false };
    }
    const image = mimeType !== null && IMAGE_TYPES.has(mimeType);
    if (image && manifest.plaintextBytes > maxBytes) {
      return { ...described, kind: "image", truncated: true };
    }
    const { blob } = await readEncryptedFilePrefix({
      plan,
      manifest,
      client: connection.client,
      maxPlaintextBytes: Math.min(maxBytes, manifest.plaintextBytes),
      signal,
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const truncated = bytes.length < manifest.plaintextBytes;
    if (image) {
      return {
        ...described,
        kind: "image",
        base64: Buffer.from(bytes).toString("base64"),
        truncated: false,
      };
    }
    const text = decodeText(bytes);
    if (text === null) return { ...described, kind: "binary", truncated };
    return { ...described, kind: "text", text, truncated };
  }

  /** Downloads a file, or a folder with everything in it, to this machine. */
  async download(
    connection: Connection,
    target: Target,
    {
      destination,
      overwrite,
      signal,
      progress,
    }: {
      destination: string;
      overwrite: boolean;
      signal?: AbortSignal;
      progress: Progress;
    },
  ): Promise<{ localPath: string; files: number; bytes: number }> {
    const node = await this.resolve(connection, target, signal);
    const requested = resolveLocalPath(destination);
    const kind = await pathKind(requested);
    const localPath =
      kind === "directory"
        ? path.join(requested, localNameFor(node.name || "Aeralyth"))
        : requested;
    if (kind === "other")
      throw new Error(`${requested} is not a file or folder.`);
    const totals = { files: 0, bytes: 0 };
    if (node.type === "file") {
      await this.downloadFile(connection, node.id as string, localPath, {
        overwrite,
        signal,
        onBytes: (bytes) => progress(bytes, node.size ?? undefined),
      });
      return { localPath, files: 1, bytes: node.size ?? 0 };
    }
    if (!overwrite && (await pathKind(localPath)) !== null) {
      throw new Error(
        `${localPath} already exists. Pass overwrite to merge into it.`,
      );
    }
    const walk = async (folderId: string | null, directory: string) => {
      const listing = await this.session.list(connection, {
        folderId,
        signal,
        maxEntries: MAX_DOWNLOAD_FILES,
      });
      if (listing.truncated) {
        throw new Error("A folder holds too many items to download at once.");
      }
      await mkdir(directory, { recursive: true });
      for (const entry of listing.entries) {
        signal?.throwIfAborted();
        const childPath = path.join(directory, localNameFor(entry.name));
        if (entry.type === "folder") {
          // Folders are walked one at a time to keep the request rate modest.
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          await walk(entry.id, childPath);
          continue;
        }
        if (entry.unreadable) {
          throw new Error(
            `An item in ${directory} could not be decrypted: ${entry.unreadable}`,
          );
        }
        if (totals.files >= MAX_DOWNLOAD_FILES) {
          throw new Error(
            `The folder holds more than ${MAX_DOWNLOAD_FILES} files.`,
          );
        }
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await this.downloadFile(connection, entry.id, childPath, {
          overwrite,
          signal,
          onBytes: () => undefined,
        });
        totals.files += 1;
        totals.bytes += entry.size ?? 0;
        progress(totals.files, undefined, `Downloaded ${totals.files} files`);
      }
    };
    await walk(node.id, localPath);
    return { localPath, ...totals };
  }

  private async downloadFile(
    connection: Connection,
    nodeId: string,
    localPath: string,
    {
      overwrite,
      signal,
      onBytes,
    }: {
      overwrite: boolean;
      signal?: AbortSignal;
      onBytes(bytes: number): void;
    },
  ): Promise<void> {
    const { plan, manifest } = await this.session.describe(
      connection,
      nodeId,
      signal,
    );
    if (manifest.entryType !== "file")
      throw new Error("That item is a folder.");
    const stream =
      manifest.plaintextBytes === 0
        ? new ReadableStream<Uint8Array>({
            start: (controller) => controller.close(),
          })
        : readEncryptedFileStream({
            plan,
            manifest,
            client: connection.client,
            signal,
            onProgress: (percent) =>
              onBytes(Math.round((percent / 100) * manifest.plaintextBytes)),
          });
    await writeStreamAtomically(localPath, stream, { overwrite });
  }

  /** Uploads a local file or folder into a vault folder. */
  async upload(
    connection: Connection,
    {
      source,
      destination,
      name,
      overwrite,
      includeIgnored,
      signal,
      progress,
    }: {
      source: string;
      destination: Target;
      name?: string;
      overwrite: boolean;
      includeIgnored: boolean;
      signal: AbortSignal;
      progress: Progress;
    },
  ): Promise<{
    destinationPath: string | null;
    files: number;
    bytes: number;
    skipped: number;
  }> {
    const localSource = resolveLocalPath(source);
    const collected = await collectLocalSelections(localSource, {
      maxFiles: MAX_UPLOAD_FILES,
    });
    let selections = collected.selections;
    let skipped = 0;
    if (collected.isDirectory && !includeIgnored) {
      // The same rules a folder drop in the browser follows.
      const partition = await partitionGitIgnoredSelections(selections);
      selections = partition.includedSelections;
      skipped =
        partition.ignoredSelections.length +
        partition.hiddenDirectorySelections.length;
    }
    if (name !== undefined) {
      const renamed = checkedName(name);
      selections = selections.map((selection) => {
        const [, ...rest] = selection.relativePath.split("/");
        return collected.isDirectory
          ? { ...selection, relativePath: [renamed, ...rest].join("/") }
          : {
              file: new File([selection.file], renamed, {
                type: guessMimeType(renamed) || selection.file.type,
                lastModified: selection.file.lastModified,
              }),
              relativePath: renamed,
            };
      });
    }
    if (selections.length === 0) {
      throw new Error(
        collected.isDirectory
          ? "That folder has nothing to upload once ignored files are left out."
          : "Nothing to upload.",
      );
    }
    const folder = await this.ensureFolder(connection, destination, signal);
    await this.uploadSelections(connection, selections, folder.id, {
      overwrite,
      signal,
      progress,
    });
    return {
      destinationPath: folder.path,
      files: selections.length,
      bytes: selections.reduce((total, item) => total + item.file.size, 0),
      skipped,
    };
  }

  /** Creates or replaces one file from content the agent supplies. */
  async writeFile(
    connection: Connection,
    {
      vaultPath,
      content,
      encoding,
      mimeType,
      overwrite,
      signal,
    }: {
      vaultPath: string;
      content: string;
      encoding: "utf8" | "base64";
      mimeType?: string;
      overwrite: boolean;
      signal: AbortSignal;
    },
  ): Promise<{ path: string; bytes: number }> {
    const segments = splitVaultPath(vaultPath);
    const fileName = segments.pop();
    if (!fileName)
      throw new Error("Give the file's full path, like /Notes/today.md.");
    const name = checkedName(fileName);
    const bytes =
      encoding === "base64"
        ? Buffer.from(content, "base64")
        : Buffer.from(content, "utf8");
    const folder = await this.ensureFolder(
      connection,
      { path: `/${segments.join("/")}` },
      signal,
    );
    const file = new File([bytes], name, {
      type: mimeType ?? guessMimeType(name),
      lastModified: Date.now(),
    });
    await this.uploadSelections(
      connection,
      [{ file, relativePath: name }],
      folder.id,
      {
        overwrite,
        signal,
        progress: () => undefined,
      },
    );
    return {
      path: joinVaultPath(folder.path, name) ?? name,
      bytes: bytes.length,
    };
  }

  /** Creates a folder and any missing parents; existing folders are reused. */
  async ensureFolder(
    connection: Connection,
    target: Target,
    signal: AbortSignal | undefined,
  ): Promise<ResolvedNode & { created: number }> {
    if (target.id !== undefined) {
      const node = await this.resolve(connection, target, signal);
      if (node.type !== "folder")
        throw new Error(`${node.name} is not a folder.`);
      return { ...node, created: 0 };
    }
    const segments = splitVaultPath(target.path ?? "/");
    let node: ResolvedNode = {
      id: null,
      type: "folder",
      name: "",
      path: "/",
      parentId: null,
      size: null,
      mimeType: null,
    };
    let created = 0;
    for (const segment of segments) {
      const name = checkedName(segment);
      // Each level depends on its parent's id.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const existing = await this.findChild(
        connection,
        node,
        name,
        signal,
        true,
      );
      let id: string;
      if (existing) {
        if (existing.type !== "folder") {
          throw new Error(
            `${joinVaultPath(node.path, name)} is a file, not a folder.`,
          );
        }
        id = existing.id;
      } else {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const folder = await createEncryptedFolder({
          name,
          parentId: node.id,
          csrfToken: connection.csrfToken,
          client: connection.client,
          signal: signal ?? new AbortController().signal,
        });
        id = folder.nodeId;
        created += 1;
      }
      node = {
        id,
        type: "folder",
        name,
        path: joinVaultPath(node.path, name),
        parentId: node.id,
        size: null,
        mimeType: null,
      };
    }
    return { ...node, created };
  }

  async rename(
    connection: Connection,
    target: Target,
    newName: string,
    signal?: AbortSignal,
  ): Promise<{ from: string; to: string; path: string | null }> {
    const name = checkedName(newName);
    const node = await this.resolve(connection, target, signal);
    if (!node.id) throw new Error("The root folder cannot be renamed.");
    const siblings = await this.session.list(connection, {
      folderId: node.parentId,
      signal,
      maxEntries: 100_000,
    });
    if (
      siblings.entries.some(
        (entry) => entry.id !== node.id && entry.name === name,
      )
    ) {
      throw new Error(
        `Something named “${name}” already exists in that folder.`,
      );
    }
    await renameVaultNode(
      {
        client: connection.client,
        csrfToken: connection.csrfToken,
        openNode: (nodeId, plan, nodeSignal) =>
          this.session.openNode(connection, nodeId, plan, nodeSignal),
      },
      node.id,
      name,
      signal,
    );
    const parentPath =
      node.path === null ? null : path.posix.dirname(node.path);
    return { from: node.name, to: name, path: joinVaultPath(parentPath, name) };
  }

  async moveToTrash(
    connection: Connection,
    target: Target,
    signal?: AbortSignal,
  ): Promise<ResolvedNode> {
    const node = await this.resolve(connection, target, signal);
    if (!node.id)
      throw new Error("The root folder cannot be moved to the trash.");
    await mutateFileTree(node.id, "trash", connection.csrfToken, signal);
    return node;
  }

  async restore(
    connection: Connection,
    id: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await mutateFileTree(id, "restore", connection.csrfToken, signal);
  }

  private async findChild(
    connection: Connection,
    folder: ResolvedNode,
    name: string,
    signal: AbortSignal | undefined,
    optional: true,
  ): Promise<VaultEntry | null>;
  private async findChild(
    connection: Connection,
    folder: ResolvedNode,
    name: string,
    signal: AbortSignal | undefined,
    optional?: false,
  ): Promise<VaultEntry>;
  private async findChild(
    connection: Connection,
    folder: ResolvedNode,
    name: string,
    signal: AbortSignal | undefined,
    optional = false,
  ): Promise<VaultEntry | null> {
    const listing = await this.session.list(connection, {
      folderId: folder.id,
      signal,
      maxEntries: 100_000,
    });
    const matches = listing.entries.filter((entry) => entry.name === name);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(
        `${folder.path} holds ${matches.length} items named “${name}” (ids ${matches
          .map((entry) => entry.id)
          .join(", ")}). Pass the id instead of the path.`,
      );
    }
    if (optional) return null;
    const lower = name.toLocaleLowerCase();
    const similar = listing.entries
      .filter((entry) => entry.name.toLocaleLowerCase().includes(lower))
      .slice(0, 5)
      .map((entry) => `“${entry.name}”`);
    throw new VaultNotFoundError(
      `Nothing named “${name}” in ${folder.path ?? "that folder"}.${
        similar.length > 0 ? ` Similar: ${similar.join(", ")}.` : ""
      }`,
    );
  }

  private async uploadSelections(
    connection: Connection,
    selections: LocalSelection[],
    parentFolderId: string | null,
    {
      overwrite,
      signal,
      progress,
    }: { overwrite: boolean; signal: AbortSignal; progress: Progress },
  ): Promise<void> {
    const resolution = await resolveFolderUploadConflicts({
      relativePaths: selections.map((selection) => selection.relativePath),
      parentFolderId,
      loadChildren: (folderId) =>
        this.uploadTreeChildren(connection, folderId, signal),
    });
    const existing = [
      ...resolution.existingFolders.values(),
      ...resolution.replacementFiles.values(),
    ];
    if (existing.some((entry) => entry.e2eeState !== "encrypted")) {
      throw new Error(
        "An existing item at that destination is still being encrypted. Open Aeralyth in a browser to finish the vault migration, then try again.",
      );
    }
    if (resolution.replacementFiles.size > 0) {
      if (!overwrite) {
        const conflicts = [...resolution.replacementFiles.keys()].slice(0, 10);
        throw new Error(
          `${resolution.replacementFiles.size} file(s) already exist (${conflicts.join(", ")}${
            resolution.replacementFiles.size > conflicts.length ? ", …" : ""
          }). Pass overwrite to replace them with new versions.`,
        );
      }
      await this.loadReplacementGenerations(connection, resolution, signal);
    }
    const total = selections.reduce((sum, item) => sum + item.file.size, 0);
    await uploadEncryptedSelections({
      selections,
      parentFolderId,
      resolution,
      csrfToken: connection.csrfToken,
      client: connection.client,
      signal,
      onProgress: (processed) => progress(processed, total),
      onFileStart: () => undefined,
      onFileComplete: () => undefined,
    });
  }

  private async uploadTreeChildren(
    connection: Connection,
    folderId: string | null,
    signal: AbortSignal,
  ): Promise<UploadTreeEntry[]> {
    const listing = await this.session.list(connection, {
      folderId,
      signal,
      maxEntries: 100_000,
    });
    return listing.entries.map((entry) => {
      if (entry.unreadable) {
        throw new Error(
          `An existing item at the destination could not be decrypted: ${entry.unreadable}`,
        );
      }
      return {
        id: entry.id,
        name: entry.name,
        entryType: entry.type,
        e2eeState: entry.encrypted ? "encrypted" : "legacy",
        ...(entry.record
          ? {
              recordVersion: entry.record.version,
              recordHash: entry.record.hash,
            }
          : {}),
      };
    });
  }

  /** Fills in each file's generation, which replacing it must name. */
  private async loadReplacementGenerations(
    connection: Connection,
    resolution: FolderUploadResolution,
    signal: AbortSignal,
  ): Promise<void> {
    const files = [...resolution.replacementFiles.values()];
    const byId = new Map(files.map((file) => [file.id, file]));
    for (
      let offset = 0;
      offset < files.length;
      offset += REPLACEMENT_PLAN_BATCH
    ) {
      const nodeIds = files
        .slice(offset, offset + REPLACEMENT_PLAN_BATCH)
        .map((file) => file.id);
      let continuation: number | undefined;
      do {
        // Each continuation comes from the page before it.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const page = await getVaultMetadataPlans(
          connection.csrfToken,
          nodeIds,
          continuation,
          signal,
        );
        for (const plan of page.plans) {
          const file = byId.get(plan.nodeId);
          if (!file) continue;
          if (
            plan.recordHash !== file.recordHash ||
            plan.recordVersion !== file.recordVersion
          ) {
            throw new Error(
              `“${file.name}” changed while the upload was being prepared. Try again.`,
            );
          }
          file.generationNumber = plan.generationNumber;
        }
        if (
          page.continuation !== undefined &&
          (!Number.isSafeInteger(page.continuation) ||
            page.continuation <= (continuation ?? -1))
        ) {
          throw new Error("The existing file listing could not be continued.");
        }
        continuation = page.continuation;
      } while (continuation !== undefined);
    }
  }
}

function checkedName(name: string): string {
  const problem = getItemNameError(name);
  if (problem) throw new Error(`“${name}”: ${problem}`);
  return normalizeItemName(name);
}

/** Decodes UTF-8 text, or returns null when the bytes look binary. */
export function decodeText(bytes: Uint8Array): string | null {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return null;
  // Streaming mode holds back a character cut in half by a truncated read.
  const text = new TextDecoder("utf-8").decode(bytes, { stream: true });
  let replaced = 0;
  for (const character of text) if (character === "�") replaced += 1;
  return replaced > Math.max(8, text.length / 50) ? null : text;
}
