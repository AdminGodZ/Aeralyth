import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("vault lock lifecycle", () => {
  it("routes auto-lock through the common synchronous locking event", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "vault-provider.tsx"),
      "utf8",
    );

    expect(source).toContain(
      "window.dispatchEvent(new Event(VAULT_LOCKING_EVENT))",
    );
    const autoLock = source
      .split("const scheduleLock = useCallback(")[1]
      ?.split("useEffect(() => {")[0];
    expect(autoLock).toContain("void lock();");
    expect(autoLock).not.toContain("clientRef.current?.lock()");
  });

  it("checks the worker session before restoring persistent plaintext metadata", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "vault.worker.ts"),
      "utf8",
    );
    const cachedMetadata = source
      .split("async function getCachedMetadata(")[1]
      ?.split("async function openMetadataPlans(")[0];
    expect(cachedMetadata).toBeTruthy();

    const persistentRead = cachedMetadata?.indexOf(
      "await readPersistentMetadata(persistentMisses)",
    );
    const sessionGuard = cachedMetadata?.indexOf(
      "assertVaultSession(sessionGeneration)",
      persistentRead,
    );
    const memoryWrite = cachedMetadata?.indexOf(
      "rememberMetadata(cached)",
      persistentRead,
    );

    expect(persistentRead).toBeGreaterThanOrEqual(0);
    expect(sessionGuard).toBeGreaterThan(persistentRead ?? -1);
    expect(memoryWrite).toBeGreaterThan(sessionGuard ?? -1);
  });

  it("keeps encrypted persistent-cache writes off metadata return paths", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "vault.worker.ts"),
      "utf8",
    );
    const openPlan = source
      .split("async function openPlan(")[1]
      ?.split("async function getCachedMetadata(")[0];
    const openBatch = source
      .split("async function openMetadataPlans(")[1]
      ?.split("async function openMetadataPlanSet(")[0];

    expect(openPlan).toContain("void writePersistentMetadata([cached])");
    expect(openPlan).not.toContain("await writePersistentMetadata");
    expect(openBatch?.match(/void writePersistentMetadata/g)).toHaveLength(2);
    expect(openBatch).not.toContain("await writePersistentMetadata");
  });
});
