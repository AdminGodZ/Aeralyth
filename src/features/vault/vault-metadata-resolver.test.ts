import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  VaultManifest,
  VaultMetadataPlan,
  VaultMetadataReference,
} from "@/features/vault/protocol";
import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type { VaultMetadataOpenResult } from "@/features/vault/vault-messages";
import { VaultMetadataResolver } from "@/features/vault/vault-metadata-resolver";

const apiMocks = vi.hoisted(() => ({
  getVaultFolderMetadataReferences: vi.fn(),
  getVaultMetadataPlans: vi.fn(),
}));

vi.mock("@/features/vault/vault-api", () => apiMocks);

const generationId = "AAAAAAAAAAAAAAAAAAAAAA";
const recordHash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const manifest: VaultManifest = {
  name: "metadata.txt",
  mimeType: "text/plain",
  entryType: "file",
  plaintextBytes: 8,
  paddedBytes: 4096,
  lastModified: 1,
  parentId: null,
  chunkCount: 1,
  generationId: new Uint8Array(16),
  createdAt: 1,
};

describe("VaultMetadataResolver", () => {
  beforeEach(() => {
    apiMocks.getVaultFolderMetadataReferences.mockReset();
    apiMocks.getVaultMetadataPlans.mockReset();
  });

  it("invalidates only changed folder listings while preserving unrelated warm folders", async () => {
    const resolver = new VaultMetadataResolver();
    const { client } = fakeClient();
    const context = {
      csrfToken: "csrf",
      client,
      openNode: vi.fn(async () => undefined),
    };
    apiMocks.getVaultFolderMetadataReferences.mockResolvedValue([]);
    await resolver.prefetchFolder("fil_first_folder", "files", context);
    await resolver.prefetchFolder("fil_other_folder", "files", context);
    resolver.invalidateFolders(["fil_first_folder"]);
    await resolver.prefetchFolder("fil_first_folder", "files", context);
    await resolver.prefetchFolder("fil_other_folder", "files", context);
    expect(apiMocks.getVaultFolderMetadataReferences).toHaveBeenCalledTimes(3);
  });

  it("does not cache an obsolete folder response that finishes after an SSE invalidation", async () => {
    const resolver = new VaultMetadataResolver();
    const { client } = fakeClient();
    const context = {
      csrfToken: "csrf",
      client,
      openNode: vi.fn(async () => undefined),
    };
    const pending = deferred<VaultMetadataReference[]>();
    apiMocks.getVaultFolderMetadataReferences
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue([]);
    const old = resolver.prefetchFolder("fil_changed_folder", "files", context);
    resolver.invalidateFolders(["fil_changed_folder"]);
    pending.resolve([]);
    await old;
    await resolver.prefetchFolder("fil_changed_folder", "files", context);
    expect(apiMocks.getVaultFolderMetadataReferences).toHaveBeenCalledTimes(2);
  });

  it("uses one network batch and one worker RPC for 100 cold rows, then stays memory-local", async () => {
    const references = Array.from({ length: 100 }, (_, index) =>
      reference(`fil_metadata_${index}`),
    );
    const plans = references.map(planFor);
    apiMocks.getVaultMetadataPlans.mockResolvedValue({ plans });
    const { client, getCachedMetadata, openMetadataPlans } = fakeClient();
    const resolver = new VaultMetadataResolver();
    const context = {
      csrfToken: "csrf",
      client,
      openNode: vi.fn(async () => undefined),
    };

    const cold = await resolver.resolve(references, context);
    const warm = await resolver.resolve(references, context);

    expect(cold).toHaveLength(100);
    expect(warm).toHaveLength(100);
    expect(apiMocks.getVaultMetadataPlans).toHaveBeenCalledOnce();
    expect(apiMocks.getVaultMetadataPlans).toHaveBeenCalledWith(
      "csrf",
      references.map((value) => value.nodeId),
      undefined,
      expect.any(AbortSignal),
      undefined,
      undefined,
    );
    expect(getCachedMetadata).toHaveBeenCalledOnce();
    expect(openMetadataPlans).toHaveBeenCalledOnce();
    expect(openMetadataPlans.mock.calls[0][0]).toHaveLength(100);
    expect(openMetadataPlans.mock.calls[0][1]).toMatchObject({
      concurrency: 4,
    });
  });

  it("revalidates shared grants before consulting plaintext or plan caches", async () => {
    const target = reference("fil_shared_revalidation");
    apiMocks.getVaultMetadataPlans.mockResolvedValue({
      plans: [planFor(target)],
    });
    const { client, getCachedMetadata, openMetadataPlans } = fakeClient();
    const resolver = new VaultMetadataResolver();
    const context = {
      csrfToken: "csrf",
      client,
      openNode: vi.fn(async () => undefined),
    };

    await resolver.resolve([target], context);
    await resolver.resolve([target], context, {
      requireServerValidation: true,
    });

    expect(apiMocks.getVaultMetadataPlans).toHaveBeenCalledTimes(2);
    expect(getCachedMetadata).toHaveBeenCalledOnce();
    expect(openMetadataPlans).toHaveBeenCalledTimes(2);
  });

  it("never coalesces independent shared-grant validation flights", async () => {
    const first = deferred<{ plans: VaultMetadataPlan[] }>();
    const second = deferred<{ plans: VaultMetadataPlan[] }>();
    const target = reference("fil_shared_grant_flights");
    apiMocks.getVaultMetadataPlans
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { client } = fakeClient();
    const resolver = new VaultMetadataResolver();
    const context = {
      csrfToken: "csrf",
      client,
      openNode: vi.fn(async () => undefined),
    };

    const oldNavigation = resolver.resolve([target], context, {
      requireServerValidation: true,
    });
    const newNavigation = resolver.resolve([target], context, {
      requireServerValidation: true,
    });
    await vi.waitFor(() =>
      expect(apiMocks.getVaultMetadataPlans).toHaveBeenCalledTimes(2),
    );
    first.resolve({ plans: [planFor(target)] });
    second.resolve({ plans: [planFor(target)] });

    await expect(oldNavigation).resolves.toHaveLength(1);
    await expect(newNavigation).resolves.toHaveLength(1);
  });

  it("uses exactly five sequential plan requests for 500 cold rows", async () => {
    const references = Array.from({ length: 500 }, (_, index) =>
      reference(`fil_metadata_large_${index}`),
    );
    let activeRequests = 0;
    let peakRequests = 0;
    apiMocks.getVaultMetadataPlans.mockImplementation(
      async (_csrfToken: string, nodeIds: string[]) => {
        activeRequests += 1;
        peakRequests = Math.max(peakRequests, activeRequests);
        await Promise.resolve();
        activeRequests -= 1;
        const byId = new Map(references.map((value) => [value.nodeId, value]));
        return {
          plans: nodeIds.map((nodeId) => {
            const value = byId.get(nodeId);
            if (!value) throw new Error("unexpected metadata node id");
            return planFor(value);
          }),
        };
      },
    );
    const { client, openMetadataPlans } = fakeClient();
    const resolver = new VaultMetadataResolver();

    const results = await resolver.resolve(references, {
      csrfToken: "csrf",
      client,
      openNode: vi.fn(async () => undefined),
    });

    expect(results).toHaveLength(500);
    expect(apiMocks.getVaultMetadataPlans).toHaveBeenCalledTimes(5);
    expect(
      apiMocks.getVaultMetadataPlans.mock.calls.map(
        ([, nodeIds]) => nodeIds.length,
      ),
    ).toEqual([100, 100, 100, 100, 100]);
    expect(peakRequests).toBe(1);
    expect(openMetadataPlans).toHaveBeenCalledOnce();
    expect(openMetadataPlans.mock.calls[0][1]).toMatchObject({
      concurrency: 4,
    });
  });

  it("follows an encoded-size continuation without overlapping requests", async () => {
    const references = Array.from({ length: 100 }, (_, index) =>
      reference(`fil_metadata_continuation_${index}`),
    );
    const plans = references.map(planFor);
    let activeRequests = 0;
    let peakRequests = 0;
    apiMocks.getVaultMetadataPlans
      .mockImplementationOnce(async () => {
        activeRequests += 1;
        peakRequests = Math.max(peakRequests, activeRequests);
        await Promise.resolve();
        activeRequests -= 1;
        return {
          plans: plans.slice(0, 50),
          continuation: 50,
          snapshot: "version-one",
        };
      })
      .mockImplementationOnce(async () => {
        activeRequests += 1;
        peakRequests = Math.max(peakRequests, activeRequests);
        await Promise.resolve();
        activeRequests -= 1;
        return { plans: plans.slice(50), snapshot: "version-one" };
      });
    const { client } = fakeClient();
    const resolver = new VaultMetadataResolver();

    await expect(
      resolver.resolve(references, {
        csrfToken: "csrf",
        client,
        openNode: vi.fn(async () => undefined),
      }),
    ).resolves.toHaveLength(100);

    expect(apiMocks.getVaultMetadataPlans).toHaveBeenCalledTimes(2);
    expect(apiMocks.getVaultMetadataPlans.mock.calls[1]).toEqual([
      "csrf",
      references.map((value) => value.nodeId),
      50,
      expect.any(AbortSignal),
      undefined,
      "version-one",
    ]);
    expect(peakRequests).toBe(1);
  });

  it("rejects changed snapshot pages before publishing mixed metadata", async () => {
    const references = [reference("fil_first"), reference("fil_second")];
    apiMocks.getVaultMetadataPlans
      .mockResolvedValueOnce({
        plans: [planFor(references[0])],
        continuation: 1,
        snapshot: "first",
      })
      .mockResolvedValueOnce({
        plans: [planFor(references[1])],
        snapshot: "changed",
      });
    const { client, openMetadataPlans } = fakeClient();
    const resolver = new VaultMetadataResolver();
    await expect(
      resolver.resolve(references, {
        csrfToken: "csrf",
        client,
        openNode: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("metadata snapshot changed");
    expect(openMetadataPlans).not.toHaveBeenCalled();
  });

  it("lets an abandoned navigation stop waiting without canceling shared plan warm-up", async () => {
    const pending = deferred<{ plans: VaultMetadataPlan[] }>();
    apiMocks.getVaultMetadataPlans.mockReturnValue(pending.promise);
    const target = reference("fil_shared_flight");
    const { client, openMetadataPlans } = fakeClient();
    const resolver = new VaultMetadataResolver();
    const context = {
      csrfToken: "csrf",
      client,
      openNode: vi.fn(async () => undefined),
    };
    const controller = new AbortController();

    const abandoned = resolver.resolve([target], context, {
      signal: controller.signal,
    });
    const active = resolver.resolve([target], context);
    await vi.waitFor(() =>
      expect(apiMocks.getVaultMetadataPlans).toHaveBeenCalledOnce(),
    );
    controller.abort();
    pending.resolve({ plans: [planFor(target)] });

    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    await expect(active).resolves.toEqual([
      expect.objectContaining({ status: "ready", nodeId: target.nodeId }),
    ]);
    expect(apiMocks.getVaultMetadataPlans).toHaveBeenCalledOnce();
    expect(openMetadataPlans).toHaveBeenCalledOnce();
  });

  it("aborts obsolete plan I/O when the last navigation consumer leaves", async () => {
    const pending = deferred<{ plans: VaultMetadataPlan[] }>();
    apiMocks.getVaultMetadataPlans.mockReturnValue(pending.promise);
    const target = reference("fil_obsolete_navigation");
    const { client } = fakeClient();
    const resolver = new VaultMetadataResolver();
    const controller = new AbortController();

    const abandoned = resolver.resolve(
      [target],
      {
        csrfToken: "csrf",
        client,
        openNode: vi.fn(async () => undefined),
      },
      { signal: controller.signal },
    );
    await vi.waitFor(() =>
      expect(apiMocks.getVaultMetadataPlans).toHaveBeenCalledOnce(),
    );
    const networkSignal = apiMocks.getVaultMetadataPlans.mock.calls[0][3];
    controller.abort();

    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    expect(networkSignal).toBeInstanceOf(AbortSignal);
    expect(networkSignal.aborted).toBe(true);
  });

  it("rejects stale in-flight results after lock and does not repopulate caches", async () => {
    const pending = deferred<{ plans: VaultMetadataPlan[] }>();
    const target = reference("fil_lock_race");
    apiMocks.getVaultMetadataPlans
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ plans: [planFor(target)] });
    const { client, openMetadataPlans } = fakeClient();
    const resolver = new VaultMetadataResolver();
    const context = {
      csrfToken: "csrf",
      client,
      openNode: vi.fn(async () => undefined),
    };

    const stale = resolver.resolve([target], context);
    await vi.waitFor(() =>
      expect(apiMocks.getVaultMetadataPlans).toHaveBeenCalledOnce(),
    );
    resolver.clear();
    pending.resolve({ plans: [planFor(target)] });

    await expect(stale).rejects.toMatchObject({ code: "VAULT_LOCKED" });
    await expect(resolver.resolve([target], context)).resolves.toHaveLength(1);
    expect(apiMocks.getVaultMetadataPlans).toHaveBeenCalledTimes(2);
    expect(openMetadataPlans).toHaveBeenCalledOnce();
  });
});

function reference(nodeId: string): VaultMetadataReference {
  return {
    nodeId,
    parentId: null,
    recordVersion: 1,
    recordHash,
    generationId,
  };
}

function planFor(referenceValue: VaultMetadataReference): VaultMetadataPlan {
  return {
    nodeId: referenceValue.nodeId,
    entryType: "file",
    generationNumber: 1,
    generationId: referenceValue.generationId,
    ciphertextLength: 4_112,
    cryptoChunkBytes: 4 * 1024 * 1024,
    chunkCount: 1,
    ciphertextMerkleRoot: recordHash,
    bootstrapCbor: "bootstrap",
    bootstrapSignature: "signature",
    encryptedManifest: "manifest",
    wrappers: [],
    signerKeyVersion: 1,
    signerEd25519PublicKey: "signer",
    recordVersion: referenceValue.recordVersion,
    recordHash: referenceValue.recordHash,
    share: null,
  };
}

function fakeClient(): {
  client: VaultCryptoClient;
  getCachedMetadata: ReturnType<typeof vi.fn>;
  openMetadataPlans: ReturnType<typeof vi.fn>;
} {
  const getCachedMetadata = vi.fn(async () => []);
  const openMetadataPlans = vi.fn(
    async (
      plans: VaultMetadataPlan[],
      options: {
        onPriority?(results: VaultMetadataOpenResult[]): void;
      },
    ) => {
      const results: VaultMetadataOpenResult[] = plans.map((plan) => ({
        status: "ready",
        nodeId: plan.nodeId,
        recordHash: plan.recordHash,
        manifest,
      }));
      options.onPriority?.(results);
      return results;
    },
  );
  return {
    client: {
      getCachedMetadata,
      openMetadataPlans,
    } as unknown as VaultCryptoClient,
    getCachedMetadata,
    openMetadataPlans,
  };
}

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve(value: Value): void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
