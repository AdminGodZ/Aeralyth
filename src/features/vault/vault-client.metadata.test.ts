import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  VaultManifest,
  VaultMetadataPlan,
  VaultShareNodeSnapshot,
  VaultSharePreparationPlan,
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
  ciphertextLength: 4_112,
  cryptoChunkBytes: 4 * 1024 * 1024,
  chunkCount: 1,
  ciphertextMerkleRoot: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
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
  static respondToMetadata = true;

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
    if (request.type === "cancelMetadataOperation") {
      queueMicrotask(() =>
        this.emit({
          id: request.id,
          ok: true,
          result: { type: "cancelMetadataOperation" },
        }),
      );
      return;
    }
    if (request.type === "createShareMaterial") {
      const folder = request.input.nodes.find(
        (node) => node.entryType === "folder",
      );
      const file = request.input.nodes.find(
        (node) => node.entryType === "file",
      );
      if (!folder || !file)
        throw new Error("The test share nodes are invalid.");
      queueMicrotask(() => {
        this.emit({
          id: request.id,
          ok: true,
          progress: {
            type: "shareMaterial",
            nodeId: file.nodeId,
            wrappers: [Uint8Array.of(2), Uint8Array.of(3)],
            completedNodes: 1,
            totalNodes: 2,
          },
        });
        this.emit({
          id: request.id,
          ok: true,
          progress: {
            type: "shareMaterial",
            nodeId: folder.nodeId,
            wrappers: [Uint8Array.of(1)],
            completedNodes: 2,
            totalNodes: 2,
          },
        });
        this.emit({
          id: request.id,
          ok: true,
          result: {
            type: "createShareMaterial",
            result: {
              wrappers: [],
              envelopes: [],
              ownerEpochKey: {
                wrapperId: new Uint8Array(16),
                ciphertext: new Uint8Array(32),
              },
            },
          },
        });
      });
      return;
    }
    if (request.type !== "openMetadataPlans") return;
    if (!FakeWorker.respondToMetadata) return;
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
    FakeWorker.respondToMetadata = true;
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

  it("propagates navigation cancellation into the worker operation", async () => {
    FakeWorker.respondToMetadata = false;
    const client = new VaultCryptoClient();
    const controller = new AbortController();

    const pending = client.openMetadataPlans([plan], {
      concurrency: 4,
      priorityCount: 1,
      signal: controller.signal,
    });
    const worker = FakeWorker.instances[0];
    const operation = worker.requests[0];
    expect(operation.type).toBe("openMetadataPlans");

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.requests[1]).toMatchObject({
      type: "cancelMetadataOperation",
      operationId: operation.id,
    });
  });

  it("assembles progressively transferred share wrappers deterministically", async () => {
    const client = new VaultCryptoClient();
    const onProgress = vi.fn();
    const nodes: VaultShareNodeSnapshot[] = [
      {
        nodeId: "dir_z",
        parentId: null,
        depth: 0,
        entryType: "folder",
        generationNumber: 1,
        generationId: plan.generationId,
        recordVersion: 1,
        recordHash: plan.recordHash,
      },
      {
        nodeId: "fil_a",
        parentId: "dir_z",
        depth: 1,
        entryType: "file",
        generationNumber: 1,
        generationId: plan.generationId,
        recordVersion: 1,
        recordHash: plan.recordHash,
      },
    ];
    const plans: VaultSharePreparationPlan[] = nodes.map((snapshot) => ({
      snapshot,
      metadata: {
        ...plan,
        nodeId: snapshot.nodeId,
        entryType: snapshot.entryType,
        generationId: snapshot.generationId ?? plan.generationId,
      },
    }));

    const material = await client.createShareMaterial(
      {
        shareId: "shr_progress",
        rootNodeId: "dir_z",
        senderId: "usr_sender",
        recipient: {
          userId: "usr_recipient",
          username: "recipient",
          keyVersion: 1,
          x25519PublicKey: "x25519",
          ed25519PublicKey: "ed25519",
          fingerprintSha256: "fingerprint",
          trustStatus: "accepted",
        },
        nodes,
        plans,
      },
      { onProgress },
    );

    expect(material.wrappers.map((wrapper) => wrapper[0])).toEqual([1, 2, 3]);
    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { completedNodes: 1, totalNodes: 2 },
      { completedNodes: 2, totalNodes: 2 },
    ]);
  });
});
