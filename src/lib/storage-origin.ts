/**
 * Returns the bucket origin the browser reaches directly, or null when storage
 * is local or the value is not an http(s) URL. Plain http is accepted only in
 * development.
 */
export function getStorageOrigin(
  value: string | undefined,
  isDevelopment: boolean,
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !isDevelopment) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function getConfiguredStorageOrigin(): string | null {
  return getStorageOrigin(
    process.env.AERALYTH_S3_CSP_ORIGIN,
    process.env.NODE_ENV === "development",
  );
}
