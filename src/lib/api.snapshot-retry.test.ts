import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getAdminUsersState,
  getFilesState,
  getRepositoriesState,
  getRepositoryDetailState,
  getStorageOverviewState,
} from "@/lib/api";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "aeralyth_session=session-1" }),
}));

const reads = [
  {
    name: "files",
    read: () => getFilesState("files"),
    forbidden: false,
    notFound: false,
  },
  {
    name: "repositories",
    read: () => getRepositoriesState(),
    forbidden: false,
    notFound: false,
  },
  {
    name: "repository detail",
    read: () => getRepositoryDetailState("repo-1"),
    forbidden: false,
    notFound: true,
  },
  {
    name: "admin users",
    read: () => getAdminUsersState(),
    forbidden: true,
    notFound: false,
  },
  {
    name: "storage overview",
    read: () => getStorageOverviewState(),
    forbidden: true,
    notFound: false,
  },
];

describe.each(reads)(
  "$name snapshot failures",
  ({ read, forbidden, notFound }) => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.each([400, 403, 404, 422])(
      "does not retry a permanent %i response",
      async (status) => {
        const fetchMock = vi
          .fn()
          .mockResolvedValue(new Response(null, { status }));
        vi.stubGlobal("fetch", fetchMock);
        const expected =
          status === 403 && forbidden
            ? { status: "forbidden" }
            : status === 404 && notFound
              ? { status: "not-found" }
              : { status: "unavailable", retryable: false };
        await expect(read()).resolves.toEqual(expected);
        expect(fetchMock).toHaveBeenCalledOnce();
      },
    );

    it("preserves session expiry handling", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
      );
      await expect(read()).resolves.toEqual({ status: "unauthorized" });
    });

    it.each([429, 500, 503])(
      "allows retry after a transient %i response",
      async (status) => {
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue(new Response(null, { status })),
        );
        await expect(read()).resolves.toEqual({
          status: "unavailable",
          retryable: true,
        });
      },
    );

    it("allows retry after a transport failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("connection reset")),
      );
      const state = await read();
      expect(state.status).toBe("unavailable");
      if (state.status === "unavailable")
        expect(state.retryable).not.toBe(false);
    });

    it("allows retry after malformed JSON", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("{", { status: 200 })),
      );
      const state = await read();
      expect(state.status).toBe("unavailable");
      if (state.status === "unavailable")
        expect(state.retryable).not.toBe(false);
    });
  },
);
