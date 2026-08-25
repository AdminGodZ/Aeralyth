import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  VaultMetadataPlan,
  VaultShareNodeSnapshot,
} from "@/features/vault/protocol";
import { getVaultSharePreparationPlans } from "@/features/vault/vault-api";

const generationId = "AAAAAAAAAAAAAAAAAAAAAA";
const recordHash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("vault share preparation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches large subtree plans in sequential pages of at most 100", async () => {
    const nodes = Array.from({ length: 205 }, (_, index) =>
      snapshot(`fil_share_${index}`),
    );
    let active = 0;
    let peak = 0;
    const pageSizes: number[] = [];
    const purposes: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      active += 1;
      peak = Math.max(peak, active);
      const body = JSON.parse(String(init?.body)) as { nodeIds: string[] };
      pageSizes.push(body.nodeIds.length);
      purposes.push((body as { purpose?: unknown }).purpose);
      await Promise.resolve();
      active -= 1;
      return new Response(
        JSON.stringify({
          plans: body.nodeIds.map((nodeId) => metadata(nodeId)),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const plans = await getVaultSharePreparationPlans("csrf", nodes);

    expect(plans).toHaveLength(205);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(pageSizes).toEqual([100, 100, 5]);
    expect(purposes).toEqual([
      "sharePreparation",
      "sharePreparation",
      "sharePreparation",
    ]);
    expect(peak).toBe(1);
  });

  it("keeps the worker scheduler parent-aware and capped at four siblings", () => {
    const worker = readFileSync(
      resolve(import.meta.dirname, "vault.worker.ts"),
      "utf8",
    );
    const dialog = readFileSync(
      resolve(import.meta.dirname, "vault-share-dialog.tsx"),
      "utf8",
    );
    const sharedKeys = worker
      .split("async function openSharedKeys(")[1]
      ?.split("function nullableEqualBytes(")[0];

    expect(worker).toContain("const MAX_SHARE_PREPARATION_CONCURRENCY = 4");
    expect(worker).toContain("pinNodeKey(node.nodeId)");
    expect(worker).toContain("await openAndVerifyPlan(preparation.metadata)");
    expect(worker).not.toContain("wrappersByNode");
    expect(worker).toContain("wrapperHashes.push(...hashes)");
    expect(worker).toContain("onWrapperChunk({");
    expect(worker).toContain("wrappers: [],");
    expect(dialog).toContain("Preparing encrypted wrappers");
    expect(worker).toContain("MAX_SHARE_PREPARATION_CONCURRENCY = 4");
    expect(dialog).toContain("getVaultSharePreparationPlans(");
    expect(dialog).not.toContain("await vault.openNode(node.nodeId)");
    expect(dialog).toContain(
      "const activeBusyRequestRef = useRef<number | null>",
    );
    expect(dialog).toContain(
      "if (activeBusyRequestRef.current !== null) return null",
    );
    expect(dialog).toContain("const requestId = beginBusyRequest()");
    expect(dialog).toContain("if (requestId === null) return");
    expect(dialog).toContain("loadMoreControllerRef.current.abort()");
    expect(dialog).toContain("shareRequestRef.current !== requestId");
    expect(dialog).toContain("activeBusyRequestRef.current = null");
    expect(dialog).toContain("setBusy(false)");
    expect(dialog).toContain("await refreshOwnedShares(requestId)");
    expect(sharedKeys).not.toContain("decodeBootstrap(");
    expect(sharedKeys).not.toContain("map(toBase64Url)");
  });
});

function snapshot(nodeId: string): VaultShareNodeSnapshot {
  return {
    nodeId,
    parentId: null,
    depth: 0,
    entryType: "file",
    generationNumber: 1,
    generationId,
    recordVersion: 1,
    recordHash,
  };
}

function metadata(nodeId: string): VaultMetadataPlan {
  return {
    nodeId,
    entryType: "file",
    generationNumber: 1,
    generationId,
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
    recordVersion: 1,
    recordHash,
    share: null,
  };
}
