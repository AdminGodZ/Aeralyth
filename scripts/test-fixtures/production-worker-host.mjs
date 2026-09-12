import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";

// Import the emitted browser bundle without a transform or source substitution.
// The surrounding host supplies Worker globals absent from node:worker_threads.
globalThis.self = globalThis;
globalThis.location = new URL(workerData.url);
globalThis.postMessage = (message, transfer = []) =>
  parentPort.postMessage(message, transfer);
if (workerData.forceWasm) {
  globalThis.CompressionStream = undefined;
  globalThis.DecompressionStream = undefined;
  globalThis.fetch = async (input) => {
    const url = new URL(input, globalThis.location.href);
    if (
      url.href !== new URL(workerData.wasmUrl, globalThis.location.href).href
    ) {
      throw new Error(
        `Unexpected production worker asset request: ${url.href}`,
      );
    }
    const bytes = await readFile(workerData.wasmPath);
    parentPort.postMessage({ hostAssetRequest: url.pathname });
    return new Response(bytes, {
      headers: { "Content-Type": "application/wasm" },
    });
  };
}

// libsodium must select its browser path, just as it does in production.
globalThis.process = undefined;
const source = await readFile(workerData.modulePath);
// A data URL selects ESM on every supported Node version without reparsing .js
// as CommonJS first. Its decoded content is still the exact published file.
await import(`data:text/javascript;base64,${source.toString("base64")}`);
parentPort.on("message", (message) => {
  const data = message.hostRequest ?? message;
  // Node 22 clones File as Blob and drops its name and lastModified. Browsers
  // preserve both. Reconstruct that browser boundary before calling the exact
  // emitted worker, using metadata sent separately from the parent fixture.
  for (const metadata of message.hostFileMetadata ?? []) {
    const source = data.sources[metadata.index];
    source.file = new File([source.file], metadata.name, {
      type: source.file.type,
      lastModified: metadata.lastModified,
    });
  }
  globalThis.onmessage({ data });
});
parentPort.postMessage({ hostReady: true });
