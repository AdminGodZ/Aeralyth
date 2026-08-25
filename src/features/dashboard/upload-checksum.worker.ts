import { incrementalBlobSha256 } from "@/features/dashboard/incremental-blob-sha256";
import type {
  UploadChecksumWorkerRequest,
  UploadChecksumWorkerResponse,
} from "@/features/dashboard/upload-checksum-messages";

type WorkerScope = {
  onmessage:
    | ((event: MessageEvent<UploadChecksumWorkerRequest>) => void)
    | null;
  postMessage(message: UploadChecksumWorkerResponse): void;
};

const workerScope = self as unknown as WorkerScope;
const active = new Map<number, AbortController>();

workerScope.onmessage = (event) => {
  const request = event.data;
  if (request.type === "cancel") {
    active
      .get(request.id)
      ?.abort(new DOMException("Upload canceled", "AbortError"));
    return;
  }
  if (active.has(request.id)) return;
  void hashBlob(request);
};

async function hashBlob(
  request: Extract<UploadChecksumWorkerRequest, { type: "hash" }>,
): Promise<void> {
  const controller = new AbortController();
  active.set(request.id, controller);
  try {
    const digest = await incrementalBlobSha256(request.blob, controller.signal);
    workerScope.postMessage({
      type: "complete",
      id: request.id,
      checksumSha256: bytesToBase64(digest),
    });
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      id: request.id,
      message:
        error instanceof Error
          ? error.message
          : "The upload checksum could not be calculated.",
    });
  } finally {
    active.delete(request.id);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
