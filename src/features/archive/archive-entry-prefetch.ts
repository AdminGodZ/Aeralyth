import {
  type OpenedEncryptedEntry,
  prefetchEncryptedEntries,
} from "@/features/archive/encrypted-entry-prefetch";
import {
  VAULT_CRYPTO_CHUNK_BYTES,
  type VaultDownloadPlan,
  type VaultManifest,
} from "@/features/vault/protocol";
import { abortReason } from "@/lib/abort";

const CANCEL_MESSAGE = "The archive download was canceled.";

/**
 * Content requests open at once, counting the one the ZIP writer is reading.
 * Storage speaks HTTP/1.1, where a browser opens at most six connections per
 * host; five leave one for everything else on the page.
 */
export const MAX_ARCHIVE_CONTENT_REQUESTS = 5;
/** Content buffered for files the ZIP writer has not reached yet. */
export const MAX_ARCHIVE_LOOKAHEAD_BYTES = 64 * 1024 * 1024;
/**
 * Entries prepared ahead of the one being archived. Download plans are
 * requested as entries enter this window, which also bounds plan requests.
 */
export const ARCHIVE_ENTRY_LOOKAHEAD = 8;
/** Files up to one crypto chunk are read whole; larger ones keep one chunk. */
const MAX_ARCHIVE_ENTRY_LOOKAHEAD_BYTES = VAULT_CRYPTO_CHUNK_BYTES;

type ArchiveEntry = {
  id: string;
  entryType: "file" | "folder";
  e2eeState: string;
  sizeBytes: number;
};

export type PreparedArchiveEntry = {
  /** Resolves to the decrypted manifest and plan of an encrypted entry. */
  opening: Promise<OpenedEncryptedEntry> | undefined;
  /** Resolves to a file's content, already requested; null for folders. */
  source: Promise<ReadableStream<Uint8Array>> | null;
};

export type ArchiveEntryPrefetch = {
  take(index: number): PreparedArchiveEntry;
  close(reason?: unknown): Promise<void>;
};

/**
 * Opens the next files' content while the ZIP writer archives the current
 * one, so each small file no longer waits a storage round trip and a
 * decryption-session setup in turn. Entries must be taken in order. Up to
 * `maxRequests` content streams are open at once and at most
 * `maxBufferedBytes` are held for files not taken yet: a small file is read
 * whole, which ends its request, and a larger one stops after its first chunk
 * until the writer reaches it. A failure surfaces when its entry is taken.
 * `close` stops every request still open and discards buffered content.
 */
export function prefetchArchiveEntries<T extends ArchiveEntry>(
  entries: readonly T[],
  {
    getPlan,
    openNode,
    openSource,
    signal,
    lookahead = ARCHIVE_ENTRY_LOOKAHEAD,
    maxRequests = MAX_ARCHIVE_CONTENT_REQUESTS,
    maxBufferedBytes = MAX_ARCHIVE_LOOKAHEAD_BYTES,
  }: {
    getPlan(nodeId: string, signal?: AbortSignal): Promise<VaultDownloadPlan>;
    openNode(
      nodeId: string,
      plan: VaultDownloadPlan,
      signal?: AbortSignal,
    ): Promise<VaultManifest>;
    openSource(
      entry: T,
      encrypted: OpenedEncryptedEntry | undefined,
      signal: AbortSignal,
    ): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
    signal?: AbortSignal;
    lookahead?: number;
    maxRequests?: number;
    maxBufferedBytes?: number;
  },
): ArchiveEntryPrefetch {
  const operation = new AbortController();
  const abortFromParent = () => operation.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });

  // Plans are requested only as entries enter this window.
  const openEncryptedEntry = prefetchEncryptedEntries(entries, {
    getPlan,
    openNode,
    lookahead: 0,
    signal: operation.signal,
  });
  const prepared = new Map<
    number,
    {
      opening: Promise<OpenedEncryptedEntry> | undefined;
      source: PrefetchedSource | null;
      reservedBytes: number;
    }
  >();
  const sources = new Set<PrefetchedSource>();
  let next = 0;
  let current = -1;
  let requests = 0;
  let bufferedBytes = 0;
  let canceled = false;

  const fill = () => {
    while (!canceled && next < entries.length && next <= current + lookahead) {
      const index = next;
      const entry = entries[index];
      const reservedBytes =
        entry.entryType === "file"
          ? Math.min(entry.sizeBytes, MAX_ARCHIVE_ENTRY_LOOKAHEAD_BYTES)
          : 0;
      // The entry being archived opens regardless; it is what frees the rest.
      if (
        entry.entryType === "file" &&
        index > current &&
        (requests >= maxRequests ||
          bufferedBytes + reservedBytes > maxBufferedBytes)
      ) {
        return;
      }
      next += 1;
      const opening = openEncryptedEntry(index);
      if (entry.entryType !== "file") {
        prepared.set(index, { opening, source: null, reservedBytes });
        continue;
      }
      requests += 1;
      bufferedBytes += reservedBytes;
      const source = new PrefetchedSource(
        (async () => {
          const encrypted = await opening;
          const stream = await openSource(entry, encrypted, operation.signal);
          const sizeBytes =
            encrypted?.manifest.plaintextBytes ?? entry.sizeBytes;
          return {
            stream,
            readWhole: sizeBytes <= MAX_ARCHIVE_ENTRY_LOOKAHEAD_BYTES,
          };
        })(),
        () => {
          requests -= 1;
          fill();
        },
        () => sources.delete(source),
      );
      sources.add(source);
      prepared.set(index, { opening, source, reservedBytes });
    }
  };

  return {
    take(index) {
      if (index !== current + 1) {
        throw new Error("Archive entries must be taken in order.");
      }
      current = index;
      fill();
      const entry = prepared.get(index);
      prepared.delete(index);
      // Only a canceled prefetch has no entry left to take.
      if (!entry) throw abortReason(operation.signal, CANCEL_MESSAGE);
      bufferedBytes -= entry.reservedBytes;
      fill();
      const source = entry.source?.take() ?? null;
      // A source the writer never reaches, after an earlier failure, must
      // not report an unhandled rejection.
      source?.catch(() => undefined);
      return { opening: entry.opening, source };
    },
    async close(reason) {
      canceled = true;
      signal?.removeEventListener("abort", abortFromParent);
      operation.abort(reason);
      prepared.clear();
      await Promise.all([...sources].map((source) => source.cancel(reason)));
    },
  };
}

