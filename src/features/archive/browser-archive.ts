import { Writer, ZipWriter } from "@/features/archive/zip";

import { BoundedBlobWriter } from "@/features/dashboard/bounded-blob-writer";
import type {
  FolderZipCompressionMode,
  FolderZipSource,
  FolderZipWorkerResponse,
} from "@/features/dashboard/folder-zip-messages";
import { FOLDER_ZIP_WORKER_URL } from "@/generated/worker-assets";

export type BrowserArchiveProgress = Extract<
  FolderZipWorkerResponse,
  { type: "progress" }
>;

export const MAX_IN_MEMORY_ARCHIVE_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_IN_MEMORY_ARCHIVE_OUTPUT_BYTES = 48 * 1024 * 1024;

type ArchiveFileSystemWritable = {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
};

type ArchiveFileSystemHandle = {
  createWritable(): Promise<ArchiveFileSystemWritable>;
  getFile(): Promise<File>;
};

type ArchiveFileSystemDirectory = {
  getFileHandle(
    name: string,
    options: { create: true },
  ): Promise<ArchiveFileSystemHandle>;
  removeEntry(name: string): Promise<void>;
};

export type StreamingZipDestination = {
  zipWriter: ZipWriter<Blob>;
  diskBacked: boolean;
  close(): Promise<Blob>;
  discard(reason?: unknown): Promise<void>;
  release(): Promise<void>;
};

export async function createStreamingZipDestination({
  totalSourceBytes,
  maxMemorySourceBytes = MAX_IN_MEMORY_ARCHIVE_SOURCE_BYTES,
  maxMemoryOutputBytes = MAX_IN_MEMORY_ARCHIVE_OUTPUT_BYTES,
}: {
  totalSourceBytes: number;
  maxMemorySourceBytes?: number;
  maxMemoryOutputBytes?: number;
}): Promise<StreamingZipDestination> {
  if (!Number.isSafeInteger(totalSourceBytes) || totalSourceBytes < 0) {
    throw new Error("The ZIP archive source size is invalid.");
  }
  const originPrivate = await createOriginPrivateArchiveWriter();
  if (originPrivate) {
    const zipWriter = new ZipWriter<Blob>(originPrivate.writer, {
      useWebWorkers: typeof Worker !== "undefined",
    });
    let closed = false;
    let released = false;
    return {
      zipWriter,
      diskBacked: true,
      async close() {
        const archive = await zipWriter.close();
        closed = true;
        return archive;
      },
      async discard(reason) {
        if (!closed) await originPrivate.writer.abort(reason);
        if (!released) {
          released = true;
          await originPrivate.directory
            .removeEntry(originPrivate.fileName)
            .catch(() => undefined);
        }
      },
      async release() {
        if (released) return;
        released = true;
        await originPrivate.directory.removeEntry(originPrivate.fileName);
      },
    };
  }

  if (totalSourceBytes > maxMemorySourceBytes) {
    throw new Error(
      "This browser cannot stream this ZIP archive to disk. Choose a folder no larger than 32 MiB or use a browser with OPFS support.",
    );
  }
  const blobWriter = new BoundedBlobWriter(maxMemoryOutputBytes);
  const zipWriter = new ZipWriter<Blob>(blobWriter, {
    useWebWorkers: typeof Worker !== "undefined",
  });
  return {
    zipWriter,
    diskBacked: false,
    close: () => zipWriter.close(),
    async discard() {},
    async release() {},
  };
}

