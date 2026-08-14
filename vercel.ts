import { deploymentEnv, routes, type VercelConfig } from "@vercel/config/v1";

// This rule executes in Vercel's ingress routing layer. Browser requests keep
// the public /api URL (and therefore the same cookies/CSP origin) without first
// invoking the Next.js server.
export const config: VercelConfig = {
  framework: "nextjs",
  rewrites: [
    routes.rewrite(
      "/api/:path*",
      `${deploymentEnv("AERALYTH_API_ORIGIN")}/api/:path*`,
    ),
  ],
};
