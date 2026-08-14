export type ApiRoutingEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    "AERALYTH_API_ORIGIN" | "AERALYTH_ENABLE_NEXT_API_PROXY" | "NODE_ENV"
  >
>;

export type ApiRewrite = {
  source: string;
  destination: string;
};

const LOCAL_API_ORIGIN = "http://127.0.0.1:8080";

export function apiRewrite(apiOrigin: string): ApiRewrite {
  return {
    source: "/api/:path*",
    destination: `${normalizeApiOrigin(apiOrigin)}/api/:path*`,
  };
}

export function nextApiRewrites(
  environment: ApiRoutingEnvironment,
): ApiRewrite[] {
  const explicitFallback =
    environment.AERALYTH_ENABLE_NEXT_API_PROXY?.trim().toLowerCase() === "true";
  if (environment.NODE_ENV === "production" && !explicitFallback) {
    return [];
  }

  return [apiRewrite(environment.AERALYTH_API_ORIGIN ?? LOCAL_API_ORIGIN)];
}

function normalizeApiOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  const origin = new URL(trimmed);
  if (!["http:", "https:"].includes(origin.protocol)) {
    throw new Error("AERALYTH_API_ORIGIN must use HTTP or HTTPS");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("AERALYTH_API_ORIGIN must be an origin without a path");
  }
  return origin.origin;
}
