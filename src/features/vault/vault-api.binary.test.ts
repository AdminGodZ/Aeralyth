import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createVaultShare,
  publishShareDirectory,
  publishVaultEpochRotation,
  publishVaultUpload,
} from "@/features/vault/vault-api";
import { VAULT_PUBLICATION_CONTENT_TYPE } from "@/features/vault/vault-wire";

describe("vault publication API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends every large node/share publication as raw binary", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("share-sync-jobs")) {
          return new Response(null, { status: 204 });
        }
        return new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const signature = new Uint8Array(64);
    const wrapper = new Uint8Array([7, 8, 9]);
    const ownerEpochKey = {
      wrapperId: new Uint8Array(16),
      ciphertext: new Uint8Array(48),
    };

    await publishVaultUpload("csrf", "upl_test", [], {
      bootstrapCbor: new Uint8Array([1]),
      bootstrapSignature: signature,
      encryptedManifest: new Uint8Array(16),
      wrappers: [wrapper],
    });
    await publishShareDirectory(
      "csrf",
      {
        nodeId: "fil_test",
        entryType: "folder",
        generationNumber: 1,
        generationId: "generation",
        recordVersion: 1,
        recordHash: "record",
      },
      {
        directoryCbor: new Uint8Array([2]),
        directorySignature: signature,
        wrappers: [wrapper],
      },
    );
    await createVaultShare("csrf", {
      shareId: "shr_test",
      rootNodeId: "fil_test",
      recipientId: "usr_test",
      recipientKeyVersion: 1,
      wrappers: [wrapper],
      envelopes: [{ canonicalCbor: new Uint8Array([3]), signature }],
      ownerEpochKey,
    });
    await publishVaultEpochRotation("csrf", "shr_test", 2, {
      fenceSnapshotHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      wrappers: [wrapper],
      envelopes: [{ canonicalCbor: new Uint8Array([4]), signature }],
      ownerEpochKey,
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const kinds = fetchMock.mock.calls.map(([, init]) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe(VAULT_PUBLICATION_CONTENT_TYPE);
      expect(init?.body).toBeInstanceOf(ArrayBuffer);
      return new Uint8Array(init?.body as ArrayBuffer)[5];
    });
    expect(kinds).toEqual([1, 2, 3, 4]);
  });

  it("serializes upload publications on the recursive-operation boundary", async () => {
    let activeRequests = 0;
    let peakRequests = 0;
    let releaseRequest: (() => void) | undefined;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const fetchMock = vi.fn(async () => {
      activeRequests += 1;
      peakRequests = Math.max(peakRequests, activeRequests);
      await requestGate;
      activeRequests -= 1;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const record = {
      bootstrapCbor: new Uint8Array([1]),
      bootstrapSignature: new Uint8Array(64),
      encryptedManifest: new Uint8Array(16),
      wrappers: [],
    };

    const publications = Promise.all(
      ["one", "two", "three"].map((uploadId) =>
        publishVaultUpload("csrf", uploadId, [], record),
      ),
    );

    await vi.waitFor(() => expect(activeRequests).toBe(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseRequest?.();
    await publications;

    expect(peakRequests).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a capacity shed using Retry-After", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("recursive operation capacity is full", {
          status: 503,
          headers: { "Retry-After": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await publishVaultUpload("csrf", "retry", [], {
      bootstrapCbor: new Uint8Array([1]),
      bootstrapSignature: new Uint8Array(64),
      encryptedManifest: new Uint8Array(16),
      wrappers: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
