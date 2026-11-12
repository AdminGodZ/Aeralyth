import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultUnlockMaterial } from "@/features/vault/protocol";
import {
  VaultCryptoClient,
  VaultWorkerError,
} from "@/features/vault/vault-client";
import type { VaultWorkerRequest } from "@/features/vault/vault-messages";
import {
  UNLOCK_MATERIAL_PREFETCH_MAX_AGE_MS,
  VaultUnlockPrewarm,
} from "@/features/vault/vault-unlock-prewarm";

class CountingWorker {
  static instances: CountingWorker[] = [];
  requests: VaultWorkerRequest[] = [];
  terminate = vi.fn();
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  constructor() {
    CountingWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(request: VaultWorkerRequest) {
    this.requests.push(request);
  }

  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

function material(vaultVersion = 1): VaultUnlockMaterial {
  return { vaultVersion } as VaultUnlockMaterial;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

// Mirrors the provider: one worker slot whose failures are shown unless only
// the prewarm had started that worker.
function vaultSlot(prewarm: VaultUnlockPrewarm<VaultCryptoClient>) {
  let current: VaultCryptoClient | null = null;
  const shownErrors: string[] = [];
  const getClient = () => {
    if (!current) {
      const client = new VaultCryptoClient((failure) => {
        if (current !== client) return;
        current = null;
        if (prewarm.dropIdleClient(client)) return;
        shownErrors.push(failure.message);
      });
      current = client;
    }
    return current;
  };
  return {
    shownErrors,
    get current() {
      return current;
    },
    prewarm(withMaterial = true) {
      prewarm.start({
        currentClient: current,
        createClient: getClient,
        material: withMaterial,
      });
    },
    claim() {
      return prewarm.claimClient(getClient());
    },
    close() {
      prewarm.clearMaterial();
      void current?.close();
      current = null;
    },
  };
}

describe("vault unlock prewarm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    CountingWorker.instances = [];
    vi.stubGlobal("Worker", CountingWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reuses one worker and one material request across prewarm and submit", async () => {
    const response = deferred<VaultUnlockMaterial>();
    const fetchMaterial = vi.fn(() => response.promise);
    const prewarm = new VaultUnlockPrewarm<VaultCryptoClient>(fetchMaterial);
    const slot = vaultSlot(prewarm);

    slot.prewarm();
    slot.prewarm();
    // The user submits before the material request has finished.
    const client = slot.claim();
    const unlocked = prewarm.withMaterial((current) =>
      client.unlock("correct horse", current),
    );
    response.resolve(material(7));
    await vi.waitFor(() =>
      expect(CountingWorker.instances[0]?.requests).toHaveLength(1),
    );
    const worker = CountingWorker.instances[0] as CountingWorker;
    const request = worker.requests[0] as VaultWorkerRequest;
    expect(request).toMatchObject({ type: "unlock", material: material(7) });
    worker.emit("message", {
      id: request.id,
      ok: true,
      result: {
        type: "unlock",
        result: { vaultVersion: 7, identityFingerprint: "fingerprint" },
      },
    });

    await expect(unlocked).resolves.toEqual({
      vaultVersion: 7,
      identityFingerprint: "fingerprint",
    });
    expect(CountingWorker.instances).toHaveLength(1);
    expect(fetchMaterial).toHaveBeenCalledTimes(1);
  });

  it("fetches on submit when the prefetch failed, without reporting it early", async () => {
    const fetchMaterial = vi
      .fn<(signal?: AbortSignal) => Promise<VaultUnlockMaterial>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(material(2));
    const prewarm = new VaultUnlockPrewarm<VaultCryptoClient>(fetchMaterial);
    const slot = vaultSlot(prewarm);

    slot.prewarm();
    await vi.runAllTimersAsync();
    expect(slot.shownErrors).toEqual([]);

    await expect(prewarm.takeMaterial()).resolves.toEqual({
      material: material(2),
      prefetched: false,
    });
    expect(fetchMaterial).toHaveBeenCalledTimes(2);
  });

  it("replaces a prewarmed worker that failed before submit without showing the failure", () => {
    const prewarm = new VaultUnlockPrewarm<VaultCryptoClient>(
      vi.fn(async () => material()),
    );
    const slot = vaultSlot(prewarm);

    slot.prewarm(false);
    const failed = CountingWorker.instances[0] as CountingWorker;
    failed.emit("error");

    expect(slot.shownErrors).toEqual([]);
    expect(slot.current).toBeNull();
    expect(failed.terminate).toHaveBeenCalled();
    slot.claim();
    expect(CountingWorker.instances).toHaveLength(2);
  });

  it("still reports failures of a worker that a submit claimed", () => {
    const prewarm = new VaultUnlockPrewarm<VaultCryptoClient>(
      vi.fn(async () => material()),
    );
    const slot = vaultSlot(prewarm);

    slot.prewarm(false);
    slot.claim();
    CountingWorker.instances[0]?.emit("error");

    expect(slot.shownErrors).toHaveLength(1);
  });

  it("does not leak workers or requests when the dialog closes and reopens", () => {
    const signals: (AbortSignal | undefined)[] = [];
    const fetchMaterial = vi.fn((signal?: AbortSignal) => {
      signals.push(signal);
      return new Promise<VaultUnlockMaterial>(() => undefined);
    });
    const prewarm = new VaultUnlockPrewarm<VaultCryptoClient>(fetchMaterial);
    const slot = vaultSlot(prewarm);

    for (let reopen = 0; reopen < 3; reopen += 1) {
      slot.prewarm();
      prewarm.clearMaterial();
    }

    expect(CountingWorker.instances).toHaveLength(1);
    expect(fetchMaterial).toHaveBeenCalledTimes(3);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);

    slot.close();
    expect(CountingWorker.instances[0]?.terminate).toHaveBeenCalledTimes(1);
  });

  it("refetches material that is older than the prefetch bound", async () => {
    let now = 0;
    const signals: (AbortSignal | undefined)[] = [];
    const fetchMaterial = vi.fn(async (signal?: AbortSignal) => {
      signals.push(signal);
      return material(signals.length);
    });
    const prewarm = new VaultUnlockPrewarm<VaultCryptoClient>(
      fetchMaterial,
      () => now,
    );

    prewarm.start({
      currentClient: null,
      createClient: () => new VaultCryptoClient(),
      material: true,
    });
    now = UNLOCK_MATERIAL_PREFETCH_MAX_AGE_MS + 1;

    await expect(prewarm.takeMaterial()).resolves.toEqual({
      material: material(2),
      prefetched: false,
    });
    expect(signals[0]?.aborted).toBe(true);
  });

  it("refreshes a stale prefetch when the user types again", async () => {
    let now = 0;
    const fetchMaterial = vi.fn(async () =>
      material(fetchMaterial.mock.calls.length),
    );
    const prewarm = new VaultUnlockPrewarm<VaultCryptoClient>(
      fetchMaterial,
      () => now,
    );
    const slot = vaultSlot(prewarm);

    slot.prewarm();
    slot.prewarm();
    expect(fetchMaterial).toHaveBeenCalledTimes(1);
    now = UNLOCK_MATERIAL_PREFETCH_MAX_AGE_MS + 1;
    slot.prewarm();

    await expect(prewarm.takeMaterial()).resolves.toEqual({
      material: material(2),
      prefetched: true,
    });
    expect(CountingWorker.instances).toHaveLength(1);
  });

  it("retries once with fresh material when the server copy changed", async () => {
    const fetchMaterial = vi
      .fn<(signal?: AbortSignal) => Promise<VaultUnlockMaterial>>()
      .mockResolvedValueOnce(material(1))
      .mockResolvedValueOnce(material(2));
    const prewarm = new VaultUnlockPrewarm<VaultCryptoClient>(fetchMaterial);
    const operation = vi.fn(async (current: VaultUnlockMaterial) => {
      if (current.vaultVersion === 1)
        throw new VaultWorkerError("Wrong.", "INVALID_PASSWORD");
      return current.vaultVersion;
    });

    prewarm.start({
      currentClient: null,
      createClient: () => new VaultCryptoClient(),
      material: true,
    });

    await expect(prewarm.withMaterial(operation)).resolves.toBe(2);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry a rejection when the server copy is unchanged", async () => {
    const fetchMaterial = vi.fn(async () => material(1));
    const prewarm = new VaultUnlockPrewarm<VaultCryptoClient>(fetchMaterial);
    const failure = new VaultWorkerError("Wrong.", "INVALID_PASSWORD");
    const operation = vi.fn(async () => {
      throw failure;
    });

    prewarm.start({
      currentClient: null,
      createClient: () => new VaultCryptoClient(),
      material: true,
    });

    await expect(prewarm.withMaterial(operation)).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(fetchMaterial).toHaveBeenCalledTimes(2);
  });

  it("does not refetch material that was fetched on submit", async () => {
    const fetchMaterial = vi.fn(async () => material(1));
    const prewarm = new VaultUnlockPrewarm<VaultCryptoClient>(fetchMaterial);
    const failure = new VaultWorkerError("Wrong.", "INVALID_PASSWORD");

    await expect(
      prewarm.withMaterial(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(fetchMaterial).toHaveBeenCalledTimes(1);
  });
});
