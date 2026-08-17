import type {
  FolderZipSource,
  FolderZipWorkerResponse,
} from "@/features/dashboard/folder-zip-messages";
import { FOLDER_ZIP_WORKER_URL } from "@/generated/worker-assets";

export type BrowserArchiveProgress = Extract<
  FolderZipWorkerResponse,
  { type: "progress" }
>;

export function createBrowserZip({
  sources,
  signal,
  workerName,
  errorMessage,
  onProgress,
  maxOutputBytes,
}: {
  sources: FolderZipSource[];
  signal?: AbortSignal;
  workerName: string;
  errorMessage: string;
  onProgress(progress: BrowserArchiveProgress): void;
  maxOutputBytes?: number;
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
      worker.postMessage(
        maxOutputBytes === undefined
          ? { type: "compress", sources }
          : { type: "compress", sources, maxOutputBytes },
      );
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

export function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return (
    signal?.reason ??
    new DOMException("The ZIP download was canceled.", "AbortError")
  );
}
