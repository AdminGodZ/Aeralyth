/**
 * Worker-thread entry for the MCP server. It runs the browser's vault worker
 * unchanged: that module answers through `globalThis.postMessage` and listens
 * on `globalThis.onmessage`, so both are bridged to the thread's parent port.
 * Argon2id and every other key operation stay off the stdio event loop.
 */
import {
  type Transferable as NodeTransferable,
  parentPort,
} from "node:worker_threads";

type WorkerScope = {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const port = parentPort;
if (!port) throw new Error("The vault worker must run on a worker thread.");

const scope = globalThis as unknown as WorkerScope;
scope.postMessage = (message, transfer) => {
  port.postMessage(message, (transfer ?? []) as unknown as NodeTransferable[]);
};
// Requests can arrive while the worker module is still loading; hold them
// until it has installed its handler instead of dropping them.
let pending: unknown[] | null = [];
port.on("message", (data: unknown) => {
  if (pending) pending.push(data);
  else scope.onmessage?.({ data });
});

await import("@/features/vault/vault.worker");
const queued = pending;
pending = null;
for (const data of queued) scope.onmessage?.({ data });