export function createBrowserZip({
  sources,
  signal,
  workerName,
  errorMessage,
  onProgress,
  maxOutputBytes,
  compressionMode,
}: {
  sources: FolderZipSource[];
  signal?: AbortSignal;
  workerName: string;
  errorMessage: string;
  onProgress(progress: BrowserArchiveProgress): void;
  maxOutputBytes?: number;
  compressionMode?: FolderZipCompressionMode;
}): Promise<Blob> {
  if (signal?.aborted) {
    return Promise.reject(abortReason(signal));
  }
  if (typeof Worker === "undefined") {
    return Promise.reject(
      new Error("This browser cannot create ZIP archives in the background."),
    );
  }
  if (
    maxOutputBytes !== undefined &&
    (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0)
  ) {
    return Promise.reject(
      new Error("The ZIP archive output limit is invalid."),
    );
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(FOLDER_ZIP_WORKER_URL, {
      type: "module",
      name: workerName,
    });
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const abort = () => {
      worker.postMessage({ type: "cancel" });
      settle(() => reject(abortReason(signal)));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.addEventListener(
      "message",
      (event: MessageEvent<FolderZipWorkerResponse>) => {
        if (settled) return;
        const message = event.data;
        if (message.type === "progress") {
          onProgress(message);
          return;
        }
        if (message.type === "complete") {
          const archive = message.archive;
          settle(() => resolve(archive));
        } else if (message.type === "canceled") {
          settle(() =>
            reject(
              new DOMException("The ZIP download was canceled.", "AbortError"),
            ),
          );
        } else {
          const workerMessage = message.message;
          settle(() => reject(new Error(workerMessage)));
        }
      },
    );
    worker.addEventListener("error", () => {
      settle(() => reject(new Error(errorMessage)));
    });
    try {
      worker.postMessage({
        type: "compress",
        sources,
        ...(compressionMode ? { compressionMode } : {}),
        ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
      });
    } catch (failure) {
      settle(() => reject(failure));
    }
  });
}

export function normalizeArchiveSegment(value: string): string {
  const forbidden = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
  const normalized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || forbidden.has(character)
      ? "_"
      : character;
  })
    .join("")
    .trim()
    .replace(/[. ]+$/u, "")
    .slice(0, 180);
  return normalized && normalized !== "." && normalized !== ".."
    ? normalized
    : "unnamed";
}

export function claimArchivePath(paths: Set<string>, path: string): void {
  const canonicalPath = path
    .split("/")
    .map((segment) =>
      normalizeArchiveSegment(segment)
        .normalize("NFC")
        .toLocaleLowerCase("en-US"),
    )
    .join("/");
  if (paths.has(canonicalPath)) {
    throw new Error("Two entries resolve to the same ZIP extraction path.");
  }
  paths.add(canonicalPath);
}

export function parseArchiveTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

export function triggerBlobDownload(
  blob: Blob,
  fileName: string,
  release?: () => void | Promise<void>,
): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    void Promise.resolve(release?.()).catch(() => undefined);
  }, 60_000);
}

class OriginPrivateArchiveWriter extends Writer<Blob> {
  private closed = false;

  constructor(
    private readonly fileWritable: ArchiveFileSystemWritable,
    private readonly fileHandle: ArchiveFileSystemHandle,
  ) {
    super();
  }

  override async writeUint8Array(array: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("The ZIP archive output is closed.");
    await this.fileWritable.write(array);
  }

  override async getData(): Promise<Blob> {
    if (!this.closed) {
      await this.fileWritable.close();
      this.closed = true;
    }
    return this.fileHandle.getFile();
  }

  async abort(reason?: unknown): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.fileWritable.abort(reason).catch(() => undefined);
  }
}

async function createOriginPrivateArchiveWriter(): Promise<{
  directory: ArchiveFileSystemDirectory;
  fileName: string;
  writer: OriginPrivateArchiveWriter;
} | null> {
  if (typeof navigator === "undefined") return null;
  const storage = navigator.storage as
    | (StorageManager & {
        getDirectory?: () => Promise<ArchiveFileSystemDirectory>;
      })
    | undefined;
  const getDirectory = storage?.getDirectory;
  if (typeof getDirectory !== "function") return null;

  let directory: ArchiveFileSystemDirectory | null = null;
  let fileName: string | null = null;
  try {
    directory = await getDirectory.call(storage);
    fileName = `aeralyth-archive-${randomFileToken()}.zip`;
    const fileHandle = await directory.getFileHandle(fileName, {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    return {
      directory,
      fileName,
      writer: new OriginPrivateArchiveWriter(writable, fileHandle),
    };
  } catch {
    if (directory && fileName) {
      await directory.removeEntry(fileName).catch(() => undefined);
    }
    return null;
  }
}

function randomFileToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return (
    signal?.reason ??
    new DOMException("The ZIP download was canceled.", "AbortError")
  );
}
