// Streams decrypted downloads straight into the browser's download manager.
//
// Browsers without a save dialog for web pages (Brave, Firefox, Safari) used
// to stage the whole plaintext in origin-private storage before handing it
// to the browser, which fails once a file exceeds the site's storage quota.
// The page transfers a ReadableStream here and then navigates to
// /download-stream/<id>; this worker answers that navigation with the stream
// as an attachment, so the browser saves it as it arrives and nothing is kept
// in site storage.
//
// Scope is /download-stream/ only: this worker never sees app pages or API
// requests, and it caches nothing.

const SCOPE_PATH = "/download-stream/";
const ID_PATTERN = /^[0-9a-f]{32}$/;
// A registered stream that is never requested is released, so an abandoned
// download cannot pin the page's decryption pipeline.
const UNCLAIMED_TIMEOUT_MS = 30_000;

const pending = new Map();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("message", (event) => {
  if (event.origin !== self.location.origin) return;
  const data = event.data;
  // Pings carry no data; receiving them keeps this worker alive while a long
  // download streams.
  if (data?.type !== "download") return;
  const { id, fileName, size, stream, port } = data;
  if (
    typeof id !== "string" ||
    !ID_PATTERN.test(id) ||
    typeof fileName !== "string" ||
    !(stream instanceof ReadableStream) ||
    !(port instanceof MessagePort) ||
    (size !== null && !Number.isSafeInteger(size)) ||
    pending.has(id)
  ) {
    if (stream instanceof ReadableStream) stream.cancel().catch(() => {});
    if (port instanceof MessagePort) {
      port.postMessage({ type: "rejected" });
      port.close();
    }
    return;
  }
  const timer = setTimeout(() => {
    if (pending.get(id)?.stream !== stream) return;
    pending.delete(id);
    stream.cancel().catch(() => {});
    port.postMessage({ type: "expired" });
    port.close();
  }, UNCLAIMED_TIMEOUT_MS);
  pending.set(id, { fileName, size, stream, port, timer });
  port.postMessage({ type: "ready" });
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    !url.pathname.startsWith(SCOPE_PATH)
  ) {
    return;
  }
  const id = url.pathname.slice(SCOPE_PATH.length);
  const entry = pending.get(id);
  // Unknown ids fall through to the server, which answers 204 so the page
  // stays where it is.
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.port.postMessage({ type: "started" });
  entry.port.close();

  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": contentDisposition(entry.fileName),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  // The exact length lets the browser show progress and remaining time.
  if (entry.size !== null) headers.set("Content-Length", String(entry.size));
  event.respondWith(new Response(entry.stream, { headers }));
});

function contentDisposition(fileName) {
  const fallback =
    Array.from(fileName, (character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code > 0x7e || '"\\'.includes(character)
        ? "_"
        : character;
    }).join("") || "download";
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
