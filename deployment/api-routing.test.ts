import { afterEach, describe, expect, it, vi } from "vitest";

import nextConfig from "../next.config";
import { apiRewrite, nextApiRewrites } from "./api-routing";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("API ingress routing", () => {
  it("keeps the convenient Next proxy in development", () => {
    expect(nextApiRewrites({ NODE_ENV: "development" })).toEqual([
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:8080/api/:path*",
      },
    ]);
  });

  it("does not put production API traffic through the Next process", () => {
    expect(
      nextApiRewrites({
        NODE_ENV: "production",
        AERALYTH_API_ORIGIN: "https://api.example.test",
      }),
    ).toEqual([]);
  });

  it("wires the production-safe policy into the actual Next config", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AERALYTH_ENABLE_NEXT_API_PROXY", "false");

    expect(await nextConfig.rewrites?.()).toEqual([]);
  });

  it("requires an explicit escape hatch for a standalone next start", () => {
    expect(
      nextApiRewrites({
        NODE_ENV: "production",
        AERALYTH_API_ORIGIN: "https://api.example.test/",
        AERALYTH_ENABLE_NEXT_API_PROXY: "true",
      }),
    ).toEqual([
      {
        source: "/api/:path*",
        destination: "https://api.example.test/api/:path*",
      },
    ]);
  });

  it("rejects an API target with an embedded path", () => {
    expect(() => apiRewrite("https://api.example.test/backend")).toThrow(
      "must be an origin without a path",
    );
  });
});
