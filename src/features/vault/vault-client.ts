import type {
  VaultDownloadPlan,
  VaultMetadataPlan,
  VaultMetadataReference,
  VaultUnlockMaterial,
} from "@/features/vault/protocol";
import type {
  VaultCachedMetadataResult,
  VaultDecryptedChunk,
  VaultDecryptionStart,
  VaultEncryptedChunk,
  VaultEncryptionComplete,
  VaultEncryptionInput,
  VaultEncryptionStart,
  VaultMetadataOpenResult,
  VaultOpenPlanResult,
  VaultRecoveryResult,
  VaultResumeResult,
  VaultSetupResult,
  VaultShareDirectoryInput,
  VaultShareDirectoryResult,
  VaultShareMaterialInput,
  VaultShareMaterialResult,
  VaultShareRotationInput,
  VaultUnlockResult,
  VaultWorkerProgress,
  VaultWorkerRequest,
  VaultWorkerResponse,
  VaultWorkerResult,
} from "@/features/vault/vault-messages";
import { VAULT_WORKER_URL } from "@/generated/worker-assets";

type WorkerCommand = VaultWorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, "id">
    : never
  : never;

type PendingRequest = {
  resolve(value: VaultWorkerResult): void;
  reject(reason: unknown): void;
  onProgress?(progress: VaultWorkerProgress): void;
  signal?: AbortSignal;
  abort?: () => void;
};

export class VaultWorkerError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "VaultWorkerError";
  }
}

