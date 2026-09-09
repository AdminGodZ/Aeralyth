import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeChange } from "./changes";
import { RealtimeConnection } from "./connection";

class FakeSource {
  static instances: FakeSource[] = [];
  listeners = new Map<string, (event: MessageEvent) => void>();
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) {
    FakeSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, listener);
  }
  emit(type: string, cursor = "10", data = "{}") {
    this.listeners.get(type)?.({ lastEventId: cursor, data } as MessageEvent);
  }
}

const files = [{ scope: "files", folderIds: ["folder"] }];
const reply = (cursor: string, changes: unknown[] = [], reset = false) =>
  Response.json({ cursor, reset, changes });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let connection: RealtimeConnection;
let changed = vi.fn<(changes: RealtimeChange[], reset: boolean) => void>();
let expired = vi.fn<() => void>();
let fetcher = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  FakeSource.instances = [];
  vi.stubGlobal("EventSource", FakeSource);
  fetcher = vi.fn().mockResolvedValue(reply("10"));
  vi.stubGlobal("fetch", fetcher);
  changed = vi.fn();
  expired = vi.fn();
  connection = new RealtimeConnection(changed, expired);
  connection.setActive(true);
});
afterEach(() => {
  connection.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("realtime stream recovery", () => {
  it("uses SSE without polling while healthy, including unchanged checkpoints", async () => {
    const source = FakeSource.instances[0];
    source.emit("reset");
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      source.emit("checkpoint");
    }
    source.emit("changes", "11", JSON.stringify(files));
    expect(fetcher).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenLastCalledWith(files, false);
  });

  it("catches up immediately on error and each second until real frames resume", async () => {
    const source = FakeSource.instances[0];
    source.emit("reset");
    changed.mockClear();
    fetcher.mockResolvedValueOnce(reply("11", files));
    source.onerror?.();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/events/sync?cursor=10",
      expect.anything(),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenCalledExactlyOnceWith(files, false);
    expect(source.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);
    const reconnect = FakeSource.instances[1];
    expect(reconnect.url).toBe("/api/events?cursor=11");
    fetcher.mockResolvedValue(reply("11"));
    await vi.advanceTimersByTimeAsync(750);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledOnce();
    reconnect.emit("checkpoint", "11");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("ignores a late catch-up response after SSE has already delivered newer changes", async () => {
    const pending = deferred<Response>();
    fetcher.mockReturnValue(pending.promise);
    FakeSource.instances[0].emit("reset");
    FakeSource.instances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(250);
    FakeSource.instances[1].emit("changes", "12", JSON.stringify(files));
    pending.resolve(reply("11", [{ scope: "profile", folderIds: [] }]));
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenCalledTimes(2);
    FakeSource.instances[1].onerror?.();
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/events/sync?cursor=12",
      expect.anything(),
    );
  });

  it("does not regress when a delayed initial stream frame trails a successful catch-up", async () => {
    FakeSource.instances[0].emit("reset");
    const pending = deferred<Response>();
    fetcher.mockReturnValue(pending.promise);
    FakeSource.instances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(250);
    pending.resolve(reply("9007199254740993", files));
    await vi.advanceTimersByTimeAsync(0);
    const reconnect = FakeSource.instances[1];
    reconnect.emit("checkpoint", "10");
    reconnect.emit("changes", "9007199254740994", JSON.stringify(files));
    reconnect.onerror?.();
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/events/sync?cursor=9007199254740994",
      expect.anything(),
    );
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("recovers silently hung connections and missing heartbeats", async () => {
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeSource.instances[0].close).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);
    FakeSource.instances[1].emit("checkpoint");
    await vi.advanceTimersByTimeAsync(7_999);
    expect(FakeSource.instances[1].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSource.instances[1].close).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never overlaps catch-up requests, and stops work when hidden or disposed", async () => {
    const pending = deferred<Response>();
    fetcher.mockReturnValue(pending.promise);
    FakeSource.instances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(250);
    FakeSource.instances[1].onerror?.();
    expect(fetcher).toHaveBeenCalledOnce();
    const signal = fetcher.mock.calls[0][1]?.signal as AbortSignal;
    connection.setActive(false);
    expect(signal.aborted).toBe(true);
    pending.resolve(reply("11", files));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(changed).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
    connection.setActive(true);
    expect(FakeSource.instances).toHaveLength(3);
    connection.dispose();
    FakeSource.instances[2].emit("changes", "12", JSON.stringify(files));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(changed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the current page during outages and invalid replies, and retries", async () => {
    fetcher.mockRejectedValueOnce(new Error("offline"));
    FakeSource.instances[0].emit("reset");
    changed.mockClear();
    FakeSource.instances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockResolvedValueOnce(
      Response.json({
        cursor: "9223372036854775808",
        reset: true,
        changes: [],
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(changed).not.toHaveBeenCalled();
    expect(expired).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(reply("11", files));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(changed).toHaveBeenCalledExactlyOnceWith(files, false);
  });

  it.each(["stream", "catch-up"])(
    "expires revoked sessions through %s",
    async (channel) => {
      if (channel === "stream") FakeSource.instances[0].emit("session-expired");
      else {
        fetcher.mockResolvedValue(new Response(null, { status: 401 }));
        FakeSource.instances[0].onerror?.();
      }
      await vi.advanceTimersByTimeAsync(10_000);
      expect(expired).toHaveBeenCalledOnce();
      expect(changed).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
