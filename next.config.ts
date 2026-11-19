import type { NextConfig } from "next";

import { nextApiRewrites } from "./deployment/api-routing";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
  poweredByHeader: false,
  output: "standalone",
  experimental: {
    // Run PostCSS without the socket-based child-process pool.
    turbopackPluginRuntimeStrategy: "workerThreads",
  },
  async headers() {
    return [
      {
        // The download service worker keeps a stable URL, so caches must
        // revalidate it or a fix reaches browsers (and the CDN) hours late.
        source: "/download-sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      },
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
