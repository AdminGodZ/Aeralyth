import type {
  VaultDownloadPlan,
  VaultUnlockMaterial,
} from "@/features/vault/protocol";
import type {
  VaultDecryptedChunk,
  VaultDecryptionStart,
  VaultEncryptedChunk,
  VaultEncryptionComplete,
  VaultEncryptionInput,
  VaultEncryptionStart,
  VaultOpenPlanResult,
  VaultRecoveryResult,
  VaultSetupResult,
  VaultShareDirectoryInput,
  VaultShareDirectoryResult,
  VaultShareMaterialInput,
  VaultShareMaterialResult,
  VaultShareRotationInput,
  VaultUnlockResult,
  VaultWorkerRequest,
  VaultWorkerResponse,
  VaultWorkerResult,
} from "@/features/vault/vault-messages";

type WorkerCommand = VaultWorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, "id">
    : never
  : never;

type PendingRequest = {
  resolve(value: VaultWorkerResult): void;
  reject(reason: unknown): void;
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
    this.worker = new Worker("/vault.worker.js", {
      type: "module",
      name: "aeralyth-vault",
    });
    this.worker.addEventListener(
      "message",
      (event: MessageEvent<VaultWorkerResponse>) => {
        const response = event.data;
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id);
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

  async openPlan(plan: VaultDownloadPlan): Promise<VaultOpenPlanResult> {
    return expectResult(await this.send({ type: "openPlan", plan }), "openPlan")
      .result;
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
    await this.lock().catch(() => undefined);
    this.closed = true;
    this.worker.terminate();
    this.failPending(new Error("The vault worker was closed."));
  }

  private send(
    command: WorkerCommand,
    transfer: Transferable[] = [],
  ): Promise<VaultWorkerResult> {
    if (this.closed) {
      return Promise.reject(new Error("The vault worker is closed."));
    }
    const id = this.nextId;
    this.nextId += 1;
    const request = { ...command, id } as VaultWorkerRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(request, transfer);
    });
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
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
