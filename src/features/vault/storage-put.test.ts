import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyUploadFailure,
  UploadRequestError,
} from "@/features/uploads/upload-retry";
import { createFakeXhr } from "@/features/vault/fake-storage-xhr";
import { putStorageObject } from "@/features/vault/storage-put";

describe("putStorageObject", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports bytes as they leave and exposes the storage ETag", async () => {
    const xhr = createFakeXhr();
    vi.stubGlobal("XMLHttpRequest", xhr.XMLHttpRequest);
    const onProgress = vi.fn();
    const body = new Uint8Array(10).fill(7);

    const put = putStorageObject({
      url: "https://storage.invalid/part-1",
      body,
      headers: {
        "Content-Type": "application/octet-stream",
        "x-amz-checksum-sha256": "checksum",
      },
      signal: new AbortController().signal,
      onProgress,
    });
    const [request] = xhr.requests;
    expect(request).toMatchObject({
      method: "PUT",
      url: "https://storage.invalid/part-1",
      requestHeaders: {
        "Content-Type": "application/octet-stream",
        "x-amz-checksum-sha256": "checksum",
      },
    });
    expect(Array.from(request.body)).toEqual(Array.from(body));

    request.progress(4);
    // A body's framing never counts beyond the bytes the caller sent.
    request.progress(12);
    expect(onProgress.mock.calls).toEqual([[4], [10]]);
    request.respond(200, { headers: { ETag: '"part-etag"' } });

    const response = await put;
    expect(response.status).toBe(200);
    expect(response.getResponseHeader("etag")).toBe('"part-etag"');
    expect(onProgress).toHaveBeenLastCalledWith(10);
  });

  it("rejects storage refusals with the status, body and retry hint", async () => {
    const xhr = createFakeXhr();
    vi.stubGlobal("XMLHttpRequest", xhr.XMLHttpRequest);
    const onProgress = vi.fn();
    const put = putStorageObject({
      url: "https://storage.invalid/expired",
      body: Uint8Array.of(1, 2),
      headers: {},
      signal: new AbortController().signal,
      onProgress,
    });
    xhr.requests[0].respond(403, {
      headers: { "Retry-After": "2" },
      body: "<Code>ExpiredToken</Code>",
    });

    const error = await put.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(UploadRequestError);
    expect(error).toMatchObject({
      status: 403,
      responseBody: "<Code>ExpiredToken</Code>",
      retryAfter: "2",
      networkFailure: false,
    });
    expect(classifyUploadFailure(error)).toBe("refresh-url");
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("reports transport failures as retryable network failures", async () => {
    const xhr = createFakeXhr();
    vi.stubGlobal("XMLHttpRequest", xhr.XMLHttpRequest);
    const put = putStorageObject({
      url: "https://storage.invalid/offline",
      body: Uint8Array.of(1),
      headers: {},
      signal: new AbortController().signal,
    });
    xhr.requests[0].fail();

    const error = await put.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ networkFailure: true, status: null });
    expect(classifyUploadFailure(error)).toBe("retry");
  });

  it("aborts the request with the signal and rejects with an AbortError", async () => {
    const xhr = createFakeXhr();
    vi.stubGlobal("XMLHttpRequest", xhr.XMLHttpRequest);
    const controller = new AbortController();
    const put = putStorageObject({
      url: "https://storage.invalid/canceled",
      body: Uint8Array.of(1),
      headers: {},
      signal: controller.signal,
    });
    controller.abort();

    await expect(put).rejects.toMatchObject({ name: "AbortError" });
    expect(xhr.requests[0].aborted).toBe(true);
  });

  it("does not send when the signal is already aborted", async () => {
    const xhr = createFakeXhr();
    vi.stubGlobal("XMLHttpRequest", xhr.XMLHttpRequest);
    const controller = new AbortController();
    const reason = new Error("operation failed");
    controller.abort(reason);

    await expect(
      putStorageObject({
        url: "https://storage.invalid/never",
        body: Uint8Array.of(1),
        headers: {},
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(xhr.requests).toHaveLength(0);
  });
});
