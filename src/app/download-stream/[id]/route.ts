// Downloads at /download-stream/<id> are answered by the download service
// worker (public/download-sw.js). If one ever reaches the server instead (the
// worker was evicted or the stream expired), 204 keeps the browser on the
// current page rather than navigating away from an unlocked vault.
export function GET(): Response {
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