export class VaultCryptoClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor() {
    this.worker = new Worker(VAULT_WORKER_URL, {
      type: "module",
      name: "aeralyth-vault",
    });
    this.worker.addEventListener(
      "message",
      (event: MessageEvent<VaultWorkerResponse>) => {
        const response = event.data;
        const pending = this.pending.get(response.id);
        if (!pending) return;
        if (response.ok && "progress" in response) {
          pending.onProgress?.(response.progress);
          return;
        }
        this.pending.delete(response.id);
        if (pending.abort) {
          pending.signal?.removeEventListener("abort", pending.abort);
        }
        if (response.ok) {
          pending.resolve(response.result);
        } else {
          pending.reject(new VaultWorkerError(response.error, response.code));
        }
      },
    );
    this.worker.addEventListener("error", () => {
      this.failPending(new Error("The vault worker stopped unexpectedly."));
    });
  }

  async preflight(): Promise<void> {
    expectResult(await this.send({ type: "preflight" }), "preflight");
  }

  async setup(password: string): Promise<VaultSetupResult> {
    return expectResult(await this.send({ type: "setup", password }), "setup")
      .result;
  }

  async unlock(
    password: string,
    material: VaultUnlockMaterial,
  ): Promise<VaultUnlockResult> {
    return expectResult(
      await this.send({ type: "unlock", password, material }),
      "unlock",
    ).result;
  }

  async resume(
    sessionId: string,
    sessionBinding: string,
    material: VaultUnlockMaterial,
  ): Promise<VaultResumeResult> {
    return expectResult(
      await this.send({
        type: "resume",
        sessionId,
        sessionBinding,
        material,
      }),
      "resume",
    ).result;
  }

  async persistSession(
    sessionId: string,
    sessionBinding: string,
    expiresAt: number,
    vaultVersion: number,
  ): Promise<void> {
    expectResult(
      await this.send({
        type: "persistSession",
        sessionId,
        sessionBinding,
        expiresAt,
        vaultVersion,
      }),
      "persistSession",
    );
  }

  async extendSession(sessionId: string, expiresAt: number): Promise<void> {
    expectResult(
      await this.send({ type: "extendSession", sessionId, expiresAt }),
      "extendSession",
    );
  }

  async recover(
    recoveryCode: string,
    newPassword: string,
    material: VaultUnlockMaterial,
  ): Promise<VaultRecoveryResult> {
    return expectResult(
      await this.send({
        type: "recover",
        recoveryCode,
        newPassword,
        material,
      }),
      "recover",
    ).result;
  }

  async lock(): Promise<void> {
    if (!this.closed) expectResult(await this.send({ type: "lock" }), "lock");
  }

  async openPlan(plan: VaultMetadataPlan): Promise<VaultOpenPlanResult> {
    return expectResult(await this.send({ type: "openPlan", plan }), "openPlan")
      .result;
  }

  async getCachedMetadata(
    references: VaultMetadataReference[],
    signal?: AbortSignal,
  ): Promise<VaultCachedMetadataResult[]> {
    return expectResult(
      await this.send({ type: "getCachedMetadata", references }, [], {
        signal,
      }),
      "getCachedMetadata",
    ).results;
  }

  async openMetadataPlans(
    plans: VaultMetadataPlan[],
    {
      concurrency,
      priorityCount,
      signal,
      onPriority,
    }: {
      concurrency: number;
      priorityCount: number;
      signal?: AbortSignal;
      onPriority?(results: VaultMetadataOpenResult[]): void;
    },
  ): Promise<VaultMetadataOpenResult[]> {
    return expectResult(
      await this.send(
        { type: "openMetadataPlans", plans, concurrency, priorityCount },
        [],
        {
          signal,
          onProgress(progress) {
            if (progress.type === "openMetadataPlans") {
              onPriority?.(progress.results);
            }
          },
        },
      ),
      "openMetadataPlans",
    ).results;
  }

  async startEncryption(
    input: VaultEncryptionInput,
  ): Promise<VaultEncryptionStart> {
    return expectResult(
      await this.send({ type: "startEncryption", input }),
      "startEncryption",
    ).result;
  }

  async encryptChunk(
    sessionId: string,
    chunkIndex: number,
    plaintext: ArrayBuffer,
  ): Promise<VaultEncryptedChunk> {
    return expectResult(
      await this.send(
        { type: "encryptChunk", sessionId, chunkIndex, plaintext },
        [plaintext],
      ),
      "encryptChunk",
    ).result;
  }

  async finalizeEncryption(
    sessionId: string,
  ): Promise<VaultEncryptionComplete> {
    return expectResult(
      await this.send({ type: "finalizeEncryption", sessionId }),
      "finalizeEncryption",
    ).result;
  }

  async abortEncryption(sessionId: string, nodeId: string): Promise<void> {
    expectResult(
      await this.send({ type: "abortEncryption", sessionId, nodeId }),
      "abortEncryption",
    );
  }

  async createShareDirectory(
    input: VaultShareDirectoryInput,
  ): Promise<VaultShareDirectoryResult> {
    return expectResult(
      await this.send({ type: "createShareDirectory", input }),
      "createShareDirectory",
    ).result;
  }

  async startDecryption(
    plan: VaultDownloadPlan,
  ): Promise<VaultDecryptionStart> {
    return expectResult(
      await this.send({ type: "startDecryption", plan }),
      "startDecryption",
    ).result;
  }

  async decryptChunk(
    sessionId: string,
    chunkIndex: number,
    ciphertext: ArrayBuffer,
  ): Promise<VaultDecryptedChunk> {
    return expectResult(
      await this.send(
        { type: "decryptChunk", sessionId, chunkIndex, ciphertext },
        [ciphertext],
      ),
      "decryptChunk",
    ).result;
  }

  async finalizeDecryption(sessionId: string): Promise<void> {
    expectResult(
      await this.send({ type: "finalizeDecryption", sessionId }),
      "finalizeDecryption",
    );
  }

  async abortDecryption(sessionId: string): Promise<void> {
    expectResult(
      await this.send({ type: "abortDecryption", sessionId }),
      "abortDecryption",
    );
  }

  async createShareMaterial(
    input: VaultShareMaterialInput,
  ): Promise<VaultShareMaterialResult> {
    return expectResult(
      await this.send({ type: "createShareMaterial", input }),
      "createShareMaterial",
    ).result;
  }

  async rotateShareMaterial(
    input: VaultShareRotationInput,
  ): Promise<VaultShareMaterialResult> {
    return expectResult(
      await this.send({ type: "rotateShareMaterial", input }),
      "rotateShareMaterial",
    ).result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    this.failPending(new Error("The vault worker was closed."));
  }

  private send(
    command: WorkerCommand,
    transfer: Transferable[] = [],
    options: {
      signal?: AbortSignal;
      onProgress?(progress: VaultWorkerProgress): void;
    } = {},
  ): Promise<VaultWorkerResult> {
    if (this.closed) {
      return Promise.reject(new Error("The vault worker is closed."));
    }
    const id = this.nextId;
    this.nextId += 1;
    const request = { ...command, id } as VaultWorkerRequest;
    if (options.signal?.aborted) {
      return Promise.reject(abortReason(options.signal));
    }
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        onProgress: options.onProgress,
        signal: options.signal,
      };
      if (options.signal) {
        pending.abort = () => {
          if (!this.pending.delete(id)) return;
          reject(abortReason(options.signal as AbortSignal));
        };
        options.signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pending.set(id, pending);
      this.worker.postMessage(request, transfer);
    });
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.abort) {
        pending.signal?.removeEventListener("abort", pending.abort);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("The operation was aborted.", "AbortError")
  );
}

function expectResult<Type extends VaultWorkerResult["type"]>(
  result: VaultWorkerResult,
  type: Type,
): Extract<VaultWorkerResult, { type: Type }> {
  if (result.type !== type) {
    throw new Error(`The vault worker returned ${result.type} for ${type}.`);
  }
  return result as Extract<VaultWorkerResult, { type: Type }>;
}
