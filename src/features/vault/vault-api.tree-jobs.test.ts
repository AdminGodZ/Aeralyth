import { afterEach, describe, expect, it, vi } from "vitest";

import { mutateFileTree } from "@/features/vault/vault-api";

describe("durable tree operation API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps small operations synchronous", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ status: "trashed", fileId: "root" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(mutateFileTree("root", "trash", "csrf")).resolves.toEqual({
      status: "trashed",
      fileId: "root",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits for committed completion and never replays an accepted mutation", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { status: "queued", fileId: "root", jobId: "17" },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ status: "running", fileId: "root", action: "restore" }),
      )
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        new Response("temporarily unavailable", { status: 503 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: "complete",
          fileId: "root",
          action: "restore",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const completed = vi.fn();
    const operation = mutateFileTree("root", "restore", "csrf").then(completed);
    await vi.advanceTimersByTimeAsync(1100);
    expect(completed).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await operation;
    expect(completed).toHaveBeenCalledWith({
      status: "restored",
      fileId: "root",
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/files/root/restore",
      "/api/files/operations/17",
      "/api/files/operations/17",
      "/api/files/operations/17",
      "/api/files/operations/17",
    ]);
  });

  it("stops observing on cancellation without cancelling the accepted server job", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { status: "queued", fileId: "root", jobId: "18" },
          { status: 202 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const operation = mutateFileTree(
      "root",
      "delete",
      "csrf",
      controller.signal,
    );
    const rejection = expect(operation).rejects.toBe("closed");
    await vi.advanceTimersByTimeAsync(10);
    controller.abort("closed");
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
