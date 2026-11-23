import {
  type Transferable as NodeTransferable,
  Worker,
} from "node:worker_threads";

import type { VaultWorkerPort } from "@/features/vault/vault-client";

/**
 * Starts the vault worker on a Node worker thread and presents it with the
 * Web Worker surface `VaultCryptoClient` expects.
 */
export function startNodeVaultWorker(workerUrl: URL): VaultWorkerPort {
  const worker = new Worker(workerUrl, { name: "aeralyth-vault" });
  // The stdio transport decides when the process ends, not the worker.
  worker.unref();
  return {
    addEventListener(type, listener) {
      if (type === "message") {
        worker.on("message", (data: unknown) => listener({ data }));
      } else if (type === "messageerror") {
        worker.on("messageerror", () => listener({}));
      } else {
        worker.on("error", () => listener({}));
        // An exit nobody asked for is a crash as far as the client is concerned.
        worker.on("exit", () => listener({}));
      }
    },
    postMessage(message, transfer) {
      worker.postMessage(
        message,
        transfer as unknown as readonly NodeTransferable[],
      );
    },
    terminate() {
      worker.removeAllListeners("exit");
      void worker.terminate();
    },
  };
}
