import { afterEach, describe, expect, it, vi } from "vitest";

import { getDashboardSession } from "@/features/dashboard/dashboard-session";
import { getSessionBootstrapState } from "@/lib/api";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "aeralyth_session=session-1" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));

const user = {
  id: "user-1",
  username: "one",
  status: "active",
  role: "user",
};
const bootstrap = {
  user,
  csrfToken: "session-1-csrf",
  realtimeCursor: "9007199254740994",
};

describe("dashboard session bootstrap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gets the user, bound CSRF token and exact replay cursor in one private request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(bootstrap));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getDashboardSession()).resolves.toEqual({
      currentUser: user,
      csrfToken: bootstrap.csrfToken,
      realtimeCursor: bootstrap.realtimeCursor,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/auth\/bootstrap$/);
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get("cookie")).toBe(
      "aeralyth_session=session-1",
    );
  });

  it("preserves the login redirect for an expired or revoked session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );
    await expect(getDashboardSession()).rejects.toThrow("redirect:/login");
  });

  it("preserves the backend-error redirect when the private lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection closed")),
    );
    await expect(getDashboardSession()).rejects.toThrow(
      "redirect:/login?error=backend",
    );
  });

  it.each([
    { ...bootstrap, user: null },
    { ...bootstrap, user: { ...user, status: "disabled" } },
    { ...bootstrap, csrfToken: "" },
    { ...bootstrap, realtimeCursor: 10 },
    { ...bootstrap, realtimeCursor: "9223372036854775808" },
  ])("fails closed on an incomplete or invalid bootstrap: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    await expect(getSessionBootstrapState()).resolves.toEqual({
      status: "unavailable",
    });
  });
});
