/**
 * The vault modules call the API the way a page does: relative `/api/...`
 * URLs whose session rides in a same-origin cookie. On Node there is no page,
 * so this fetch resolves those URLs against the configured Aeralyth origin
 * and keeps the session cookie the API sets. Absolute URLs, such as presigned
 * storage URLs, go out untouched and never carry the session cookie.
 */
export type ApiFetchOptions = {
  origin: string;
  userAgent: string;
  fetch?: typeof fetch;
  /** Called with every API response status, so the session can see a 401. */
  onApiResponse?(status: number, path: string): void;
};

export type ApiFetch = {
  fetch: typeof fetch;
  clearCookies(): void;
  hasCookie(name: string): boolean;
};

export function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`AERALYTH_URL is not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("AERALYTH_URL must start with https:// or http://.");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) {
    throw new Error(
      "AERALYTH_URL must use https:// unless it points at this machine.",
    );
  }
  if (url.username || url.password) {
    throw new Error("AERALYTH_URL must not contain credentials.");
  }
  return url.origin;
}

export function createApiFetch({
  origin,
  userAgent,
  fetch: baseFetch = globalThis.fetch.bind(globalThis),
  onApiResponse,
}: ApiFetchOptions): ApiFetch {
  const apiOrigin = normalizeOrigin(origin);
  const cookies = new Map<string, string>();

  const apiFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // Only a page-relative path is an API call: a URL or Request built on
    // Node is already absolute and belongs to someone else.
    if (typeof input !== "string" || !input.startsWith("/")) {
      return baseFetch(input, init);
    }
    if (input.startsWith("//")) {
      throw new TypeError("Protocol-relative URLs are not API requests.");
    }
    const url = new URL(input, apiOrigin);
    const headers = new Headers(init?.headers);
    if (cookies.size > 0) {
      headers.set(
        "Cookie",
        Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    headers.set("User-Agent", userAgent);
    const response = await baseFetch(url, {
      ...init,
      headers,
      // A redirect must never carry the session cookie to another origin.
      redirect: "manual",
    });
    storeCookies(cookies, response.headers);
    onApiResponse?.(response.status, url.pathname);
    return response;
  };

  return {
    fetch: apiFetch as typeof fetch,
    clearCookies: () => cookies.clear(),
    hasCookie: (name) => cookies.has(name),
  };
}

function storeCookies(cookies: Map<string, string>, headers: Headers): void {
  for (const header of headers.getSetCookie()) {
    const [pair, ...attributes] = header.split(";");
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    const expired = attributes.some((attribute) => {
      const [key, raw = ""] = attribute.split("=");
      const option = key.trim().toLowerCase();
      if (option === "max-age") return Number(raw.trim()) <= 0;
      if (option === "expires") {
        const expires = Date.parse(raw.trim());
        return Number.isFinite(expires) && expires <= Date.now();
      }
      return false;
    });
    if (expired || value === "") cookies.delete(name);
    else cookies.set(name, value);
  }
}
