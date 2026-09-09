import { archiveCompressionLevel } from "@/features/archive/compression-policy";
import { BlobReader, BlobWriter, ZipWriter } from "@/features/archive/zip";
import { BoundedBlobWriter } from "@/features/dashboard/bounded-blob-writer";
import type {
  FolderZipWorkerRequest,
  FolderZipWorkerResponse,
} from "@/features/dashboard/folder-zip-messages";
import { createIntervalProgressCoalescer } from "@/features/uploads/progress-coalescer";

type WorkerScope = {
  onmessage: ((event: MessageEvent<FolderZipWorkerRequest>) => void) | null;
  postMessage(message: FolderZipWorkerResponse): void;
};

const workerScope = self as unknown as WorkerScope;
let activeController: AbortController | null = null;

workerScope.onmessage = (event) => {
  if (event.data.type === "cancel") {
    activeController?.abort();
    return;
  }

  if (activeController) {
    return;
  }

  void createArchive(event.data);
};

async function createArchive(
  request: Extract<FolderZipWorkerRequest, { type: "compress" }>,
) {
  const { sources, compressionMode = "balanced", maxOutputBytes } = request;
  const controller = new AbortController();
  activeController = controller;
  const totalBytes = sources.reduce(
    (total, source) => total + (source.directory ? 0 : source.file.size),
    0,
  );
  let completedBytes = 0;
  let currentPath = "";
  const progressReporter = createIntervalProgressCoalescer(
    (message: Extract<FolderZipWorkerResponse, { type: "progress" }>) =>
      workerScope.postMessage(message),
  );

  try {
    progressReporter.publish(
      {
        type: "progress",
        processedBytes: 0,
        totalBytes,
        currentPath,
      },
      true,
    );
    if (
      maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0)
    ) {
      throw new Error("The ZIP archive output limit is invalid.");
    }
    const blobWriter =
      maxOutputBytes === undefined
        ? new BlobWriter("application/zip")
        : new BoundedBlobWriter(maxOutputBytes);
    const zipWriter = new ZipWriter(blobWriter, {
      signal: controller.signal,
      useWebWorkers: false,
    });

    for (const source of sources) {
      const path = normalizeArchivePath(source.path);

      if (!path) {
        continue;
      }

      if (source.directory) {
        const directoryPath = path.endsWith("/") ? path : `${path}/`;
        currentPath = directoryPath;
        await zipWriter.add(directoryPath, undefined, {
          directory: true,
          lastModDate: new Date(source.lastModified),
          signal: controller.signal,
        });
        progressReporter.publish({
          type: "progress",
          processedBytes: completedBytes,
          totalBytes,
          currentPath,
        });
        continue;
      }

      currentPath = path;
      await zipWriter.add(path, new BlobReader(source.file), {
        level: archiveCompressionLevel({
          path,
          mimeType: source.file.type,
          mode: compressionMode,
        }),
        lastModDate: new Date(source.file.lastModified),
        signal: controller.signal,
        onprogress(progress) {
          progressReporter.publish({
            type: "progress",
            processedBytes: completedBytes + progress,
            totalBytes,
            currentPath: path,
          });
        },
      });

      completedBytes += source.file.size;
      progressReporter.publish({
        type: "progress",
        processedBytes: completedBytes,
        totalBytes,
        currentPath,
      });
    }

    const archive = await zipWriter.close();

    if (controller.signal.aborted) {
      workerScope.postMessage({ type: "canceled" });
      return;
    }

    progressReporter.publish(
      {
        type: "progress",
        processedBytes: totalBytes,
        totalBytes,
        currentPath,
      },
      true,
    );
    workerScope.postMessage({ type: "complete", archive });
  } catch (error) {
    if (controller.signal.aborted) {
      workerScope.postMessage({ type: "canceled" });
      return;
    }

    workerScope.postMessage({
      type: "error",
      message:
        error instanceof Error
          ? error.message
          : "The ZIP archive could not be created.",
    });
  } finally {
    activeController = null;
  }
}

function normalizeArchivePath(value: string) {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .flatMap((segment) => {
      if (!segment || segment === "." || segment === "..") return [];
      const normalized = Array.from(segment)
        .filter((character) => {
          const code = character.charCodeAt(0);
          return code > 31 && code !== 127;
        })
        .join("")
        .trim();
      return normalized ? [normalized] : [];
    })
    .join("/");
}
