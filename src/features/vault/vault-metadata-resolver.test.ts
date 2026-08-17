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
    );
    expect(getCachedMetadata).toHaveBeenCalledOnce();
    expect(openMetadataPlans).toHaveBeenCalledOnce();
    expect(openMetadataPlans.mock.calls[0][0]).toHaveLength(100);
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
