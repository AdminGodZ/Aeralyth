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
});
