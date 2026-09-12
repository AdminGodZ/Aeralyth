import { ExactStreamReader } from "@/features/vault/buffered-bytes";
import type { VaultDownloadPlan } from "@/features/vault/protocol";
import { getVaultDownloadPlan } from "@/features/vault/vault-api";

export const DOWNLOAD_STALL_TIMEOUT_MS = 30_000;
export const MAX_DOWNLOAD_RECOVERIES = 3;

class RecoverableDownloadError extends Error {}

/** Keeps completed chunks in the crypto session and retries only incomplete reads. */
export class ResumableDownload {
  private reader: ExactStreamReader | null = null;
  private request: AbortController | null = null;
  private offset = 0;
  private recoveries = 0;
  private etag: string | null = null;
  private readonly operation = new AbortController();
  private readonly abortFromParent = () =>
    this.operation.abort(this.signal?.reason);

  constructor(
    private readonly plan: VaultDownloadPlan,
    private readonly endExclusive: number,
    private readonly signal?: AbortSignal,
    private readonly onBytes?: (bytes: number) => void,
  ) {
    if (signal?.aborted) this.abortFromParent();
    else
      signal?.addEventListener("abort", this.abortFromParent, { once: true });
  }

  async open(): Promise<void> {
    await this.retry(async () => undefined);
  }

  async readChunk(length: number): Promise<Uint8Array<ArrayBuffer>> {
    return this.retry(async () => {
      if (!this.reader)
        throw new Error("The download response is unavailable.");
      const chunk = await this.reader.readExactly(length);
      if (!chunk) {
        throw new RecoverableDownloadError(
          "The encrypted download ended before all chunks arrived.",
        );
      }
      this.offset += length;
      return chunk;
    });
  }

  async finish(): Promise<void> {
    if (this.offset !== this.endExclusive || !this.reader) {
      throw new Error("The encrypted download is incomplete.");
    }
    try {
      if (!(await this.reader.isAtEnd())) {
        throw new Error(
          "The encrypted download contains unexpected trailing data.",
        );
      }
    } catch (error) {
      this.operation.signal.throwIfAborted();
      // Every byte in the signed ciphertext length is already present. A lost
      // EOF notification cannot invalidate those bytes; the caller still must
      // authenticate the final chunk and verify the complete Merkle root.
      if (!isRecoverable(error)) throw error;
    }
  }

  async cancel(reason?: unknown): Promise<void> {
    this.operation.abort(reason);
    this.signal?.removeEventListener("abort", this.abortFromParent);
    await this.closeResponse();
  }

  private async retry<T>(action: () => Promise<T>): Promise<T> {
    while (true) {
      this.operation.signal.throwIfAborted();
      try {
        if (!this.reader) {
          let currentPlan = this.plan;
          if (this.recoveries > 0) {
            // Renewal rechecks current authorization without changing the
            // immutable content authenticated by the existing worker session.
            const renewal = new AbortController();
            const abort = () => renewal.abort(this.operation.signal.reason);
            this.operation.signal.addEventListener("abort", abort, {
              once: true,
            });
            try {
              currentPlan = await waitForProgress(
                () => getVaultDownloadPlan(this.plan.nodeId, renewal.signal),
                renewal.signal,
                () =>
                  renewal.abort(
                    new RecoverableDownloadError("The download stalled."),
                  ),
              );
            } finally {
              this.operation.signal.removeEventListener("abort", abort);
            }
            assertSameGeneration(this.plan, currentPlan);
          }
          await this.openResponse(currentPlan, this.recoveries > 0);
        }
        return await action();
      } catch (error) {
        this.operation.signal.throwIfAborted();
        if (
          !isRecoverable(error) ||
          this.recoveries >= MAX_DOWNLOAD_RECOVERIES
        ) {
          throw error;
        }
        await this.closeResponse();
        this.recoveries += 1;
        await delay(
          Math.min(2_000, 200 * 2 ** (this.recoveries - 1)) *
            (0.75 + Math.random() * 0.5),
          this.operation.signal,
        );
      }
    }
  }

