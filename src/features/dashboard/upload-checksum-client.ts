import type {
  UploadChecksumWorkerRequest,
  UploadChecksumWorkerResponse,
} from "@/features/dashboard/upload-checksum-messages";
import { UPLOAD_CHECKSUM_WORKER_URL } from "@/generated/worker-assets";

type PendingChecksum = {
  resolve(value: string): void;
  reject(reason: unknown): void;
  signal?: AbortSignal;
  abort?: () => void;
};

let checksumWorker: Worker | null = null;
let nextChecksumId = 1;
const pendingChecksums = new Map<number, PendingChecksum>();

export function sha256BlobBase64(
  blob: Blob,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));

  const worker = getChecksumWorker();
  const id = nextChecksumId;
  nextChecksumId += 1;

  return new Promise((resolve, reject) => {
    const pending: PendingChecksum = { resolve, reject, signal };
    if (signal) {
      pending.abort = () => {
        if (!pendingChecksums.delete(id)) return;
        try {
          worker.postMessage({
            type: "cancel",
            id,
          } satisfies UploadChecksumWorkerRequest);
        } catch {
          // The caller still receives its abort reason if the worker died first.
        }
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", pending.abort, { once: true });
    }
    pendingChecksums.set(id, pending);
    try {
      worker.postMessage({
        type: "hash",
        id,
        blob,
      } satisfies UploadChecksumWorkerRequest);
    } catch (error) {
      finishPending(id, (entry) => entry.reject(error));
    }
  });
}

function getChecksumWorker(): Worker {
  if (checksumWorker) return checksumWorker;
  if (typeof Worker === "undefined") {
    throw new Error(
      "This browser cannot calculate upload checksums in the background.",
    );
  }

  const worker = new Worker(UPLOAD_CHECKSUM_WORKER_URL, {
    type: "module",
    name: "aeralyth-upload-checksum",
  });
  worker.addEventListener(
    "message",
    (event: MessageEvent<UploadChecksumWorkerResponse>) => {
      const response = event.data;
      finishPending(response.id, (pending) => {
        if (response.type === "complete") {
          pending.resolve(response.checksumSha256);
        } else {
          pending.reject(new Error(response.message));
        }
      });
    },
  );
  worker.addEventListener("error", () => {
    failChecksumWorker(
      worker,
      new Error("The upload checksum worker stopped unexpectedly."),
    );
  });
  worker.addEventListener("messageerror", () => {
    failChecksumWorker(
      worker,
      new Error("The upload checksum worker returned an invalid response."),
    );
  });
  checksumWorker = worker;
  return worker;
}

function finishPending(
  id: number,
  finish: (pending: PendingChecksum) => void,
): void {
  const pending = pendingChecksums.get(id);
  if (!pending) return;
  pendingChecksums.delete(id);
  if (pending.abort) {
    pending.signal?.removeEventListener("abort", pending.abort);
  }
  finish(pending);
}

function failChecksumWorker(worker: Worker, error: Error): void {
  if (checksumWorker !== worker) return;
  checksumWorker = null;
  worker.terminate();
  for (const id of pendingChecksums.keys()) {
    finishPending(id, (pending) => pending.reject(error));
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Upload canceled", "AbortError");
}
