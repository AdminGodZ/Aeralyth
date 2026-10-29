import type {
  VaultDownloadPlan,
  VaultMetadataPlan,
  VaultMetadataReference,
  VaultPasswordRewrapPayload,
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
  VaultShareMaterialProgress,
  VaultShareMaterialResult,
  VaultShareRotationInput,
  VaultUnlockResult,
  VaultWorkerProgress,
  VaultWorkerRequest,
  VaultWorkerResponse,
  VaultWorkerResult,
} from "@/features/vault/vault-messages";
import { VAULT_WORKER_URL } from "@/generated/worker-assets";
import { abortReason } from "@/lib/abort";

type WorkerCommand = VaultWorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, "id">
    : never
  : never;

type PendingRequest = {
  type: WorkerCommand["type"];
  timeoutMs: number;
  watchdog?: ReturnType<typeof setTimeout>;
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
  private terminalError: VaultWorkerError | null = null;

  constructor(
    private readonly onFatalError?: (error: VaultWorkerError) => void,
  ) {
    try {
      this.worker = new Worker(VAULT_WORKER_URL, {
        type: "module",
        name: "aeralyth-vault",
      });
    } catch {
      throw new VaultWorkerError(
        "The vault worker could not start. Reload the page and unlock the vault again.",
        "WORKER_UNAVAILABLE",
      );
    }
    this.worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      const response = event.data;
      if (this.closed) return;
      if (!isWorkerResponse(response)) {
        this.failTerminal("The vault worker returned an invalid response.");
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      if (response.ok && "progress" in response) {
        if (!isExpectedProgress(response.progress, pending.type)) {
          this.failTerminal("The vault worker returned invalid progress.");
          return;
        }
        this.armWatchdog(pending);
        try {
          pending.onProgress?.(response.progress);
        } catch {
          this.failTerminal("Vault progress could not be processed safely.");
        }
        return;
      }
      if (response.ok && !isExpectedResult(response.result, pending.type)) {
        this.failTerminal("The vault worker returned an unexpected result.");
        return;
      }
      this.pending.delete(response.id);
      this.cleanPending(pending);
      if (response.ok) {
        pending.resolve(response.result);
      } else {
        pending.reject(new VaultWorkerError(response.error, response.code));
      }
    });
    this.worker.addEventListener("error", () => {
      this.failTerminal("The vault worker stopped unexpectedly.");
    });
    this.worker.addEventListener("messageerror", () => {
      this.failTerminal("The vault worker response could not be decoded.");
    });
  }

  async preflight(): Promise<void> {
    expectResult(await this.send({ type: "preflight" }), "preflight");
  }

  async deriveAuthCredential(
    username: string,
    password: string,
    salt: string,
  ): Promise<string> {
    return expectResult(
      await this.send({
        type: "deriveAuthCredential",
        username,
        password,
        salt,
      }),
      "deriveAuthCredential",
    ).credential;
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

  async rewrapPassword(
    currentPassword: string,
    newPassword: string,
    material: VaultUnlockMaterial,
  ): Promise<VaultPasswordRewrapPayload> {
    return expectResult(
      await this.send({
        type: "rewrapPassword",
        currentPassword,
        newPassword,
        material,
      }),
      "rewrapPassword",
    ).result.payload;
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

  async clearShareContextCache(cacheKey: string): Promise<void> {
    expectResult(
      await this.send({ type: "clearShareContextCache", cacheKey }),
      "clearShareContextCache",
    );
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
    options: {
      onProgress?(progress: VaultShareMaterialProgress): void;
    } = {},
  ): Promise<VaultShareMaterialResult> {
    const collector = createShareMaterialCollector(input.nodes, options);
    const material = expectResult(
      await this.send({ type: "createShareMaterial", input }, [], {
        onProgress: collector.accept,
      }),
      "createShareMaterial",
    ).result;
    return collector.finish(material);
  }

  async rotateShareMaterial(
    input: VaultShareRotationInput,
    options: {
      onProgress?(progress: VaultShareMaterialProgress): void;
    } = {},
  ): Promise<VaultShareMaterialResult> {
    const collector = createShareMaterialCollector(input.nodes, options);
    const material = expectResult(
      await this.send({ type: "rotateShareMaterial", input }, [], {
        onProgress: collector.accept,
      }),
      "rotateShareMaterial",
    ).result;
    return collector.finish(material);
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
      return Promise.reject(
        this.terminalError ?? new Error("The vault worker is closed."),
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    const request = { ...command, id } as VaultWorkerRequest;
    if (options.signal?.aborted) {
      return Promise.reject(abortReason(options.signal));
    }
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        type: command.type,
        timeoutMs: workerWatchdogMs(command),
        resolve,
        reject,
        onProgress: options.onProgress,
        signal: options.signal,
      };
      if (options.signal) {
        pending.abort = () => {
          if (!this.pending.delete(id)) return;
          this.cleanPending(pending);
          if (request.type === "openMetadataPlans") {
            // Track the acknowledgment so a worker which ignores cancellation
            // cannot silently retain an abandoned metadata operation forever.
            void this.send({
              type: "cancelMetadataOperation",
              operationId: id,
            }).catch(() => {
              this.failTerminal(
                "The vault worker could not cancel an operation.",
              );
            });
          }
          reject(abortReason(options.signal as AbortSignal));
        };
        options.signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pending.set(id, pending);
      this.armWatchdog(pending);
      try {
        this.worker.postMessage(request, transfer);
      } catch {
        this.failTerminal("The vault worker request could not be delivered.");
      }
    });
  }

  private armWatchdog(pending: PendingRequest): void {
    clearTimeout(pending.watchdog);
    pending.watchdog = setTimeout(() => {
      this.failTerminal(
        `The vault worker stopped responding during ${pending.type}.`,
      );
    }, pending.timeoutMs);
  }

  private cleanPending(pending: PendingRequest): void {
    clearTimeout(pending.watchdog);
    if (pending.abort) {
      pending.signal?.removeEventListener("abort", pending.abort);
    }
  }

  private failTerminal(message: string): void {
    if (this.closed) return;
    const error = new VaultWorkerError(
      `${message} Unlock the vault again to recover. If this repeats, reload the page.`,
      "WORKER_UNAVAILABLE",
    );
    this.terminalError = error;
    this.closed = true;
    this.worker.terminate();
    this.failPending(error);
    this.onFatalError?.(error);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      this.cleanPending(pending);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function workerWatchdogMs(command: WorkerCommand): number {
  switch (command.type) {
    // Password derivation can take minutes on a low-memory device. It has no
    // progress channel, so it must not share the transfer-chunk deadline.
    case "deriveAuthCredential":
    case "setup":
    case "unlock":
    case "recover":
    case "rewrapPassword":
      return 10 * 60_000;
    case "preflight":
      return 30_000;
    case "cancelMetadataOperation":
    case "abortEncryption":
    case "abortDecryption":
    case "lock":
      return 30_000;
    case "openMetadataPlans":
      return Math.max(120_000, command.plans.length * 2_000);
    default:
      // Share preparation resets this deadline as each node completes. Crypto
      // chunks and other RPCs are individually bounded, not entire transfers.
      return 120_000;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWorkerResponse(value: unknown): value is VaultWorkerResponse {
  if (
    !isObject(value) ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 1 ||
    typeof value.ok !== "boolean"
  )
    return false;
  if (!value.ok) {
    return (
      typeof value.error === "string" &&
      (value.code === undefined || typeof value.code === "string")
    );
  }
  if ("progress" in value) {
    return !("result" in value) && isObject(value.progress);
  }
  return isObject(value.result) && typeof value.result.type === "string";
}

function isExpectedProgress(
  progress: VaultWorkerProgress,
  type: WorkerCommand["type"],
): boolean {
  if (type === "openMetadataPlans") {
    return (
      progress.type === type &&
      Array.isArray(progress.results) &&
      progress.results.every(isMetadataResult)
    );
  }
  if (type === "createShareMaterial" || type === "rotateShareMaterial") {
    return (
      progress.type === "shareMaterial" &&
      typeof progress.nodeId === "string" &&
      Array.isArray(progress.wrappers) &&
      progress.wrappers.every((wrapper) => wrapper instanceof Uint8Array) &&
      Number.isSafeInteger(progress.completedNodes) &&
      Number.isSafeInteger(progress.totalNodes)
    );
  }
  return false;
}

function isMetadataResult(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.nodeId === "string" &&
    typeof value.recordHash === "string" &&
    ((value.status === "ready" && isObject(value.manifest)) ||
      (value.status === "unavailable" && typeof value.error === "string"))
  );
}

function isExpectedResult(
  value: VaultWorkerResult,
  type: WorkerCommand["type"],
): boolean {
  if (value.type !== type) return false;
  const result: unknown = "result" in value ? value.result : null;
  switch (value.type) {
    case "preflight":
      return value.supported === true;
    case "deriveAuthCredential":
      return typeof value.credential === "string";
    case "getCachedMetadata":
    case "openMetadataPlans":
      return (
        Array.isArray(value.results) && value.results.every(isMetadataResult)
      );
    case "startEncryption":
      return (
        isObject(result) &&
        typeof result.sessionId === "string" &&
        typeof result.nodeId === "string" &&
        Number.isSafeInteger(result.chunkCount)
      );
    case "encryptChunk":
      return (
        isObject(result) &&
        result.ciphertext instanceof ArrayBuffer &&
        Number.isSafeInteger(result.ciphertextBytes) &&
        result.ciphertextBytes === result.ciphertext.byteLength
      );
    case "decryptChunk":
      return (
        isObject(result) &&
        result.plaintext instanceof ArrayBuffer &&
        Number.isSafeInteger(result.plaintextBytes) &&
        (result.plaintextBytes as number) >= 0 &&
        (result.plaintextBytes as number) <= result.plaintext.byteLength
      );
    case "startDecryption":
      return (
        isObject(result) &&
        typeof result.sessionId === "string" &&
        isObject(result.manifest)
      );
    case "openPlan":
      return isObject(result) && isObject(result.manifest);
    case "finalizeEncryption":
      return (
        isObject(result) &&
        typeof result.nodeId === "string" &&
        isObject(result.record)
      );
    case "setup":
    case "recover":
      return (
        isObject(result) &&
        isObject(result.payload) &&
        typeof result.recoveryCode === "string"
      );
    case "rewrapPassword":
      return isObject(result) && isObject(result.payload);
    case "unlock":
      return (
        isObject(result) &&
        Number.isSafeInteger(result.vaultVersion) &&
        typeof result.identityFingerprint === "string"
      );
    case "resume":
      return (
        isObject(result) &&
        (result.resumed === false ||
          (result.resumed === true && typeof result.expiresAt === "number"))
      );
    case "createShareMaterial":
    case "rotateShareMaterial":
      return (
        isObject(result) &&
        Array.isArray(result.wrappers) &&
        Array.isArray(result.envelopes) &&
        isObject(result.ownerEpochKey)
      );
    case "createShareDirectory":
      return (
        isObject(result) &&
        result.directoryCbor instanceof Uint8Array &&
        result.directorySignature instanceof Uint8Array &&
        Array.isArray(result.wrappers)
      );
    default:
      return true;
  }
}

function createShareMaterialCollector(
  nodes: VaultShareMaterialInput["nodes"],
  {
    onProgress,
  }: {
    onProgress?(progress: VaultShareMaterialProgress): void;
  },
): {
  accept(progress: VaultWorkerProgress): void;
  finish(material: VaultShareMaterialResult): VaultShareMaterialResult;
} {
  const expectedWrappers = new Map(
    nodes.map((node) => [node.nodeId, node.entryType === "file" ? 2 : 1]),
  );
  const chunks = new Map<string, Uint8Array[]>();
  let completedNodes = 0;
  let failure: Error | null = null;

  return {
    accept(progress) {
      if (progress.type !== "shareMaterial" || failure) return;
      const expectedCount = expectedWrappers.get(progress.nodeId);
      if (
        expectedCount === undefined ||
        chunks.has(progress.nodeId) ||
        progress.wrappers.length !== expectedCount ||
        progress.totalNodes !== nodes.length ||
        progress.completedNodes !== completedNodes + 1
      ) {
        failure = new Error(
          "The vault worker returned invalid share-preparation progress.",
        );
        throw failure;
      }
      chunks.set(progress.nodeId, progress.wrappers);
      completedNodes = progress.completedNodes;
      onProgress?.({
        completedNodes: progress.completedNodes,
        totalNodes: progress.totalNodes,
      });
    },
    finish(material) {
      if (failure) throw failure;
      if (
        material.wrappers.length !== 0 ||
        completedNodes !== nodes.length ||
        chunks.size !== nodes.length
      ) {
        throw new Error(
          "The vault worker returned incomplete share-preparation material.",
        );
      }
      const wrappers = [...chunks]
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([, chunk]) => chunk);
      const expectedCount = [...expectedWrappers.values()].reduce(
        (sum, count) => sum + count,
        0,
      );
      if (wrappers.length !== expectedCount) {
        throw new Error(
          "The vault worker returned an invalid share wrapper count.",
        );
      }
      return { ...material, wrappers };
    },
  };
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