  private async openResponse(
    plan: VaultDownloadPlan,
    recovering = false,
  ): Promise<void> {
    if (!plan.downloadUrl) throw new Error("The download URL is unavailable.");
    this.operation.signal.throwIfAborted();
    const request = new AbortController();
    this.request = request;
    const abort = () => request.abort(this.operation.signal.reason);
    this.operation.signal.addEventListener("abort", abort, { once: true });
    const range = recovering || this.endExclusive < this.plan.ciphertextLength;
    let response: Response | null = null;
    try {
      response = await waitForProgress(
        () =>
          fetch(plan.downloadUrl as string, {
            signal: request.signal,
            cache: "no-store",
            ...(range
              ? {
                  headers: {
                    Range: `bytes=${this.offset}-${this.endExclusive - 1}`,
                  },
                }
              : {}),
          }),
        request.signal,
        () =>
          request.abort(new RecoverableDownloadError("The download stalled.")),
      );
      if (
        [401, 403, 408, 429].includes(response.status) ||
        response.status >= 500
      ) {
        throw new RecoverableDownloadError(
          `Encrypted download failed with status ${response.status}.`,
        );
      }
      if (!response.ok || !response.body) {
        throw new Error(
          `Encrypted download failed with status ${response.status}.`,
        );
      }
      if (range) {
        const expected = `bytes ${this.offset}-${this.endExclusive - 1}/${this.plan.ciphertextLength}`;
        if (
          response.status !== 206 ||
          response.headers.get("Content-Range") !== expected
        ) {
          throw new Error(
            "The encrypted download returned an invalid byte range.",
          );
        }
      } else if (response.status !== 200) {
        throw new Error(
          "The encrypted download returned an unexpected partial response.",
        );
      }
      const length = response.headers.get("Content-Length");
      if (
        length !== null &&
        Number(length) !== this.endExclusive - this.offset
      ) {
        throw new Error(
          "The encrypted download returned an invalid content length.",
        );
      }
      const etag = response.headers.get("ETag");
      if (this.etag !== null && etag !== this.etag) {
        throw new Error("The encrypted object changed during the download.");
      }
      this.etag = etag;
      const raw = response.body.getReader();
      this.reader = new ExactStreamReader({
        read: () =>
          waitForProgress(
            async () => {
              while (true) {
                const result = await raw.read();
                if (result.done) return result;
                if (result.value.byteLength === 0) continue;
                this.onBytes?.(result.value.byteLength);
                return result;
              }
            },
            request.signal,
            () =>
              request.abort(
                new RecoverableDownloadError("The download stalled."),
              ),
          ),
        cancel: async () => {
          this.operation.signal.removeEventListener("abort", abort);
          await raw.cancel().catch(() => undefined);
        },
      });
    } catch (error) {
      this.operation.signal.removeEventListener("abort", abort);
      request.abort(error);
      await response?.body?.cancel(error).catch(() => undefined);
      throw error;
    }
  }

  private async closeResponse(): Promise<void> {
    this.request?.abort();
    this.request = null;
    const reader = this.reader;
    this.reader = null;
    await reader?.cancel();
  }
}

function assertSameGeneration(
  original: VaultDownloadPlan,
  renewed: VaultDownloadPlan,
): void {
  const fields = [
    "nodeId",
    "entryType",
    "generationNumber",
    "generationId",
    "ciphertextLength",
    "cryptoChunkBytes",
    "chunkCount",
    "ciphertextMerkleRoot",
  ] as const;
  if (fields.some((field) => original[field] !== renewed[field])) {
    throw new Error(
      "The encrypted file generation changed during the download.",
    );
  }
}

function isRecoverable(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof RecoverableDownloadError ||
    (error instanceof Error &&
      "status" in error &&
      typeof error.status === "number" &&
      (error.status === 408 || error.status === 429 || error.status >= 500))
  );
}

async function waitForProgress<T>(
  action: () => Promise<T>,
  signal: AbortSignal,
  onStall?: () => void,
): Promise<T> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => {
          const error = new RecoverableDownloadError("The download stalled.");
          reject(error);
          onStall?.();
        }, DOWNLOAD_STALL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
