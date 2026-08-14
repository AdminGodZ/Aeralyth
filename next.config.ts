import type { NextConfig } from "next";

import { nextApiRewrites } from "./deployment/api-routing";

const nextConfig: NextConfig = {
  devIndicators: false,
  async rewrites() {
    return nextApiRewrites(process.env);
  },
};

export default nextConfig;
