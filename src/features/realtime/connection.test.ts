import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeChange } from "./changes";
import {
  RealtimeConnection,
  recoveryDelay,
  retryAfterDelay,
} from "./connection";

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
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  FakeSource.instances = [];
  vi.stubGlobal("EventSource", FakeSource);
  fetcher = vi.fn().mockImplementation(async () => reply("10"));
  vi.stubGlobal("fetch", fetcher);
  changed = vi.fn();
  expired = vi.fn();
  connection = new RealtimeConnection(changed, expired);
  connection.setActive(true);
});
afterEach(() => {
  connection.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("realtime stream recovery", () => {
  it("does no polling while frames arrive, including unchanged checkpoints", async () => {
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

  it("serializes replay and reconnect through one jittered recovery budget", async () => {
    const source = FakeSource.instances[0];
    source.emit("reset");
    changed.mockClear();
    fetcher.mockResolvedValueOnce(reply("11", files));
    source.onerror?.();
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "/api/events/sync?cursor=10",
      expect.anything(),
    );
    expect(changed).toHaveBeenCalledExactlyOnceWith(files, false);
    expect(FakeSource.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    const reconnect = FakeSource.instances[1];
    expect(reconnect.url).toBe("/api/events?cursor=11&reconnect=1");
    reconnect.emit("checkpoint", "11");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("backs off failed replay without adding competing SSE attempts", async () => {
    fetcher.mockRejectedValue(new Error("offline"));
    FakeSource.instances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(FakeSource.instances).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
  });

  it("honors Retry-After on transient responses across offline and online transitions", async () => {
    fetcher.mockResolvedValueOnce(
      new Response(null, { status: 503, headers: { "Retry-After": "20" } }),
    );
    FakeSource.instances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(1_000);
    connection.setActive(false);
    connection.setActive(true);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_001);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(expired).not.toHaveBeenCalled();
  });

  it("does not overflow the timer when Retry-After exceeds the timer range", async () => {
    fetcher.mockResolvedValueOnce(
      new Response(null, {
        status: 503,
        headers: { "Retry-After": "9999999999999999" },
      }),
    );
    FakeSource.instances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("allows a slow first frame and recovers three missed heartbeat intervals", async () => {
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSource.instances[0].close).not.toHaveBeenCalled();
    FakeSource.instances[0].emit("checkpoint");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(501);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(FakeSource.instances[0].close).toHaveBeenCalledOnce();
  });

  it("never overlaps replay, rejects abandoned responses, and aborts on hiding", async () => {
    const pending = deferred<Response>();
    fetcher.mockReturnValueOnce(pending.promise);
    FakeSource.instances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(FakeSource.instances).toHaveLength(1);
    const signal = fetcher.mock.calls[0][1]?.signal as AbortSignal;
    connection.setActive(false);
    expect(signal.aborted).toBe(true);
    connection.setActive(true);
    await vi.advanceTimersByTimeAsync(1_000);
    pending.resolve(reply("50", files));
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).not.toHaveBeenCalled();
    connection.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the SSR fence for mount and resume, replaying only actual changes or gaps", () => {
    connection.dispose();
    connection = new RealtimeConnection(changed, expired, "10");
    connection.setActive(true);
    const source = FakeSource.instances[FakeSource.instances.length - 1];
    expect(source.url).toBe("/api/events?cursor=10");
    source.emit("checkpoint", "10");
    expect(changed).not.toHaveBeenCalled();
    source.emit("changes", "11", JSON.stringify(files));
    connection.setActive(false);
    connection.setActive(true);
    const resumed = FakeSource.instances[FakeSource.instances.length - 1];
    expect(resumed.url).toBe("/api/events?cursor=11&reconnect=1");
    resumed.emit("checkpoint", "11");
    expect(changed).toHaveBeenCalledTimes(1);
    resumed.emit("reset", "20");
    expect(changed).toHaveBeenLastCalledWith([], true);
  });

  it("handles exact 64-bit cursors and ignores older stream frames", () => {
    const source = FakeSource.instances[0];
    source.emit("reset");
    source.emit("changes", "9007199254740993", JSON.stringify(files));
    source.emit("changes", "9007199254740992", JSON.stringify(files));
    source.emit("changes", "9007199254740994", JSON.stringify(files));
    expect(changed).toHaveBeenCalledTimes(3);
    connection.setActive(false);
    connection.setActive(true);
    expect(FakeSource.instances[FakeSource.instances.length - 1].url).toBe(
      "/api/events?cursor=9007199254740994&reconnect=1",
    );
  });

  it.each(["stream", "replay"])(
    "expires revoked sessions through %s",
    async (channel) => {
      if (channel === "stream") FakeSource.instances[0].emit("session-expired");
      else {
        fetcher.mockResolvedValue(new Response(null, { status: 401 }));
        FakeSource.instances[0].onerror?.();
      }
      await vi.advanceTimersByTimeAsync(30_000);
      expect(expired).toHaveBeenCalledOnce();
      expect(changed).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("spreads a synchronized failing cohort without multiplying transports", async () => {
    connection.dispose();
    const cohort: RealtimeConnection[] = [];
    fetcher.mockRejectedValue(new Error("capacity"));
    const times: number[] = [];
    fetcher.mockImplementation(async () => {
      times.push(Date.now());
      throw new Error("capacity");
    });
    for (let index = 0; index < 100; index++) {
      vi.mocked(Math.random).mockReturnValue(index / 100);
      const client = new RealtimeConnection(vi.fn(), vi.fn(), "10");
      cohort.push(client);
      client.setActive(true);
      FakeSource.instances[FakeSource.instances.length - 1].onerror?.();
    }
    await vi.advanceTimersByTimeAsync(1_500);
    expect(times).toHaveLength(100);
    expect(new Set(times).size).toBe(100);
    expect(FakeSource.instances).toHaveLength(101);
    for (const client of cohort) client.dispose();
  });
});

it("caps full jitter and parses Retry-After seconds and dates", () => {
  expect(recoveryDelay(0, 0)).toBe(0);
  expect(recoveryDelay(100, 0.999)).toBe(9_990);
  expect(retryAfterDelay("3")).toBe(3_000);
  expect(retryAfterDelay("Thu, 01 Jan 1970 00:00:10 GMT", 1_000)).toBe(9_000);
  expect(retryAfterDelay("invalid")).toBe(0);
});
