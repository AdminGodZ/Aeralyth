import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  VaultManifest,
  VaultMetadataPlan,
} from "@/features/vault/protocol";
import { VaultCryptoClient } from "@/features/vault/vault-client";
import type {
  VaultWorkerRequest,
  VaultWorkerResponse,
} from "@/features/vault/vault-messages";

const manifest: VaultManifest = {
  name: "cached-name.txt",
  mimeType: "text/plain",
  entryType: "file",
  plaintextBytes: 12,
  paddedBytes: 4096,
  lastModified: 1,
  parentId: null,
  chunkCount: 1,
  generationId: new Uint8Array(16),
  createdAt: 1,
};

const plan: VaultMetadataPlan = {
  nodeId: "fil_01234567",
  entryType: "file",
  generationNumber: 1,
  generationId: "AAAAAAAAAAAAAAAAAAAAAA",
  bootstrapCbor: "bootstrap",
  bootstrapSignature: "signature",
  encryptedManifest: "manifest",
  wrappers: [],
  signerKeyVersion: 1,
  signerEd25519PublicKey: "signer",
  recordVersion: 1,
  recordHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  share: null,
};

class FakeWorker {
  static instances: FakeWorker[] = [];

  readonly requests: VaultWorkerRequest[] = [];
  private readonly listeners = new Map<
    string,
    Array<(event: MessageEvent<VaultWorkerResponse>) => void>
  >();

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent<VaultWorkerResponse>) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(request: VaultWorkerRequest): void {
    this.requests.push(request);
    if (request.type !== "openMetadataPlans") return;
    const results = request.plans.map((metadataPlan) => ({
      status: "ready" as const,
      nodeId: metadataPlan.nodeId,
      recordHash: metadataPlan.recordHash,
      manifest,
    }));
    queueMicrotask(() => {
      this.emit({
        id: request.id,
        ok: true,
        progress: { type: "openMetadataPlans", results },
      });
      this.emit({
        id: request.id,
        ok: true,
        result: { type: "openMetadataPlans", results },
      });
    });
  }

  terminate(): void {}

  private emit(response: VaultWorkerResponse): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: response } as MessageEvent<VaultWorkerResponse>);
    }
  }
}

describe("vault metadata worker client", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens a metadata page with one worker RPC and keeps priority progress", async () => {
    const client = new VaultCryptoClient();
    const onPriority = vi.fn();

    const results = await client.openMetadataPlans([plan], {
      concurrency: 16,
      priorityCount: 1,
      onPriority,
    });

    const worker = FakeWorker.instances[0];
    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0]).toMatchObject({
      type: "openMetadataPlans",
      concurrency: 16,
      priorityCount: 1,
    });
    expect(onPriority).toHaveBeenCalledOnce();
    expect(results).toEqual([
      expect.objectContaining({
        status: "ready",
        nodeId: plan.nodeId,
        recordHash: plan.recordHash,
      }),
    ]);
  });
});
