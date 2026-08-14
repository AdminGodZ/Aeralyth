import { describe, expect, it } from "vitest";

import { config } from "../vercel";

describe("Vercel API ingress", () => {
  it("routes the complete public API namespace directly to the API origin", () => {
    expect(config.rewrites).toEqual([
      {
        source: "/api/:path*",
        destination: "$AERALYTH_API_ORIGIN/api/:path*",
        env: ["AERALYTH_API_ORIGIN"],
      },
    ]);
  });
});
