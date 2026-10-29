import { afterEach, describe, expect, it, vi } from "vitest";

import { mutateFileTree, mutateFileTrees } from "@/features/vault/vault-api";

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

  it("applies a selection with one batch request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ completed: ["a", "c"], missing: ["b"], deferred: [] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      mutateFileTrees(["a", "b", "c"], "trash", "csrf"),
    ).resolves.toEqual({ completed: ["a", "c"], missing: ["b"], deferred: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/files/operations");
    expect(init.method).toBe("POST");
    expect(init.headers["X-CSRF-Token"]).toBe("csrf");
    expect(JSON.parse(init.body)).toEqual({
      action: "trash",
      ids: ["a", "b", "c"],
    });
  });

  it("splits large selections into 256-id requests", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const { ids } = JSON.parse(String(init.body)) as { ids: string[] };
      return Response.json({ completed: ids, missing: [], deferred: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ids = Array.from({ length: 600 }, (_, index) => `id-${index}`);
    const result = await mutateFileTrees(ids, "delete", "csrf");
    expect(result.completed).toEqual(ids);
    expect(
      fetchMock.mock.calls.map(
        ([, init]) =>
          (JSON.parse(String(init.body)) as { ids: string[] }).ids.length,
      ),
    ).toEqual([256, 256, 88]);
  });

  it("defers everything to the per-item path on an API without the batch route", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      mutateFileTrees(["a", "b"], "restore", "csrf"),
    ).resolves.toEqual({ completed: [], missing: [], deferred: ["a", "b"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not trust a batch response that names other ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ completed: ["a", "x"], missing: [], deferred: [] }),
        ),
    );
    await expect(mutateFileTrees(["a", "b"], "trash", "csrf")).resolves.toEqual(
      { completed: [], missing: [], deferred: ["a", "b"] },
    );
  });

  it("retries a busy batch before falling back", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("busy", { status: 503, headers: { "Retry-After": "1" } }),
      )
      .mockResolvedValueOnce(
        Response.json({ completed: ["a"], missing: [], deferred: [] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const operation = mutateFileTrees(["a"], "trash", "csrf");
    await vi.runAllTimersAsync();
    await expect(operation).resolves.toEqual({
      completed: ["a"],
      missing: [],
      deferred: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
