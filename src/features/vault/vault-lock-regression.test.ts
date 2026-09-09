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
    expect(source).toContain("cancelShareDirectorySyncForLock();");
    const autoLock = source
      .split("const scheduleLock = (resetExpiredDeadline = false) => {")[1]
      ?.split("const activity = () => scheduleLock();")[0];
    expect(autoLock).toContain("void lock();");
    expect(autoLock).not.toContain("clientRef.current?.lock()");
  });

  it("resumes a still-active tab session across refresh instead of locking on pagehide", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "vault-provider.tsx"),
      "utf8",
    );

    expect(source).toContain("readVaultResumeMarker(storage)");
    expect(source).toContain("await client.resume(");
    expect(source).toContain("extendSession(");
    expect(source).not.toContain('addEventListener("pagehide"');
  });

  it("binds the resume record to the server session and a non-extractable root key", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "vault.worker.ts"),
      "utf8",
    );

    const storedSession = source
      .split("type StoredVaultResumeSession = {")[1]
      ?.split("};")[0];
    const resumeValidation = source
      .split("async function resumeVaultSession(")[1]
      ?.split("async function persistVaultResumeSession(")[0];

    expect(storedSession).toContain("sessionBindingHash: string");
    expect(storedSession).toContain("identityFingerprint: string");
    expect(storedSession).toContain("rootKey: CryptoKey");
    expect(storedSession).not.toContain("password");
    expect(resumeValidation).toContain(
      "!validVaultResumeExpiration(stored.expiresAt, now)",
    );
    expect(resumeValidation).toContain(
      "stored.sessionBindingHash !== sessionBindingHash",
    );
    expect(resumeValidation).toContain(
      "stored.identityFingerprint !== material.identity.fingerprintSha256",
    );
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
    expect(openBatch).toContain("persistCompletedMetadataOperation(");
    expect(openBatch).not.toContain("await writePersistentMetadata");
  });

  it("cooperatively cancels metadata crypto and shares its manifest/key budget", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "vault.worker.ts"),
      "utf8",
    );
    const client = readFileSync(
      resolve(import.meta.dirname, "vault-client.ts"),
      "utf8",
    );

    expect(client).toContain('type: "cancelMetadataOperation"');
    expect(source).toContain("assertMetadataOperationActive(");
    expect(source).toContain("evictMetadataOperation(operation)");
    expect(source).toContain("combinedMetadataEntryCount()");
    expect(source).toContain(
      "metadataMemoryBytes + nodeKeys.size * NODE_KEY_ACCOUNTED_BYTES",
    );
    expect(source).toContain("nodeKeys.isPinned(nodeId)");
  });

  it("does not render shared plaintext until the current grant is revalidated", () => {
    const resolver = readFileSync(
      resolve(import.meta.dirname, "vault-metadata-resolver.ts"),
      "utf8",
    );
    const listing = readFileSync(
      resolve(import.meta.dirname, "vault-file-list.tsx"),
      "utf8",
    );

    expect(resolver).toContain("options.requireServerValidation");
    expect(resolver).toContain(
      "const cached = options.requireServerValidation",
    );
    expect(resolver).toContain(": this.getMetadata(key)");
    expect(listing).toContain(
      'requireServerValidation: sectionKey === "shared"',
    );
    expect(listing).toContain("sharedMetadataValidated &&");
    expect(listing).toContain("setSharedValidatedSource(null)");
  });

  it("wipes active crypto sessions instead of only dropping their maps", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "vault.worker.ts"),
      "utf8",
    );
    const lockLifecycle = source
      .split("function lockVault(): void {")[1]
      ?.split("async function decryptShareContexts(")[0];

    expect(lockLifecycle).toContain(
      "for (const [sessionId, session] of encryptionSessions)",
    );
    expect(lockLifecycle).toContain(
      "abortEncryption(sessionId, session.nodeId)",
    );
    expect(lockLifecycle).toContain("abortDecryption(sessionId)");
    expect(lockLifecycle).toContain("shareContextCache.clear()");
    expect(lockLifecycle).not.toContain("encryptionSessions.clear()");

    const abortEncryption = source
      .split("function abortEncryption(")[1]
      ?.split("async function createShareDirectory(")[0];
    const abortDecryption = source
      .split("function abortDecryption(")[1]
      ?.split("function openAndVerifyPlanSingleFlight(")[0];
    expect(abortEncryption).toContain("session.generationId");
    expect(abortEncryption).toContain("session.manifest.generationId");
    expect(abortDecryption).toContain("session.generationId");
    expect(abortDecryption).toContain("session.manifest.generationId");
  });

  it("reuses immutable share contexts only inside an explicit batch", () => {
    const worker = readFileSync(
      resolve(import.meta.dirname, "vault.worker.ts"),
      "utf8",
    );
    const sync = readFileSync(
      resolve(import.meta.dirname, "share-directory-sync.ts"),
      "utf8",
    );

    expect(worker).toContain("shareContextCache.getOrLoad(");
    expect(worker).toContain("shareId,");
    expect(worker).toContain("wrapperId,");
    expect(worker).toContain("ciphertext,");
    expect(sync).toContain("beginShareDirectorySyncBatch");
    expect(sync).toContain("finishShareDirectorySyncBatch");
    expect(sync).toContain("batch.contextFlights.delete(contextKey)");
    expect(sync).toContain(".clearShareContextCache(workerCacheKey)");
    expect(sync).toContain("cancelShareDirectorySyncForLock");
    const createShareDirectory = worker
      .split("async function createShareDirectory(")[1]
      ?.split("async function openPlan(")[0];
    expect(createShareDirectory).toContain(
      "const sessionGeneration = vaultSessionGeneration",
    );
    expect(
      createShareDirectory?.match(/assertVaultSession\(sessionGeneration\)/g),
    ).toHaveLength(4);
  });

  it("rejects in-flight crypto work after the vault generation changes", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "vault.worker.ts"),
      "utf8",
    );
    const startEncryption = source
      .split("async function startEncryption(")[1]
      ?.split("async function encryptChunk(")[0];
    const encryptChunk = source
      .split("async function encryptChunk(")[1]
      ?.split("async function finalizeEncryption(")[0];
    const finalizeEncryption = source
      .split("async function finalizeEncryption(")[1]
      ?.split("function abortEncryption(")[0];
    const startDecryption = source
      .split("async function startDecryption(")[1]
      ?.split("async function decryptChunk(")[0];
    const decryptChunk = source
      .split("async function decryptChunk(")[1]
      ?.split("async function finalizeDecryption(")[0];
    const finalizeDecryption = source
      .split("async function finalizeDecryption(")[1]
      ?.split("function abortDecryption(")[0];

    expect(startEncryption).toContain(
      "const sessionGeneration = vaultSessionGeneration",
    );
    expect(startEncryption).toContain("assertVaultSession(sessionGeneration)");
    expect(encryptChunk?.match(/assertEncryptionSessionActive/g)).toHaveLength(
      2,
    );
    expect(finalizeEncryption).toContain(
      "assertEncryptionSessionActive(sessionId, session)",
    );
    expect(startDecryption).toContain(
      "const sessionGeneration = vaultSessionGeneration",
    );
    expect(startDecryption).toContain("assertVaultSession(sessionGeneration)");
    expect(
      decryptChunk?.match(/assertDecryptionSessionActive/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    expect(decryptChunk).toContain("isCryptoLifecycleError(error)");
    expect(finalizeDecryption).toContain(
      "assertDecryptionSessionActive(sessionId, session)",
    );
  });

  it("bounds the worker node-key cache while allowing active ancestor pins", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "vault.worker.ts"),
      "utf8",
    );

    expect(source).toContain("const MAX_NODE_KEY_ENTRIES = 8_192");
    expect(source).toContain(
      "new BoundedLruCache<string, CryptoKey>(MAX_NODE_KEY_ENTRIES)",
    );
    expect(source).toContain("pinNodeKey(input.parentId)");
    expect(source).toContain("pinNodeKey(ownerWrapper.parentNodeId)");
    expect(source).not.toContain(
      "const nodeKeys = new Map<string, CryptoKey>()",
    );
  });
});
