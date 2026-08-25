import { describe, expect, it } from "vitest";

import { BoundedLruCache } from "@/features/vault/bounded-lru-cache";

describe("bounded LRU cache", () => {
  it("evicts the least recently used entry at its fixed limit", () => {
    const cache = new BoundedLruCache<string, number>(3);
    cache.set("oldest", 1);
    cache.set("kept", 2);
    cache.set("newer", 3);

    expect(cache.get("oldest")).toBe(1);
    cache.set("newest", 4);

    expect(cache.has("oldest")).toBe(true);
    expect(cache.has("kept")).toBe(false);
    expect(cache.size).toBe(3);
  });

  it("keeps active entries pinned and trims the overflow on release", () => {
    const cache = new BoundedLruCache<string, number>(2);
    cache.set("active-a", 1);
    cache.set("active-b", 2);
    const first = cache.pin("active-a");
    const second = cache.pin("active-b");

    cache.set("pending", 3);

    expect(cache.size).toBe(3);
    expect(first?.value).toBe(1);
    expect(second?.value).toBe(2);
    first?.release();
    first?.release();

    expect(cache.size).toBe(2);
    expect(cache.has("active-a")).toBe(false);
    expect(cache.has("active-b")).toBe(true);
    expect(cache.has("pending")).toBe(true);
    second?.release();
  });

  it("reaches a stable plateau under a long sequence of keys", () => {
    const cache = new BoundedLruCache<number, number>(1_024);
    for (let key = 0; key < 20_000; key += 1) cache.set(key, key);

    expect(cache.size).toBe(1_024);
    expect(cache.has(0)).toBe(false);
    expect(cache.get(19_999)).toBe(19_999);
  });

  it("defers replacement of a pinned key until its last lease releases", () => {
    const cache = new BoundedLruCache<string, string>(2);
    cache.set("parent", "old-key");
    const first = cache.pin("parent");
    const second = cache.pin("parent");

    cache.set("parent", "new-key");

    expect(cache.get("parent")).toBe("old-key");
    first?.release();
    expect(cache.get("parent")).toBe("old-key");
    second?.release();
    expect(cache.get("parent")).toBe("new-key");
    expect(cache.size).toBe(1);
  });

  it("exposes only safe eviction candidates to a shared cache budget", () => {
    const cache = new BoundedLruCache<string, number>(3);
    cache.set("pinned", 1);
    cache.set("oldest-free", 2);
    cache.set("newest-free", 3);
    const lease = cache.pin("pinned");

    expect(cache.oldestUnpinnedKey()).toBe("oldest-free");
    expect(cache.deleteIfUnpinned("pinned", 1)).toBe(false);
    expect(cache.deleteIfUnpinned("oldest-free", 7)).toBe(false);
    expect(cache.deleteIfUnpinned("oldest-free", 2)).toBe(true);

    lease?.release();
    expect(cache.isPinned("pinned")).toBe(false);
  });
});
