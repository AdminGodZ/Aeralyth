import type { NextConfig } from "next";

const apiOrigin = process.env.AERALYTH_API_ORIGIN ?? "http://127.0.0.1:8080";

const nextConfig: NextConfig = {
  devIndicators: false,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiOrigin}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
