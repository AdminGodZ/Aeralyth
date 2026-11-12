import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getVaultDownloadPlans,
  MAX_VAULT_DOWNLOAD_PLAN_BATCH,
  VaultApiError,
} from "@/features/vault/vault-api";

describe("vault batched download plan API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns each node's plan or the error the single route would answer", async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () =>
      Response.json({
        results: [
          { nodeId: "fil_a", status: 200, plan: { nodeId: "fil_a" } },
          { nodeId: "fil_b", status: 404 },
          {
            nodeId: "fil_c",
            status: 409,
            error: "share material is still synchronizing",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await getVaultDownloadPlans("csrf-token", [
      "fil_a",
      "fil_b",
      "fil_c",
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/vault/nodes/download-plans");
    expect(init).toMatchObject({ method: "POST" });
    expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("csrf-token");
    expect(JSON.parse(String(init?.body))).toEqual({
      nodeIds: ["fil_a", "fil_b", "fil_c"],
    });
    expect(results[0]).toEqual({ nodeId: "fil_a" });
    expect(results[1]).toBeInstanceOf(VaultApiError);
    expect(results[1]).toMatchObject({ status: 404 });
    expect(results[2]).toMatchObject({
      status: 409,
      message: "share material is still synchronizing",
    });
  });

  it("fetches a plan too large for the batch on its own", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          results: [
            { nodeId: "fil_a", status: 200, plan: { nodeId: "fil_a" } },
            { nodeId: "fil_b", status: 413, error: "too large" },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ nodeId: "fil_b" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getVaultDownloadPlans("csrf-token", ["fil_a", "fil_b"]),
    ).resolves.toEqual([{ nodeId: "fil_a" }, { nodeId: "fil_b" }]);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/vault/nodes/fil_b/download-plan",
    );
  });

  it("rejects a response that does not match the requested nodes", async () => {
    for (const results of [
      [{ nodeId: "fil_a", status: 200, plan: { nodeId: "fil_a" } }],
      [
        { nodeId: "fil_b", status: 200, plan: { nodeId: "fil_b" } },
        { nodeId: "fil_a", status: 200, plan: { nodeId: "fil_a" } },
      ],
      [
        { nodeId: "fil_a", status: 200, plan: { nodeId: "fil_b" } },
        { nodeId: "fil_b", status: 200, plan: { nodeId: "fil_b" } },
      ],
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ results })),
      );
      await expect(
        getVaultDownloadPlans("csrf-token", ["fil_a", "fil_b"]),
      ).rejects.toThrow("does not match");
    }
  });

  it("refuses more nodes than the server accepts", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      getVaultDownloadPlans(
        "csrf-token",
        Array.from(
          { length: MAX_VAULT_DOWNLOAD_PLAN_BATCH + 1 },
          (_, index) => `fil_${index}`,
        ),
      ),
    ).rejects.toThrow("Too many");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
