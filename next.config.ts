import type { NextConfig } from "next";

import { nextApiRewrites } from "./deployment/api-routing";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  async rewrites() {
    return nextApiRewrites(process.env);
  },
};

export default nextConfig;
