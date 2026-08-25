import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyUploadFailure,
  retryDelayMilliseconds,
  runUploadWithRetry,
  UploadRequestError,
  waitForUploadRetry,
} from "@/features/uploads/upload-retry";

function failure(
  status: number,
  responseBody = "",
  retryAfter: string | null = null,
) {
  return new UploadRequestError({
    message: `failed ${status}`,
    responseBody,
    retryAfter,
    status,
  });
}

describe("upload retry policy", () => {
  afterEach(() => vi.useRealTimers());

  it.each([408, 429, 500, 502, 503, 504])(
    "retries transient HTTP %i",
    (status) => {
      expect(classifyUploadFailure(failure(status))).toBe("retry");
    },
  );

  it.each([400, 401, 404, 409, 413, 422])(
    "fails permanent HTTP %i without retrying",
    async (status) => {
      const request = vi.fn().mockRejectedValue(failure(status));

      await expect(
        runUploadWithRetry({
          initialUrl: "https://storage.invalid/initial",
          request,
          signal: new AbortController().signal,
          wait: vi.fn(),
        }),
      ).rejects.toThrow(`failed ${status}`);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("retries a network failure with full jitter", async () => {
    const networkFailure = new UploadRequestError({
      message: "offline",
      networkFailure: true,
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(networkFailure)
      .mockResolvedValue("uploaded");
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      runUploadWithRetry({
        initialUrl: "https://storage.invalid/object",
        request,
        signal: new AbortController().signal,
        random: () => 0.5,
        wait,
      }),
    ).resolves.toBe("uploaded");
    expect(wait).toHaveBeenCalledWith(200, expect.any(AbortSignal));
  });

  it("uses Retry-After instead of jitter", () => {
    expect(retryDelayMilliseconds(failure(429, "", "2"), 0, () => 0)).toBe(
      2_000,
    );
    expect(
      retryDelayMilliseconds(
        failure(503, "", "Thu, 01 Jan 2026 00:00:03 GMT"),
        0,
        () => 0,
        () => Date.parse("Thu, 01 Jan 2026 00:00:00 GMT"),
      ),
    ).toBe(3_000);
  });

  it.each(["ExpiredToken", "Request has expired", "SignatureDoesNotMatch"])(
    "refreshes a presigned URL for %s",
    async (marker) => {
      const request = vi
        .fn()
        .mockRejectedValueOnce(failure(403, `<Code>${marker}</Code>`))
        .mockResolvedValue("uploaded");
      const refreshUrl = vi
        .fn()
        .mockResolvedValue("https://storage.invalid/refreshed");

      await expect(
        runUploadWithRetry({
          initialUrl: "https://storage.invalid/expired",
          refreshUrl,
          request,
          signal: new AbortController().signal,
        }),
      ).resolves.toBe("uploaded");
      expect(refreshUrl).toHaveBeenCalledOnce();
      expect(request).toHaveBeenLastCalledWith(
        "https://storage.invalid/refreshed",
      );
    },
  );

  it("does not refresh an unrelated 403", () => {
    expect(classifyUploadFailure(failure(403, "AccessDenied"))).toBe("fail");
  });

  it("removes the abort listener when a retry timer resolves", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = waitForUploadRetry(100, controller.signal);

    await vi.advanceTimersByTimeAsync(100);
    await waiting;

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("rejects a retry timer that starts after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForUploadRetry(100, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
