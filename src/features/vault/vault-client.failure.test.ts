import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultUnlockMaterial } from "@/features/vault/protocol";
import { VaultCryptoClient } from "@/features/vault/vault-client";
import type { VaultWorkerRequest } from "@/features/vault/vault-messages";

class ControlledWorker {
  static instance: ControlledWorker;
  requests: VaultWorkerRequest[] = [];
  terminate = vi.fn();
  throwOnPost = false;
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  constructor() {
    ControlledWorker.instance = this;
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(request: VaultWorkerRequest) {
    if (this.throwOnPost)
      throw new DOMException("Cannot serialize", "DataCloneError");
    this.requests.push(request);
  }

  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

describe("vault worker fatal recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", ControlledWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports an actionable failure when browser policy prevents worker startup", () => {
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new DOMException("Blocked", "SecurityError");
        }
      },
    );
    expect(() => new VaultCryptoClient()).toThrow("Reload the page and unlock");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects malformed progress instead of keeping an operation alive", async () => {
    const client = new VaultCryptoClient();
    const failed = expect(
      client.openMetadataPlans([], {
        concurrency: 1,
        priorityCount: 0,
      }),
    ).rejects.toMatchObject({ code: "WORKER_UNAVAILABLE" });
    ControlledWorker.instance.emit("message", {
      id: 1,
      ok: true,
      progress: { type: "openMetadataPlans", results: [null] },
    });
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["error", "messageerror"])(
    "rejects all requests and notifies the owner once after %s",
    async (event) => {
      const notify = vi.fn();
      const client = new VaultCryptoClient(notify);
      const first = expect(client.preflight()).rejects.toMatchObject({
        code: "WORKER_UNAVAILABLE",
      });
      const second = expect(client.preflight()).rejects.toMatchObject({
        code: "WORKER_UNAVAILABLE",
      });
      ControlledWorker.instance.emit(event);
      await Promise.all([first, second]);
      await expect(client.preflight()).rejects.toThrow(
        "Unlock the vault again",
      );
      ControlledWorker.instance.emit(event);
      expect(ControlledWorker.instance.requests).toHaveLength(2);
      expect(ControlledWorker.instance.terminate).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    null,
    {},
    { id: 1, ok: true, result: null },
    { id: 1, ok: true, result: { type: "unlock" } },
    { id: 1, ok: true, result: { type: "preflight", supported: false } },
  ])("fails closed for malformed worker response %j", async (response) => {
    const client = new VaultCryptoClient();
    const failed = expect(client.preflight()).rejects.toMatchObject({
      code: "WORKER_UNAVAILABLE",
    });
    ControlledWorker.instance.emit("message", response);
    await failed;
    await expect(client.preflight()).rejects.toMatchObject({
      code: "WORKER_UNAVAILABLE",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminates a missing worker asset which emits no load error", async () => {
    const client = new VaultCryptoClient();
    const failed = expect(client.preflight()).rejects.toThrow(
      "stopped responding during preflight",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    await expect(client.preflight()).rejects.toMatchObject({
      code: "WORKER_UNAVAILABLE",
    });
  });

  it("gives password derivation its own long deadline", async () => {
    const client = new VaultCryptoClient();
    const pending = client.unlock("password", {} as VaultUnlockMaterial);
    const failed = expect(pending).rejects.toThrow(
      "stopped responding during unlock",
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ControlledWorker.instance.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(480_000);
    await failed;
  });

  it("cleans the request and fails terminally when delivery throws", async () => {
    const client = new VaultCryptoClient();
    ControlledWorker.instance.throwOnPost = true;
    await expect(client.preflight()).rejects.toThrow("could not be delivered");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires cancellation acknowledgment and tears down a stuck worker", async () => {
    const notify = vi.fn();
    const client = new VaultCryptoClient(notify);
    const controller = new AbortController();
    const pending = client.openMetadataPlans([], {
      concurrency: 1,
      priorityCount: 0,
      signal: controller.signal,
    });
    const aborted = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await aborted;
    expect(ControlledWorker.instance.requests[1]).toMatchObject({
      type: "cancelMetadataOperation",
      operationId: 1,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(notify).toHaveBeenCalledOnce();
    await expect(client.preflight()).rejects.toMatchObject({
      code: "WORKER_UNAVAILABLE",
    });
  });

  it("lets a newly created client recover while keeping the failed client terminal", async () => {
    const client = new VaultCryptoClient();
    ControlledWorker.instance.emit("error");
    const recovered = new VaultCryptoClient();
    const preflight = recovered.preflight();
    ControlledWorker.instance.emit("message", {
      id: 1,
      ok: true,
      result: { type: "preflight", supported: true },
    });
    await expect(preflight).resolves.toBeUndefined();
    await expect(client.preflight()).rejects.toMatchObject({
      code: "WORKER_UNAVAILABLE",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
