import { instantiateRawDeflater } from "@/features/archive/raw-deflate";
import {
  createFolderZipArchive,
  type FolderZipEnvironment,
} from "@/features/dashboard/folder-zip-archive";
import type {
  FolderZipWorkerRequest,
  FolderZipWorkerResponse,
} from "@/features/dashboard/folder-zip-messages";
import {
  type FolderZipHelperRequest,
  type FolderZipHelperResponse,
  type FolderZipTask,
  type FolderZipTaskContext,
  runFolderZipTask,
} from "@/features/dashboard/folder-zip-tasks";
import { createIntervalProgressCoalescer } from "@/features/uploads/progress-coalescer";
import { ZIP_WASM_URL } from "@/generated/zip-assets";

// This script runs in two roles. The page starts it as the coordinator, which
// starts further copies of itself as helpers that compress in parallel.
type WorkerScope = {
  location: { href: string };
  onmessage:
    | ((
        event: MessageEvent<FolderZipWorkerRequest | FolderZipHelperRequest>,
      ) => void)
    | null;
  postMessage(
    message: FolderZipWorkerResponse | FolderZipHelperResponse,
    transfer?: Transferable[],
  ): void;
};

const workerScope = self as unknown as WorkerScope;
let activeController: AbortController | null = null;
let helperContext: Promise<FolderZipTaskContext> | null = null;

workerScope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "helper-init") {
    initializeHelper(message);
    return;
  }
  if (message.type === "helper-task") {
    void runHelperTask(message.task);
    return;
  }
  if (message.type === "cancel") {
    activeController?.abort();
    return;
  }

  if (activeController) {
    return;
  }

  void createArchive(message);
};

const environment: FolderZipEnvironment = {
  hardwareConcurrency:
    typeof navigator === "undefined"
      ? undefined
      : navigator.hardwareConcurrency,
  async loadWasm() {
    const response = await fetch(
      new URL(ZIP_WASM_URL, workerScope.location.href).href,
    );
    if (!response.ok) throw new Error("The zlib module could not be loaded.");
    return response.arrayBuffer();
  },
  // The production CSP only allows same-origin worker scripts, which this
  // script's own URL is.
  ...(typeof Worker === "undefined"
    ? {}
    : {
        spawnHelper(listener) {
          const worker = new Worker(workerScope.location.href, {
            type: "module",
            name: "aeralyth-folder-zip-helper",
          });
          worker.addEventListener(
            "message",
            (event: MessageEvent<FolderZipHelperResponse>) =>
              listener.message(event.data),
          );
          worker.addEventListener("error", (event) => {
            event.preventDefault();
            listener.failure();
          });
          worker.addEventListener("messageerror", () => listener.failure());
          return {
            post: (message) => worker.postMessage(message),
            terminate: () => worker.terminate(),
          };
        },
      }),
};

async function createArchive(
  request: Extract<FolderZipWorkerRequest, { type: "compress" }>,
) {
  const controller = new AbortController();
  activeController = controller;
  const progressReporter = createIntervalProgressCoalescer(
    (message: Extract<FolderZipWorkerResponse, { type: "progress" }>) =>
      workerScope.postMessage(message),
  );

  try {
    const archive = await createFolderZipArchive(request, {
      signal: controller.signal,
      onProgress: (progress) => progressReporter.publish(progress),
      environment,
    });

    if (controller.signal.aborted) {
      workerScope.postMessage({ type: "canceled" });
      return;
    }

    progressReporter.flush();
    workerScope.postMessage({ type: "complete", archive });
  } catch (error) {
    if (controller.signal.aborted) {
      workerScope.postMessage({ type: "canceled" });
      return;
    }

    workerScope.postMessage({
      type: "error",
      message: errorMessage(error),
    });
  } finally {
    activeController = null;
  }
}

function initializeHelper(
  message: Extract<FolderZipHelperRequest, { type: "helper-init" }>,
) {
  helperContext = (async () => ({
    deflater: message.wasm ? await instantiateRawDeflater(message.wasm) : null,
    nativeDeflate: message.nativeDeflate,
    emitPart(id: number, part: ArrayBuffer) {
      workerScope.postMessage({ type: "helper-part", id, part }, [part]);
    },
  }))();
  helperContext.then(
    () => workerScope.postMessage({ type: "helper-ready" }),
    (error) =>
      workerScope.postMessage({
        type: "helper-failed",
        message: errorMessage(error),
      }),
  );
}

async function runHelperTask(task: FolderZipTask) {
  let context: FolderZipTaskContext;
  try {
    if (!helperContext) throw new Error("The ZIP helper is not initialized.");
    context = await helperContext;
  } catch {
    // The coordinator already learned that this helper cannot run tasks.
    return;
  }
  try {
    const { result, transfer } = await runFolderZipTask(task, context);
    workerScope.postMessage({ type: "helper-result", result }, transfer);
  } catch (error) {
    workerScope.postMessage({
      type: "helper-error",
      id: task.id,
      message: errorMessage(error),
    });
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : "The ZIP archive could not be created.";
}
