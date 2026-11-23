import { createWriteStream, openAsBlob } from "node:fs";
import { lstat, mkdir, opendir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MIME_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  css: "text/css",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  gz: "application/gzip",
  heic: "image/heic",
  htm: "text/html",
  html: "text/html",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  mjs: "text/javascript",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  tif: "image/tiff",
  tiff: "image/tiff",
  ts: "text/plain",
  tsx: "text/plain",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
};

export function guessMimeType(name: string): string {
  const extension = path.extname(name).slice(1).toLowerCase();
  return MIME_TYPES[extension] ?? "";
}

/** Makes a vault name safe to use as one local path segment. */
export function localNameFor(name: string): string {
  const cleaned = name.replace(/[/\\\0]/g, "_").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "_";
  return cleaned;
}

/** Expands a leading `~` the way a shell would, then makes the path absolute. */
export function resolveLocalPath(value: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  const expanded =
    home && (value === "~" || value.startsWith("~/"))
      ? path.join(home, value.slice(1))
      : value;
  return path.resolve(expanded);
}

export type LocalSelection = {
  file: File;
  relativePath: string;
};

/**
 * Reads a local file or folder into upload selections. Files are opened
 * lazily, so a large folder costs file handles, not memory. Symbolic links
 * are skipped rather than followed.
 */
export async function collectLocalSelections(
  source: string,
  { maxFiles }: { maxFiles: number },
): Promise<{ selections: LocalSelection[]; isDirectory: boolean }> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    throw new Error(`${source} is a symbolic link; upload its target instead.`);
  }
  if (info.isFile()) {
    return {
      selections: [
        {
          file: await openLocalFile(
            source,
            path.basename(source),
            info.mtimeMs,
          ),
          relativePath: path.basename(source),
        },
      ],
      isDirectory: false,
    };
  }
  if (!info.isDirectory()) {
    throw new Error(`${source} is neither a file nor a folder.`);
  }
  const root = path.basename(source);
  const selections: LocalSelection[] = [];
  const walk = async (directory: string, relative: string): Promise<void> => {
    const handle = await opendir(directory);
    for await (const child of handle) {
      const childPath = path.join(directory, child.name);
      const childRelative = `${relative}/${child.name}`;
      if (child.isDirectory()) {
        // A repository's history is never part of an upload.
        if (child.name === ".git") continue;
        await walk(childPath, childRelative);
      } else if (child.isFile()) {
        if (selections.length >= maxFiles) {
          throw new Error(
            `${source} holds more than ${maxFiles} files. Upload a smaller folder.`,
          );
        }
        const childInfo = await stat(childPath);
        selections.push({
          file: await openLocalFile(childPath, child.name, childInfo.mtimeMs),
          relativePath: childRelative,
        });
      }
    }
  };
  await walk(source, root);
  return { selections, isDirectory: true };
}

async function openLocalFile(
  filePath: string,
  name: string,
  lastModified: number,
): Promise<File> {
  const blob = await openAsBlob(filePath);
  return new File([blob], name, {
    type: guessMimeType(name),
    lastModified: Math.trunc(lastModified),
  });
}

export async function pathKind(
  target: string,
): Promise<"file" | "directory" | "other" | null> {
  try {
    const info = await stat(target);
    if (info.isDirectory()) return "directory";
    return info.isFile() ? "file" : "other";
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw failure;
  }
}

/**
 * Writes a stream to `destination` through a temporary file beside it, so a
 * failed or canceled download never leaves a partial file under that name.
 */
export async function writeStreamAtomically(
  destination: string,
  stream: ReadableStream<Uint8Array>,
  { overwrite }: { overwrite: boolean },
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  if (!overwrite && (await pathKind(destination)) !== null) {
    throw new Error(
      `${destination} already exists. Pass overwrite to replace it.`,
    );
  }
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${Date.now()}.aeralyth-partial`,
  );
  try {
    await pipeline(
      Readable.fromWeb(stream as import("node:stream/web").ReadableStream),
      createWriteStream(temporary, { flags: "wx" }),
    );
    if (!overwrite && (await pathKind(destination)) !== null) {
      throw new Error(
        `${destination} appeared while downloading. Pass overwrite to replace it.`,
      );
    }
    await rename(temporary, destination);
  } catch (failure) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw failure;
  }
}
