import {
  publishVaultInlineUploads,
  VaultApiError,
  type VaultInlineUploadResult,
  type VaultPublishResponse,
} from "@/features/vault/vault-api";
import {
  type InlineUploadEntry,
  VAULT_INLINE_UPLOAD_MAX_BYTES,
} from "@/features/vault/vault-wire";
import { abortReason } from "@/lib/abort";

const ABORT_MESSAGE = "Upload canceled";

export const INLINE_BATCH_MAX_FILES = 32;
export const INLINE_BATCH_MAX_BYTES = 4 * 1024 * 1024;
const INLINE_BATCH_MIN_BYTES = 256 * 1024;
const INLINE_BATCH_INITIAL_BYTES = 1024 * 1024;
// Long enough for the files prepared together to share a request, short enough
// that the first one leaves almost immediately.
const INLINE_BATCH_LINGER_MS = 6;
// A batch that takes this long is outrunning the uplink: halve the next one so
// the request stays well inside the server's body deadline.
const INLINE_BATCH_SLOW_MS = 6_000;
const INLINE_BATCH_FAST_MS = 1_500;
const INLINE_ITEM_ATTEMPTS = 6;
const INLINE_ITEM_RETRY_BASE_MS = 200;
const INLINE_ITEM_RETRY_MAX_MS = 2_000;
// Responses that mean the API processed none of the batch: a route missing
// during a rollout, a body an intermediary refuses, or a batch it cannot
// decode. The client-driven upload path still takes every file. Any other
// failed request may have published some of its files, so it stays an error.
const UNAVAILABLE_STATUSES = new Set([400, 404, 405, 413, 415, 501]);
// A file the API rejected as malformed or could not store was not published
// and gets one more chance on the client-driven path, which reports its own
// error if the file really is bad.
const ITEM_FALLBACK_STATUSES = new Set([400, 502]);
// Batches in a row in which the API could store nothing: the provider is not
// taking server-side writes, so the lane stops costing every file an attempt.
const INLINE_FAILED_BATCHES_BEFORE_CLOSING = 2;

export class InlineUploadsUnavailableError extends Error {
  constructor() {
    super("Inline uploads are unavailable.");
    this.name = "InlineUploadsUnavailableError";
  }
}

type PendingUpload = {
  entry: InlineUploadEntry;
  attempts: number;
  resolve(published: VaultPublishResponse): void;
  reject(error: unknown): void;
};

/**
 * Coalesces small encrypted files into batch requests. A file waits at most a
 * few milliseconds for company, batches run side by side up to the caller's
 * limit, and a file the server sheds for capacity is retried on its own.
 */
export class InlineUploadLane {
  private readonly queue: PendingUpload[] = [];
  private queuedBytes = 0;
  private queuedSince = 0;
  private activeRequests = 0;
  private targetBytes = INLINE_BATCH_INITIAL_BYTES;
  private lingerTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly retries = new Map<
    ReturnType<typeof setTimeout>,
    PendingUpload
  >();
  private unavailable = false;
  private failedBatches = 0;

  constructor(
    private readonly options: {
      csrfToken: string;
      signal: AbortSignal;
      maxRequests(): number;
      publish?: typeof publishVaultInlineUploads;
      now?: () => number;
    },
  ) {
    options.signal.addEventListener("abort", () => this.abort(), {
      once: true,
    });
  }

  /** False once the API turned out not to accept inline uploads. */
  get available(): boolean {
    return !this.unavailable;
  }

  submit(entry: InlineUploadEntry): Promise<VaultPublishResponse> {
    const { signal } = this.options;
    if (signal.aborted) {
      entry.content.fill(0);
      return Promise.reject(abortReason(signal, ABORT_MESSAGE));
    }
    if (
      this.unavailable ||
      entry.content.length > VAULT_INLINE_UPLOAD_MAX_BYTES
    ) {
      entry.content.fill(0);
      return Promise.reject(new InlineUploadsUnavailableError());
    }
    return new Promise((resolve, reject) => {
      this.enqueue({ entry, attempts: 0, resolve, reject });
    });
  }

  /** Re-evaluates the queue after the caller's request limit changed. */
  poke(): void {
    this.schedule();
  }

  private enqueue(pending: PendingUpload): void {
    if (this.unavailable) {
      // The lane closed while this file waited out a capacity retry.
      this.settle(pending, () =>
        pending.reject(new InlineUploadsUnavailableError()),
      );
      return;
    }
    if (this.queue.length === 0) this.queuedSince = this.now();
    this.queue.push(pending);
    this.queuedBytes += pending.entry.content.length;
    this.schedule();
  }

  private schedule(): void {
    while (
      this.queue.length > 0 &&
      this.activeRequests < Math.max(1, this.options.maxRequests())
    ) {
      const full =
        this.queue.length >= INLINE_BATCH_MAX_FILES ||
        this.queuedBytes >= this.targetBytes;
      const waited = this.now() - this.queuedSince;
      if (!full && waited < INLINE_BATCH_LINGER_MS) {
        this.lingerTimer ??= setTimeout(() => {
          this.lingerTimer = undefined;
          this.schedule();
        }, INLINE_BATCH_LINGER_MS - waited);
        return;
      }
      void this.dispatch(this.takeBatch());
    }
  }

