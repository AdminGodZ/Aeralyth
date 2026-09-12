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
parentPort.on("message", (data) => globalThis.onmessage({ data }));
parentPort.postMessage({ hostReady: true });
