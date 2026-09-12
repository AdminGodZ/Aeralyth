import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExistingUploadNode } from "@/features/dashboard/folder-upload-conflicts";
import type { VaultNodeRecord } from "@/features/vault/protocol";
import type { VaultPublishResponse } from "@/features/vault/vault-api";
import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type { VaultEncryptionInput } from "@/features/vault/vault-messages";

const mocks = vi.hoisted(() => ({
  publishVaultFoldersBatch: vi.fn(),
  enqueueShareDirectorySync: vi.fn(),
}));
vi.mock("@/features/vault/vault-api", () => ({
  publishVaultFoldersBatch: mocks.publishVaultFoldersBatch,
}));
vi.mock("@/features/vault/share-directory-sync", () => ({
  enqueueShareDirectorySync: mocks.enqueueShareDirectorySync,
}));

import { publishEncryptedFolderTree } from "@/features/vault/encrypted-folder-upload";

describe("encrypted folder dependency scheduling", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prepares independent siblings concurrently within the shared 100-record ceiling", async () => {
    const fixture = createFixture();
    await fixture.run(
      Array.from({ length: 500 }, (_, index) => `folder-${index}`),
    );

    expect(fixture.peakCrypto()).toBe(4);
    expect(fixture.peakOutstanding()).toBe(100);
    expect(fixture.published).toHaveLength(500);
    expect(mocks.publishVaultFoldersBatch).toHaveBeenCalledTimes(5);
    expect(fixture.client.abortEncryption).not.toHaveBeenCalled();
  });

  it("orders parent keys and publication records for an unsorted mixed hierarchy", async () => {
    const fixture = createFixture();
    await fixture.run(["root/a/deep", "root/b", "root", "root/a"]);

    expect(fixture.published).toHaveLength(4);
    const order = fixture.published.map(([path]) => path);
    expect(order.indexOf("root")).toBeLessThan(order.indexOf("root/a"));
    expect(order.indexOf("root/a")).toBeLessThan(order.indexOf("root/a/deep"));
    expect(mocks.publishVaultFoldersBatch).toHaveBeenCalledTimes(1);
  });

  it("keeps a 10,000-folder import in parent-valid batches of at most 100", async () => {
    const fixture = createFixture();
    const folders = Array.from({ length: 100 }, (_, branch) => {
      let path = "";
      return Array.from({ length: 100 }, (_, depth) => {
        path = `${path ? `${path}/` : ""}branch-${branch}-depth-${depth}`;
        return path;
      });
    }).flat();
    await fixture.run(folders);

    expect(fixture.published).toHaveLength(10_000);
    expect(fixture.peakOutstanding()).toBe(100);
    expect(mocks.publishVaultFoldersBatch).toHaveBeenCalledTimes(100);
    expect(
      mocks.publishVaultFoldersBatch.mock.calls.every(
        ([, records]) => records.length === 100,
      ),
    ).toBe(true);
  });

  it("publishes a ready file parent while unrelated folder crypto is still blocked", async () => {
    const slow = deferred<void>();
    const firstPublished = deferred<void>();
    const fixture = createFixture({
      beforeFinalize: async (input) => {
        if (input.name === "slow") await slow.promise;
      },
    });
    const run = fixture.run(["ready", "slow"], {
      priorityParents: new Set(["ready"]),
      onPublished: (path) => {
        if (path === "ready") firstPublished.resolve();
      },
    });
    await firstPublished.promise;

    expect(fixture.published.map(([path]) => path)).toEqual(["ready"]);
    expect(fixture.folderIds.has("slow")).toBe(false);
    slow.resolve();
    await run;
    expect(fixture.published.map(([path]) => path)).toEqual(["ready", "slow"]);
  });

  it("releases reused folders immediately and preserves share synchronization for new children", async () => {
    const slow = deferred<void>();
    const reused = deferred<void>();
    const fixture = createFixture({
      beforeFinalize: () => slow.promise,
      shareSyncRequired: true,
    });
    fixture.durable.add("existing-id");
    const existing: ExistingUploadNode = {
      id: "existing-id",
      name: "existing",
      entryType: "folder",
      e2eeState: "encrypted",
    };
    const run = fixture.run(["existing", "existing/new"], {
      existingFolders: new Map([["existing", existing]]),
      onPublished: (path) => {
        if (path === "existing") reused.resolve();
      },
    });
    await reused.promise;
    expect(fixture.folderIds.get("existing")).toBe("existing-id");
    expect(mocks.publishVaultFoldersBatch).not.toHaveBeenCalled();
    slow.resolve();
    await run;

    expect(fixture.client.startEncryption).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueShareDirectorySync).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: "share-batch",
        job: expect.objectContaining({
          contextCacheKey: "existing-id",
          entryType: "folder",
        }),
      }),
    );
  });

  it("does not release any files or keep folder keys when a publication response is invalid", async () => {
    const fixture = createFixture({
      beforePublish: async (response) => {
        response.folders[1].generationId = "wrong-generation";
      },
    });
    await expect(fixture.run(["one", "two"])).rejects.toThrow(
      "response is invalid",
    );

    expect(fixture.published).toEqual([]);
    expect(fixture.folderIds.size).toBe(1);
    expect(fixture.client.abortEncryption).toHaveBeenCalledTimes(2);
  });

  it("cleans up a failed later batch while retaining already published keys", async () => {
    const fixture = createFixture({
      beforePublish: async (_response, call) => {
        if (call === 2) throw new Error("publication failed");
      },
    });
    await expect(
      fixture.run(Array.from({ length: 250 }, (_, index) => `folder-${index}`)),
    ).rejects.toThrow("publication failed");

    expect(fixture.published).toHaveLength(100);
    expect(fixture.folderIds.size).toBe(101);
    expect(fixture.client.startEncryption).toHaveBeenCalledTimes(200);
    expect(fixture.client.abortEncryption).toHaveBeenCalledTimes(100);
    for (const [, nodeId] of vi.mocked(fixture.client.abortEncryption).mock
      .calls) {
      expect(fixture.durable.has(nodeId)).toBe(false);
    }
  });

  it("cleans up late worker starts after cancellation without publishing them", async () => {
    const gate = deferred<void>();
    const started = deferred<void>();
    const controller = new AbortController();
    const fixture = createFixture({
      beforeStart: async () => {
        started.resolve();
        await gate.promise;
      },
    });
    const run = fixture.run(["one", "two"], { signal: controller.signal });
    const rejected = expect(run).rejects.toThrow("cancelled");
    await started.promise;
    controller.abort(new Error("cancelled"));
    gate.resolve();
    await rejected;

    expect(fixture.client.abortEncryption).toHaveBeenCalledTimes(2);
    expect(fixture.client.finalizeEncryption).not.toHaveBeenCalled();
    expect(mocks.publishVaultFoldersBatch).not.toHaveBeenCalled();
  });

  it("rejects missing ancestors before starting crypto", async () => {
    const fixture = createFixture();
    await expect(fixture.run(["missing/child"])).rejects.toThrow(
      "hierarchy is invalid",
    );
    expect(fixture.client.startEncryption).not.toHaveBeenCalled();
  });
});

