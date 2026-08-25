import { afterEach, describe, expect, it, vi } from "vitest";

import { getVaultMetadataPlans } from "@/features/vault/vault-api";

describe("vault metadata plan API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a complete folder page in one metadata-only request", async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => Response.json({ plans: [] }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const nodeIds = Array.from(
      { length: 100 },
      (_, index) => `fil_metadata_${index}`,
    );

    await getVaultMetadataPlans("csrf-token", nodeIds);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/vault/nodes/metadata-plans");
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("csrf-token");
    expect(JSON.parse(String(init?.body))).toEqual({ nodeIds });
  });

  it("sends an encoded-size continuation without changing the authorized targets", async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => Response.json({ plans: [] }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await getVaultMetadataPlans("csrf-token", ["fil_metadata"], 42);

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      nodeIds: ["fil_metadata"],
      continuation: 42,
    });
  });

  it("retries a metadata read shed by recursive-operation capacity", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("recursive operation capacity is full", {
          status: 503,
          headers: { "Retry-After": "0" },
        }),
      )
      .mockResolvedValueOnce(Response.json({ plans: [] }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await getVaultMetadataPlans("csrf-token", ["fil_metadata"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent metadata reads on the shared recursive boundary", async () => {
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
      return Response.json({ plans: [] }, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const reads = Promise.all([
      getVaultMetadataPlans("csrf-token", ["fil_one"]),
      getVaultMetadataPlans("csrf-token", ["fil_two"]),
    ]);

    await vi.waitFor(() => expect(activeRequests).toBe(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseRequest?.();
    await reads;

    expect(peakRequests).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
