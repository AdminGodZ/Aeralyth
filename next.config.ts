import type { NextConfig } from "next";

import { nextApiRewrites } from "./deployment/api-routing";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  async headers() {
    return [
      {
        source: "/workers/:asset*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
  async rewrites() {
    return nextApiRewrites(process.env);
  },
};

export default nextConfig;
