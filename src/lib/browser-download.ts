/**
 * Hands a blob to the browser as a download. The object URL (and the optional
 * backing resource) is released after a grace period so the save can finish.
 */
export function triggerBlobDownload(
  blob: Blob,
  fileName: string,
  release?: () => void | Promise<void>,
): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    void Promise.resolve(release?.()).catch(() => undefined);
  }, 60_000);
}

/** 128 random bits as lowercase hex, for unique temporary file names. */
export function randomFileToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
