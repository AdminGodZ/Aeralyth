import { UploadRequestError } from "@/features/uploads/upload-retry";
import { asBufferSource } from "@/features/vault/protocol";
import { abortReason } from "@/lib/abort";

const ABORT_MESSAGE = "Upload canceled";

/** The parts of a finished storage PUT its callers read. */
export type StoragePutResponse = {
  status: number;
  getResponseHeader(name: string): string | null;
};

/**
 * Sends one signed storage PUT. It uses XMLHttpRequest rather than fetch so
 * the caller hears how much of the body has left as it goes; `onProgress`
 * reports the bytes sent so far and the whole body once storage accepts it.
 * Failures carry the same shapes the fetch-based upload retry classifies.
 */
export function putStorageObject({
  url,
  body,
  headers,
  signal,
  onProgress,
}: {
  url: string;
  body: Uint8Array;
  headers: Record<string, string>;
  signal: AbortSignal;
  onProgress?(sentBytes: number): void;
}): Promise<StoragePutResponse> {
  // Outside a browser (the MCP server runs on Node) there is no XHR; fetch
  // sends the same request and reports progress once storage accepts it.
  if (typeof XMLHttpRequest === "undefined") {
    return putStorageObjectWithFetch({
      url,
      body,
      headers,
      signal,
      onProgress,
    });
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal, ABORT_MESSAGE));
      return;
    }
    const request = new XMLHttpRequest();
    const abortRequest = () => request.abort();
    const cleanup = () => signal.removeEventListener("abort", abortRequest);
    request.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) {
      request.setRequestHeader(name, value);
    }
    if (onProgress) {
      request.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          onProgress(Math.min(body.byteLength, event.loaded));
        }
      });
    }
    request.addEventListener("load", () => {
      cleanup();
      if (request.status >= 200 && request.status < 300) {
        onProgress?.(body.byteLength);
        resolve(request);
        return;
      }
      reject(
        new UploadRequestError({
          message: `Storage upload failed with status ${request.status}.`,
          networkFailure: request.status === 0,
          responseBody: request.responseText,
          retryAfter: request.getResponseHeader("Retry-After"),
          status: request.status || null,
        }),
      );
    });
    request.addEventListener("error", () => {
      cleanup();
      reject(
        new UploadRequestError({
          message: "The storage service could not be reached.",
          networkFailure: true,
        }),
      );
    });
    request.addEventListener("abort", () => {
      cleanup();
      reject(abortReason(signal, ABORT_MESSAGE));
    });
    signal.addEventListener("abort", abortRequest, { once: true });
    request.send(asBufferSource(body));
  });
}

async function putStorageObjectWithFetch({
  url,
  body,
  headers,
  signal,
  onProgress,
}: {
  url: string;
  body: Uint8Array;
  headers: Record<string, string>;
  signal: AbortSignal;
  onProgress?(sentBytes: number): void;
}): Promise<StoragePutResponse> {
  if (signal.aborted) throw abortReason(signal, ABORT_MESSAGE);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers,
      body: asBufferSource(body),
      signal,
    });
  } catch {
    if (signal.aborted) throw abortReason(signal, ABORT_MESSAGE);
    throw new UploadRequestError({
      message: "The storage service could not be reached.",
      networkFailure: true,
    });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new UploadRequestError({
      message: `Storage upload failed with status ${response.status}.`,
      networkFailure: false,
      responseBody: await response.text().catch(() => ""),
      retryAfter: response.headers.get("Retry-After"),
      status: response.status,
    });
  }
  await response.body?.cancel().catch(() => undefined);
  onProgress?.(body.byteLength);
  return {
    status: response.status,
    getResponseHeader: (name) => response.headers.get(name),
  };
}
