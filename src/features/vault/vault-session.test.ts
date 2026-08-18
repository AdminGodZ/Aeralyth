import { describe, expect, it } from "vitest";

import {
  clearVaultResumeMarker,
  readVaultResumeMarker,
  VAULT_RESUME_STORAGE_KEY,
  type VaultResumeMarker,
  writeVaultResumeMarker,
} from "@/features/vault/vault-session";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const NOW = 1_800_000_000_000;
const MARKER: VaultResumeMarker = {
  version: 1,
  sessionId: "vrs_ABCDEFGHIJKLMNOPQRSTUVWX",
  expiresAt: NOW + 60_000,
};

describe("vault resume marker", () => {
  it("survives a reload-shaped read while its inactivity deadline is active", () => {
    const storage = new MemoryStorage();

    expect(writeVaultResumeMarker(storage, MARKER)).toBe(true);
    expect(readVaultResumeMarker(storage, NOW)).toEqual(MARKER);
  });

  it("removes an expired marker instead of restoring the vault", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      VAULT_RESUME_STORAGE_KEY,
      JSON.stringify({ ...MARKER, expiresAt: NOW - 1 }),
    );

    expect(readVaultResumeMarker(storage, NOW)).toBeNull();
    expect(storage.getItem(VAULT_RESUME_STORAGE_KEY)).toBeNull();
  });

  it("rejects malformed or implausibly long-lived markers", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      VAULT_RESUME_STORAGE_KEY,
      JSON.stringify({ ...MARKER, expiresAt: NOW + 62 * 60_000 }),
    );

    expect(readVaultResumeMarker(storage, NOW)).toBeNull();

    storage.setItem(VAULT_RESUME_STORAGE_KEY, "not-json");
    expect(readVaultResumeMarker(storage, NOW)).toBeNull();
  });

  it("clears the tab marker on explicit lock", () => {
    const storage = new MemoryStorage();
    writeVaultResumeMarker(storage, MARKER);

    clearVaultResumeMarker(storage);

    expect(storage.length).toBe(0);
  });
});
