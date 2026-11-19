import { randomFileToken } from "@/lib/browser-download";

const WORKER_URL = "/download-sw.js";
const SCOPE = "/download-stream/";
const ACTIVATION_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
// Each message restarts the service worker's idle timer, so a long download
// is not cut off when the browser stops an apparently idle worker.
const KEEPALIVE_INTERVAL_MS = 10_000;

let workerPromise: Promise<ServiceWorker> | null = null;

/**
 * Whether this browser can stream a download through the download service
 * worker: it needs service workers and transferable streams.
 */
export function canStreamDownloads(): boolean {
  if (
    typeof window === "undefined" ||
    !window.isSecureContext ||
    !("serviceWorker" in navigator) ||
    typeof ReadableStream === "undefined" ||
    typeof MessageChannel === "undefined"
  ) {
    return false;
  }
  try {
    const probe = new ReadableStream();
    structuredClone(probe, { transfer: [probe] });
    return true;
  } catch {
    return false;
  }
}

/** Registers (once per page) and resolves the activated download worker. */
export function getDownloadWorker(): Promise<ServiceWorker> {
  workerPromise ??= registerDownloadWorker().catch((error: unknown) => {
    workerPromise = null;
    throw error;
  });
  return workerPromise;
}

async function registerDownloadWorker(): Promise<ServiceWorker> {
  const registration = await navigator.serviceWorker.register(WORKER_URL, {
    scope: SCOPE,
    updateViaCache: "none",
  });
  const worker =
    registration.active ?? registration.waiting ?? registration.installing;
  if (!worker) throw new Error("The download worker did not install.");
  if (worker.state === "activated") return worker;
  return await new Promise<ServiceWorker>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener("statechange", onChange);
      reject(new Error("The download worker did not start in time."));
    }, ACTIVATION_TIMEOUT_MS);
    function onChange() {
      if (worker?.state === "activated") {
        clearTimeout(timer);
        worker.removeEventListener("statechange", onChange);
        resolve(worker);
      } else if (worker?.state === "redundant") {
        clearTimeout(timer);
        worker.removeEventListener("statechange", onChange);
        reject(new Error("The download worker failed to start."));
      }
    }
    worker.addEventListener("statechange", onChange);
  });
}

/**
 * Hands `stream` to the browser as a file download without buffering it in
 * memory or site storage. Resolves once the browser has taken every byte;
 * rejects if the stream fails, the browser download is canceled (as an
 * AbortError), or `signal` aborts.
 */
export async function streamDownload({
  worker,
  stream,
  fileName,
  size,
  signal,
}: {
  worker: ServiceWorker;
  stream: ReadableStream<Uint8Array>;
  fileName: string;
  size: number | null;
  signal?: AbortSignal;
}): Promise<void> {
  const id = randomFileToken();
  const channel = new MessageChannel();
  const finished = Promise.withResolvers<void>();
  void finished.promise.catch(() => undefined);
  const reader = stream.getReader();
  // A pull-based relay tells a failure of the source (decryption, network)
  // apart from the browser canceling the download.
  const outgoing = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            finished.resolve();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          controller.error(error);
          finished.reject(error);
        }
      },
      async cancel(reason) {
        finished.reject(
          new DOMException("The download was canceled.", "AbortError"),
        );
        await reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );

  const handshake = new Promise<void>((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => {
      reject(new Error("The browser did not start the download."));
    }, HANDSHAKE_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent<{ type?: string }>) => {
      switch (event.data?.type) {
        case "ready":
          ready = true;
          window.location.assign(`${SCOPE}${id}`);
          break;
        case "started":
          clearTimeout(timer);
          resolve();
          break;
        default:
          clearTimeout(timer);
          reject(
            new Error(
              ready
                ? "The browser did not start the download."
                : "The download worker refused the download.",
            ),
          );
      }
    };
  });

  // Either side can settle first; the other must not surface as unhandled.
  void handshake.catch(() => undefined);
  const keepalive = setInterval(() => {
    worker.postMessage({ type: "ping" });
  }, KEEPALIVE_INTERVAL_MS);
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
    finished.reject(signal?.reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    worker.postMessage(
      {
        type: "download",
        id,
        fileName,
        size,
        stream: outgoing,
        port: channel.port2,
      },
      [outgoing, channel.port2],
    );
    await Promise.race([handshake, finished.promise]);
    await finished.promise;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    clearInterval(keepalive);
    signal?.removeEventListener("abort", onAbort);
    channel.port1.close();
  }
}
