type CacheEntry<Value> = {
  value: Value;
  pendingValue?: Value;
  hasPendingValue: boolean;
  pins: number;
};

export type CacheLease<Value> = {
  value: Value;
  release(): void;
};

export class BoundedLruCache<Key, Value> {
  private readonly entries = new Map<Key, CacheEntry<Value>>();

  constructor(private readonly maximumEntries: number) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error("The cache entry limit must be a positive integer.");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: Key): boolean {
    return this.entries.has(key);
  }

  get(key: Key): Value | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: Key, value: Value): void {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.pins > 0) {
        existing.pendingValue = value;
        existing.hasPendingValue = true;
      } else existing.value = value;
      this.entries.delete(key);
      this.entries.set(key, existing);
    } else {
      this.entries.set(key, { value, pins: 0, hasPendingValue: false });
    }
    this.trim(key);
  }

  delete(key: Key): boolean {
    return this.entries.delete(key);
  }

  deleteIfUnpinned(key: Key, expectedValue?: Value): boolean {
    const entry = this.entries.get(key);
    if (
      !entry ||
      entry.pins > 0 ||
      (expectedValue !== undefined && entry.value !== expectedValue)
    ) {
      return false;
    }
    return this.entries.delete(key);
  }

  isPinned(key: Key): boolean {
    return (this.entries.get(key)?.pins ?? 0) > 0;
  }

  oldestUnpinnedKey(): Key | undefined {
    for (const [key, entry] of this.entries) {
      if (entry.pins === 0) return key;
    }
    return undefined;
  }

  keys(): IterableIterator<Key> {
    return this.entries.keys();
  }

  clear(): void {
    this.entries.clear();
  }

  pin(key: Key): CacheLease<Value> | null {
    const value = this.get(key);
    if (value === undefined) return null;
    const entry = this.entries.get(key);
    if (!entry) return null;
    entry.pins += 1;
    let active = true;
    return {
      value,
      release: () => {
        if (!active) return;
        active = false;
        if (this.entries.get(key) === entry) {
          entry.pins -= 1;
          if (entry.pins === 0 && entry.hasPendingValue) {
            entry.value = entry.pendingValue as Value;
            entry.pendingValue = undefined;
            entry.hasPendingValue = false;
          }
          this.trim();
        }
      },
    };
  }

  private trim(protectedKey?: Key): void {
    while (this.entries.size > this.maximumEntries) {
      let removed = false;
      for (const [key, entry] of this.entries) {
        if (entry.pins > 0 || key === protectedKey) continue;
        this.entries.delete(key);
        removed = true;
        break;
      }
      if (!removed) return;
    }
  }
}