  private takeBatch(): PendingUpload[] {
    const batch: PendingUpload[] = [];
    let bytes = 0;
    while (this.queue.length > 0 && batch.length < INLINE_BATCH_MAX_FILES) {
      const next = this.queue[0].entry.content.length;
      if (batch.length > 0 && bytes + next > this.targetBytes) break;
      batch.push(this.queue.shift() as PendingUpload);
      bytes += next;
    }
    this.queuedBytes -= bytes;
    // Whatever stays behind starts a fresh, short wait for company.
    this.queuedSince = this.now();
    return batch;
  }

  private async dispatch(batch: PendingUpload[]): Promise<void> {
    this.activeRequests += 1;
    const started = this.now();
    let results: VaultInlineUploadResult[];
    try {
      const response = await (
        this.options.publish ?? publishVaultInlineUploads
      )(
        this.options.csrfToken,
        batch.map(({ entry }) => entry),
        this.options.signal,
      );
      results = response.results;
      if (!Array.isArray(results) || results.length !== batch.length) {
        throw new Error("The inline upload response is incomplete.");
      }
    } catch (error) {
      this.activeRequests -= 1;
      if (
        error instanceof VaultApiError &&
        UNAVAILABLE_STATUSES.has(error.status)
      ) {
        this.close(batch);
        return;
      }
      // The body outlasted the server's deadline on a slow uplink: send the
      // same files again in smaller requests.
      const timedOut = error instanceof VaultApiError && error.status === 408;
      if (timedOut) {
        this.targetBytes = Math.max(
          INLINE_BATCH_MIN_BYTES,
          this.targetBytes / 2,
        );
      }
      for (const pending of batch) {
        if (timedOut && pending.attempts + 1 < INLINE_ITEM_ATTEMPTS) {
          this.retry(pending);
        } else {
          this.settle(pending, () => pending.reject(error));
        }
      }
      this.schedule();
      return;
    }

    this.activeRequests -= 1;
    this.adapt(this.now() - started);
    const handedBack = results.filter(
      (result) =>
        !result?.published &&
        (!result?.failed || ITEM_FALLBACK_STATUSES.has(result.failed.status)),
    ).length;
    this.failedBatches =
      handedBack === batch.length ? this.failedBatches + 1 : 0;
    if (this.failedBatches >= INLINE_FAILED_BATCHES_BEFORE_CLOSING) {
      this.close(batch);
      return;
    }
    for (const [index, pending] of batch.entries()) {
      const result = results[index];
      if (result?.published) {
        const published = result.published;
        this.settle(pending, () => pending.resolve(published));
      } else if (
        result?.failed &&
        [429, 503].includes(result.failed.status) &&
        pending.attempts + 1 < INLINE_ITEM_ATTEMPTS
      ) {
        this.retry(pending);
      } else if (
        !result?.failed ||
        ITEM_FALLBACK_STATUSES.has(result.failed.status)
      ) {
        this.settle(pending, () =>
          pending.reject(new InlineUploadsUnavailableError()),
        );
      } else {
        const failure = new VaultApiError(
          result.failed.message || "The encrypted upload failed.",
          result.failed.status,
        );
        this.settle(pending, () => pending.reject(failure));
      }
    }
    this.schedule();
  }

  /** Hands every file the lane still holds back to the client-driven path. */
  private close(batch: PendingUpload[]): void {
    this.unavailable = true;
    const retrying = Array.from(this.retries, ([timer, pending]) => {
      clearTimeout(timer);
      return pending;
    });
    this.retries.clear();
    const unavailable = new InlineUploadsUnavailableError();
    for (const pending of [...batch, ...this.queue.splice(0), ...retrying]) {
      this.settle(pending, () => pending.reject(unavailable));
    }
    this.queuedBytes = 0;
  }

  private retry(pending: PendingUpload): void {
    const delay = Math.min(
      INLINE_ITEM_RETRY_MAX_MS,
      INLINE_ITEM_RETRY_BASE_MS * 2 ** pending.attempts,
    );
    pending.attempts += 1;
    const timer = setTimeout(() => {
      this.retries.delete(timer);
      this.enqueue(pending);
    }, delay);
    this.retries.set(timer, pending);
  }

  private adapt(elapsedMs: number): void {
    if (elapsedMs > INLINE_BATCH_SLOW_MS) {
      this.targetBytes = Math.max(INLINE_BATCH_MIN_BYTES, this.targetBytes / 2);
    } else if (elapsedMs < INLINE_BATCH_FAST_MS) {
      this.targetBytes = Math.min(INLINE_BATCH_MAX_BYTES, this.targetBytes * 2);
    }
  }

  private abort(): void {
    clearTimeout(this.lingerTimer);
    this.lingerTimer = undefined;
    const waiting = Array.from(this.retries, ([timer, pending]) => {
      clearTimeout(timer);
      return pending;
    });
    this.retries.clear();
    const reason = abortReason(this.options.signal, ABORT_MESSAGE);
    for (const pending of [...this.queue.splice(0), ...waiting]) {
      this.settle(pending, () => pending.reject(reason));
    }
    this.queuedBytes = 0;
  }

  private settle(pending: PendingUpload, complete: () => void): void {
    pending.entry.content.fill(0);
    complete();
  }

  private now(): number {
    return (this.options.now ?? performance.now.bind(performance))();
  }
}
