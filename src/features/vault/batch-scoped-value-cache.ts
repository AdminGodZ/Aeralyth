export class BatchScopedValueCache<Value> {
  private readonly entries = new Map<
    string,
    { fingerprint: string; value: Promise<Value> }
  >();

  getOrLoad(
    key: string,
    fingerprint: string,
    load: () => Promise<Value>,
  ): Promise<Value> {
    const cached = this.entries.get(key);
    if (cached?.fingerprint === fingerprint) return cached.value;

    const value = load();
    const entry = { fingerprint, value };
    this.entries.set(key, entry);
    void value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return value;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
