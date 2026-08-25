import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("vault worker session ordering", () => {
  it("queues every counter-dependent session transition", () => {
    const worker = readFileSync(
      resolve(import.meta.dirname, "vault.worker.ts"),
      "utf8",
    );
    const dispatch = worker
      .split("async function dispatch(")[1]
      ?.split("function transferableBuffers(")[0];

    expect(dispatch).toBeTruthy();
    expect(
      dispatch?.match(/sessionOperations\.run\(request\.sessionId/g),
    ).toHaveLength(6);
    for (const operation of [
      "encryptChunk",
      "finalizeEncryption",
      "abortEncryption",
      "decryptChunk",
      "finalizeDecryption",
      "abortDecryption",
    ]) {
      expect(dispatch).toContain(operation);
    }
  });

  it("wipes a queued chunk when locking removed its encryption session", () => {
    const worker = readFileSync(
      resolve(import.meta.dirname, "vault.worker.ts"),
      "utf8",
    );
    const encryptChunk = worker
      .split("async function encryptChunk(")[1]
      ?.split("async function finalizeEncryption(")[0];
    const sessionLookup = encryptChunk?.indexOf(
      "session = requireEncryptionSession(sessionId)",
    );
    const missingSessionWipe = encryptChunk?.indexOf("wipe(plaintext)");

    expect(encryptChunk).toContain("catch (error)");
    expect(sessionLookup).toBeGreaterThanOrEqual(0);
    expect(missingSessionWipe).toBeGreaterThan(
      sessionLookup ?? Number.MAX_VALUE,
    );
  });
});
