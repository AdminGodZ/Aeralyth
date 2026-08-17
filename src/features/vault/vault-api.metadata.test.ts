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
});