/**
 * One file's content stream, opened ahead of the ZIP writer. `onSettle` runs
 * once its request ends; `onDispose` once nothing of it remains buffered.
 */
class PrefetchedSource {
  private readonly chunks: Uint8Array[] = [];
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private complete = false;
  private settled = false;
  private canceled = false;
  private cancelReason: unknown;
  private readonly ready: Promise<void>;

  constructor(
    opening: Promise<{
      stream: ReadableStream<Uint8Array>;
      readWhole: boolean;
    }>,
    private readonly onSettle: () => void,
    private readonly onDispose: () => void,
  ) {
    this.ready = this.prefetch(opening);
    this.ready.catch(() => {
      this.settle();
      this.release();
    });
  }

  async take(): Promise<ReadableStream<Uint8Array>> {
    await this.ready;
    const reader = this.reader as ReadableStreamDefaultReader<Uint8Array>;
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          const chunk = this.chunks.shift();
          if (chunk) {
            controller.enqueue(chunk);
            return;
          }
          if (this.complete) {
            this.release();
            controller.close();
            return;
          }
          try {
            const result = await reader.read();
            // A canceled reader reports done; the content is not complete.
            if (this.canceled) throw this.cancelReason;
            if (result.done) {
              this.settle();
              this.release();
              controller.close();
            } else {
              controller.enqueue(result.value);
            }
          } catch (error) {
            this.settle();
            this.release();
            throw error;
          }
        },
        cancel: (reason) => this.cancel(reason),
      },
      { highWaterMark: 0 },
    );
  }

  async cancel(reason: unknown): Promise<void> {
    if (!this.canceled) {
      this.canceled = true;
      this.cancelReason =
        reason ?? new DOMException(CANCEL_MESSAGE, "AbortError");
    }
    await Promise.all([
      this.reader?.cancel(reason).catch(() => undefined),
      this.ready.catch(() => undefined),
    ]);
    this.settle();
    this.release();
  }

  private async prefetch(
    opening: Promise<{
      stream: ReadableStream<Uint8Array>;
      readWhole: boolean;
    }>,
  ): Promise<void> {
    const { stream, readWhole } = await opening;
    this.reader = stream.getReader();
    if (this.canceled) {
      await this.reader.cancel(this.cancelReason).catch(() => undefined);
      throw this.cancelReason;
    }
    if (!readWhole) return;
    let bytes = 0;
    // Read to the end, unless the file turns out larger than announced.
    while (bytes <= MAX_ARCHIVE_ENTRY_LOOKAHEAD_BYTES) {
      const result = await this.reader.read();
      if (this.canceled) throw this.cancelReason;
      if (result.done) {
        this.complete = true;
        this.settle();
        return;
      }
      this.chunks.push(result.value);
      bytes += result.value.byteLength;
    }
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.onSettle();
  }

  private release(): void {
    for (const chunk of this.chunks.splice(0)) chunk.fill(0);
    this.onDispose();
  }
}
