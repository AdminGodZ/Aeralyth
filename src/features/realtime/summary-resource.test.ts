import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FileSummary, SummaryResource } from "./summary-resource";

const summary = (totalFiles = 1): FileSummary => ({
  totalFiles,
  totalFolders: 2,
  activeFiles: 1,
  trashedFiles: 0,
  favoriteFiles: 0,
  sharedFiles: 0,
  usedBytes: 20,
});
const reply = (totalFiles = 1) =>
  Response.json({ summary: summary(totalFiles) });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let resource: SummaryResource;
let fetcher = vi.fn<typeof fetch>();
let expired = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  fetcher = vi.fn().mockImplementation(async () => reply());
  vi.stubGlobal("fetch", fetcher);
  expired = vi.fn();
  resource = new SummaryResource(expired);
  resource.setActive(true);
});
afterEach(() => {
  resource.setActive(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("independent account counters", () => {
  it("does not refetch SSR counters on mount or when no metrics are mounted", async () => {
    const unsubscribe = resource.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).not.toHaveBeenCalled();
    unsubscribe();
    resource.invalidate();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).not.toHaveBeenCalled();
    resource.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(250);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "/api/files/summary",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(resource.getSnapshot()).toEqual(summary());
  });

  it("coalesces bulk activity and performs one trailing request after in-flight invalidation", async () => {
    const notify = vi.fn();
    resource.subscribe(notify);
    const first = deferred<Response>();
    fetcher.mockReturnValueOnce(first.promise);
    for (let i = 0; i < 1_000; i++) resource.invalidate();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetcher).toHaveBeenCalledOnce();
    for (let i = 0; i < 1_000; i++) resource.invalidate();
    await vi.advanceTimersByTimeAsync(500);
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockResolvedValueOnce(reply(2));
    first.resolve(reply(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(resource.getSnapshot()).toEqual(summary(1));
    await vi.advanceTimersByTimeAsync(250);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(resource.getSnapshot()).toEqual(summary(2));
    expect(notify).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the latest snapshot and retries invalid or transient responses using Retry-After", async () => {
    resource.subscribe(vi.fn());
    resource.invalidate();
    await vi.advanceTimersByTimeAsync(250);
    fetcher.mockResolvedValueOnce(
      new Response(null, { status: 503, headers: { "Retry-After": "5" } }),
    );
    resource.invalidate();
    await vi.advanceTimersByTimeAsync(250);
    expect(resource.getSnapshot()).toEqual(summary(1));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(
      Response.json({ summary: { ...summary(), totalFiles: -1 } }),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(resource.getSnapshot()).toEqual(summary(1));
    fetcher.mockResolvedValueOnce(reply(3));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resource.getSnapshot()).toEqual(summary(3));
  });

  it("preserves Retry-After across visibility and subscriber changes", async () => {
    fetcher.mockResolvedValueOnce(
      new Response(null, { status: 503, headers: { "Retry-After": "60" } }),
    );
    const unsubscribe = resource.subscribe(vi.fn());
    resource.invalidate();
    await vi.advanceTimersByTimeAsync(250);
    resource.setActive(false);
    unsubscribe();
    resource.subscribe(vi.fn());
    resource.setActive(true);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("aborts work while hidden and ignores an older response after resume", async () => {
    resource.subscribe(vi.fn());
    const first = deferred<Response>();
    fetcher.mockReturnValueOnce(first.promise);
    resource.invalidate();
    await vi.advanceTimersByTimeAsync(250);
    const signal = fetcher.mock.calls[0][1]?.signal as AbortSignal;
    resource.setActive(false);
    expect(signal.aborted).toBe(true);
    resource.setActive(true);
    fetcher.mockResolvedValueOnce(reply(2));
    await vi.advanceTimersByTimeAsync(250);
    expect(resource.getSnapshot()).toEqual(summary(2));
    first.resolve(reply(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(resource.getSnapshot()).toEqual(summary(2));
  });

  it("accepts a fresh SSR counter snapshot and prevents an older response from reverting it", async () => {
    resource.subscribe(vi.fn());
    resource.acceptSnapshot(summary(100));
    const pending = deferred<Response>();
    fetcher.mockReturnValueOnce(pending.promise);
    resource.invalidate();
    await vi.advanceTimersByTimeAsync(250);
    const signal = fetcher.mock.calls[0][1]?.signal as AbortSignal;
    resource.acceptSnapshot(summary(101));
    expect(signal.aborted).toBe(true);
    expect(resource.getSnapshot()).toEqual(summary(101));
    pending.resolve(reply(100));
    await vi.advanceTimersByTimeAsync(0);
    expect(resource.getSnapshot()).toEqual(summary(101));
    fetcher.mockResolvedValueOnce(reply(102));
    await vi.advanceTimersByTimeAsync(250);
    expect(resource.getSnapshot()).toEqual(summary(102));
  });

  it("reconciles an older SSR commit after a newer live read already completed", async () => {
    resource.subscribe(vi.fn());
    fetcher.mockResolvedValueOnce(reply(3));
    resource.invalidate();
    await vi.advanceTimersByTimeAsync(250);
    expect(resource.getSnapshot()).toEqual(summary(3));
    resource.acceptSnapshot(summary(2));
    fetcher.mockResolvedValueOnce(reply(3));
    await vi.advanceTimersByTimeAsync(250);
    expect(resource.getSnapshot()).toEqual(summary(3));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves optional tree-operation status across live reads and SSR snapshots", async () => {
    resource.subscribe(vi.fn());
    fetcher.mockResolvedValueOnce(
      Response.json({ summary: { ...summary(), treeOperationPending: true } }),
    );
    resource.invalidate();
    await vi.advanceTimersByTimeAsync(250);
    expect(resource.getSnapshot()?.treeOperationPending).toBe(true);
    resource.acceptSnapshot({ ...summary(), treeOperationPending: false });
    expect(resource.getSnapshot()?.treeOperationPending).toBe(false);
    fetcher.mockResolvedValueOnce(
      Response.json({ summary: { ...summary(), treeOperationPending: false } }),
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(resource.getSnapshot()?.treeOperationPending).toBe(false);
    resource.acceptSnapshot({ ...summary(), treeOperationPending: true });
    fetcher.mockResolvedValueOnce(
      Response.json({ summary: { ...summary(), treeOperationPending: true } }),
    );
    await vi.advanceTimersByTimeAsync(250);
    resource.acceptSnapshot(summary());
    fetcher.mockResolvedValueOnce(reply());
    await vi.advanceTimersByTimeAsync(250);
    expect(resource.getSnapshot()?.treeOperationPending).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each(["true", 1, null])(
    "rejects a nonboolean tree-operation marker %s",
    async (treeOperationPending) => {
      resource.subscribe(vi.fn());
      resource.acceptSnapshot(summary());
      fetcher.mockResolvedValueOnce(
        Response.json({ summary: { ...summary(2), treeOperationPending } }),
      );
      resource.invalidate();
      await vi.advanceTimersByTimeAsync(250);
      expect(resource.getSnapshot()).toEqual(summary());
    },
  );

  it("fails expired sessions without continuing retries", async () => {
    fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
    resource.subscribe(vi.fn());
    resource.invalidate();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(expired).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
