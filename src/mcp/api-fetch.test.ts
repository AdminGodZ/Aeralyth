import { describe, expect, it, vi } from "vitest";

import { createApiFetch, normalizeOrigin } from "@/mcp/api-fetch";

function recordingFetch(responses: Response[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return responses.shift() ?? new Response("{}");
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

describe("normalizeOrigin", () => {
  it("keeps only the origin of an https URL", () => {
    expect(normalizeOrigin("https://vault.example.com/some/page")).toBe(
      "https://vault.example.com",
    );
  });

  it("allows plain http only on this machine", () => {
    expect(normalizeOrigin("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080",
    );
    expect(() => normalizeOrigin("http://vault.example.com")).toThrow(/https/);
  });

  it("rejects credentials and other schemes", () => {
    expect(() => normalizeOrigin("https://user:pw@vault.example.com")).toThrow(
      /credentials/,
    );
    expect(() => normalizeOrigin("ftp://vault.example.com")).toThrow();
    expect(() => normalizeOrigin("not a url")).toThrow(/valid URL/);
  });
});

describe("createApiFetch", () => {
  it("sends relative API paths to the origin with the session cookie", async () => {
    const { calls, fetch } = recordingFetch([
      new Response("{}", {
        headers: {
          "Set-Cookie": "aeralyth_session=secret; Path=/; HttpOnly",
        },
      }),
      new Response("{}"),
    ]);
    const api = createApiFetch({
      origin: "https://vault.example.com",
      userAgent: "test-agent",
      fetch,
    });

    await api.fetch("/api/auth/login-json", { method: "POST" });
    await api.fetch("/api/files?view=files", {
      headers: { Accept: "application/json" },
    });

    expect(calls[0].url).toBe("https://vault.example.com/api/auth/login-json");
    expect(new Headers(calls[0].init?.headers).get("cookie")).toBeNull();
    const second = new Headers(calls[1].init?.headers);
    expect(calls[1].url).toBe("https://vault.example.com/api/files?view=files");
    expect(second.get("cookie")).toBe("aeralyth_session=secret");
    expect(second.get("accept")).toBe("application/json");
    expect(second.get("user-agent")).toBe("test-agent");
    expect(calls[1].init?.redirect).toBe("manual");
    expect(api.hasCookie("aeralyth_session")).toBe(true);
  });

  it("never sends the session cookie to absolute URLs", async () => {
    const { calls, fetch } = recordingFetch([
      new Response("{}", {
        headers: { "Set-Cookie": "aeralyth_session=secret; Path=/" },
      }),
      new Response("{}"),
    ]);
    const api = createApiFetch({
      origin: "https://vault.example.com",
      userAgent: "test-agent",
      fetch,
    });
    await api.fetch("/api/auth/login-json");
    await api.fetch("https://bucket.example.net/object?signature=1", {
      method: "PUT",
    });

    expect(calls[1].url).toBe("https://bucket.example.net/object?signature=1");
    expect(new Headers(calls[1].init?.headers).get("cookie")).toBeNull();
  });

  it("drops cookies the API expires and reports every status", async () => {
    const statuses: Array<[number, string]> = [];
    const { fetch } = recordingFetch([
      new Response("{}", {
        headers: { "Set-Cookie": "aeralyth_session=secret" },
      }),
      new Response("", {
        status: 401,
        headers: { "Set-Cookie": "aeralyth_session=; Max-Age=0" },
      }),
    ]);
    const api = createApiFetch({
      origin: "https://vault.example.com",
      userAgent: "test-agent",
      fetch,
      onApiResponse: (status, path) => statuses.push([status, path]),
    });
    await api.fetch("/api/auth/login-json");
    await api.fetch("/api/files");

    expect(api.hasCookie("aeralyth_session")).toBe(false);
    expect(statuses).toEqual([
      [200, "/api/auth/login-json"],
      [401, "/api/files"],
    ]);
  });

  it("refuses protocol-relative URLs", async () => {
    const { fetch } = recordingFetch([]);
    const api = createApiFetch({
      origin: "https://vault.example.com",
      userAgent: "test-agent",
      fetch,
    });
    await expect(api.fetch("//evil.example/api")).rejects.toThrow(
      /Protocol-relative/,
    );
  });
});