function createFixture({
  beforeStart,
  beforeFinalize,
  beforePublish,
  shareSyncRequired = false,
}: {
  beforeStart?(input: VaultEncryptionInput): Promise<void>;
  beforeFinalize?(input: VaultEncryptionInput): Promise<void>;
  beforePublish?(
    response: { folders: VaultPublishResponse[] },
    call: number,
  ): Promise<void>;
  shareSyncRequired?: boolean;
} = {}) {
  type RecordInfo = {
    sessionId: string;
    parentId: string | null;
    response: VaultPublishResponse;
  };
  const inputs = new Map<string, VaultEncryptionInput>();
  const records = new Map<VaultNodeRecord, RecordInfo>();
  const finalized = new Set<string>();
  const durable = new Set<string>();
  const folderIds = new Map([["", ""]]);
  const published: [string, string][] = [];
  let activeCrypto = 0;
  let maxCrypto = 0;
  let outstanding = 0;
  let maxOutstanding = 0;
  let counter = 0;
  let publicationCount = 0;
  const client = {
    startEncryption: vi.fn(async (input: VaultEncryptionInput) => {
      if (input.parentId) {
        expect(
          finalized.has(input.parentId) || durable.has(input.parentId),
        ).toBe(true);
      }
      activeCrypto += 1;
      outstanding += 1;
      maxCrypto = Math.max(maxCrypto, activeCrypto);
      maxOutstanding = Math.max(maxOutstanding, outstanding);
      await beforeStart?.(input);
      const sessionId = `session-${counter++}`;
      inputs.set(sessionId, input);
      return {
        sessionId,
        nodeId: `node-${sessionId}`,
        generationNumber: 1,
        generationId: `generation-${sessionId}`,
        recordVersion: 1,
        paddedBytes: 0,
        ciphertextLength: 0,
        chunkCount: 0,
      };
    }),
    finalizeEncryption: vi.fn(async (sessionId: string) => {
      const input = inputs.get(sessionId);
      if (!input) throw new Error("Unknown session");
      await beforeFinalize?.(input);
      activeCrypto -= 1;
      const nodeId = `node-${sessionId}`;
      finalized.add(nodeId);
      const response: VaultPublishResponse = {
        nodeId,
        generationNumber: 1,
        generationId: `generation-${sessionId}`,
        recordVersion: 1,
        recordHash: `hash-${sessionId}`,
        shareSyncRequired,
      };
      const record: VaultNodeRecord = {
        bootstrapCbor: new Uint8Array(),
        bootstrapSignature: new Uint8Array(),
        encryptedManifest: new Uint8Array(),
        wrappers: [],
      };
      records.set(record, { sessionId, parentId: input.parentId, response });
      return { ...response, ciphertextLength: 0, chunkCount: 0, record };
    }),
    abortEncryption: vi.fn(async () => undefined),
  } as unknown as VaultCryptoClient;

  mocks.publishVaultFoldersBatch.mockImplementation(
    async (_csrf: string, batch: VaultNodeRecord[]) => {
      expect(batch.length).toBeLessThanOrEqual(100);
      const batchParents = new Set(durable);
      const response = {
        folders: batch.map((record) => {
          const info = records.get(record);
          if (!info) throw new Error("Unknown record");
          if (info.parentId) expect(batchParents.has(info.parentId)).toBe(true);
          batchParents.add(info.response.nodeId);
          return { ...info.response };
        }),
      };
      await beforePublish?.(response, ++publicationCount);
      for (const folder of response.folders) durable.add(folder.nodeId);
      outstanding -= batch.length;
      return response;
    },
  );

  return {
    client,
    folderIds,
    durable,
    published,
    peakCrypto: () => maxCrypto,
    peakOutstanding: () => maxOutstanding,
    run: (
      folders: string[],
      options: Partial<Parameters<typeof publishEncryptedFolderTree>[0]> = {},
    ) =>
      publishEncryptedFolderTree({
        folders,
        folderIds,
        client,
        csrfToken: "csrf",
        signal: new AbortController().signal,
        shareSyncBatchId: "share-batch",
        ...options,
        onPublished: (path, nodeId) => {
          expect(durable.has(nodeId)).toBe(true);
          expect(folderIds.get(path)).toBe(nodeId);
          published.push([path, nodeId]);
          options.onPublished?.(path, nodeId);
        },
      }),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
