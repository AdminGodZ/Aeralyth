// The units of work of the folder ZIP worker. A task depends only on its own
// input, so it can run in any helper worker (or inline), in any order, and can
// be repeated if a helper dies.
import { crc32 } from "@/features/archive/crc32";
import {
  nativeDeflateRaw,
  type RawDeflater,
  storedDeflateBlocks,
  storedDeflateSize,
} from "@/features/archive/raw-deflate";
import {
  encodeZipEntryName,
  localFileHeaderSize,
  writeLocalFileHeader,
  ZIP_METHOD_DEFLATE,
  ZIP_METHOD_STORE,
  type ZipCompressionMethod,
} from "@/features/archive/zip-container";

export type FolderZipBatchEntry = {
  /** Entry path as stored in the archive; directories end with "/". */
  path: string;
  directory: boolean;
  file: Blob | null;
  size: number;
  lastModified: number;
  level: number;
};

export type FolderZipTask =
  | {
      kind: "batch";
      id: number;
      entries: FolderZipBatchEntry[];
      /** Stored entries at least this large are not copied into the segment. */
      referenceBytes: number;
    }
  | {
      kind: "range";
      id: number;
      path: string;
      file: Blob;
      start: number;
      end: number;
      /** Zero only checksums the range. */
      level: number;
      final: boolean;
    }
  | {
      kind: "stream";
      id: number;
      path: string;
      file: Blob;
    };

/** Numbers per batch entry in `meta`: CRC-32, compressed size, flags, header offset, header size. */
export const FOLDER_ZIP_BATCH_META_FIELDS = 5;
/** Flag set next to the compression method when the entry's data is not in the segment. */
export const FOLDER_ZIP_BATCH_REFERENCE = 0x100;

export type FolderZipTaskResult =
  | {
      kind: "batch";
      id: number;
      /** Local file headers, each followed by the entry's data unless referenced. */
      segment: ArrayBuffer;
      meta: Uint32Array;
    }
  | {
      kind: "range";
      id: number;
      crc32: number;
      /** Raw deflate data of the range, or null for a stored range. */
      output: ArrayBuffer | null;
    }
  | {
      kind: "stream";
      id: number;
      crc32: number;
    };

export type FolderZipHelperRequest =
  | {
      type: "helper-init";
      wasm: ArrayBuffer | null;
      nativeDeflate: boolean;
    }
  | {
      type: "helper-task";
      task: FolderZipTask;
    };

export type FolderZipHelperResponse =
  | { type: "helper-ready" }
  | { type: "helper-failed"; message: string }
  | { type: "helper-part"; id: number; part: ArrayBuffer }
  | { type: "helper-result"; result: FolderZipTaskResult }
  | { type: "helper-error"; id: number; message: string };

export type FolderZipTaskContext = {
  /** Synchronous zlib, or null when the module could not be loaded. */
  deflater: RawDeflater | null;
  /** Whether CompressionStream may be used when `deflater` is null. */
  nativeDeflate: boolean;
  /** Receives the deflate data of a stream task piece by piece, in order. */
  emitPart(id: number, part: ArrayBuffer): void;
  signal?: AbortSignal;
};

// Deflating data that does not compress costs about twenty times more than
// checksumming it, so larger inputs are sampled first.
const SAMPLE_MINIMUM_INPUT_BYTES = 512 * 1024;
const SAMPLE_BYTES = 16 * 1024;
const SAMPLE_INCOMPRESSIBLE_BYTES = Math.floor(SAMPLE_BYTES * 0.97);
const STREAM_PART_BYTES = 1024 * 1024;
const BATCH_READ_CONCURRENCY = 32;
const EMPTY = new Uint8Array(0);

export async function runFolderZipTask(
  task: FolderZipTask,
  context: FolderZipTaskContext,
): Promise<{ result: FolderZipTaskResult; transfer: ArrayBuffer[] }> {
  if (task.kind === "batch") return runBatchTask(task, context);
  if (task.kind === "range") return runRangeTask(task, context);
  return {
    result: {
      kind: "stream",
      id: task.id,
      crc32: await runStreamTask(task, context),
    },
    transfer: [],
  };
}

async function runBatchTask(
  task: Extract<FolderZipTask, { kind: "batch" }>,
  { deflater, nativeDeflate }: FolderZipTaskContext,
): Promise<{ result: FolderZipTaskResult; transfer: ArrayBuffer[] }> {
  const { entries } = task;
  const names = entries.map((entry) => encodeZipEntryName(entry.path));
  let capacity = 0;
  for (const [index, entry] of entries.entries()) {
    capacity +=
      localFileHeaderSize(names[index].length, entry.lastModified) + entry.size;
  }
  const segment = new Uint8Array(capacity);
  const meta = new Uint32Array(entries.length * FOLDER_ZIP_BATCH_META_FIELDS);
  const sources = await readBatch(entries);

  let position = 0;
  for (const [index, entry] of entries.entries()) {
    const input = sources[index];

    let method: ZipCompressionMethod = ZIP_METHOD_STORE;
    let data: Uint8Array = input;
    if (entry.level > 0 && input.length > 0) {
      if (deflater) {
        if (!looksIncompressible(input, deflater)) {
          const deflated = deflater.deflateRaw(input, entry.level, true);
          if (deflated.length < input.length) data = deflated;
        }
      } else if (nativeDeflate) {
        const deflated = await nativeDeflateRaw(input);
        if (deflated.length < input.length) data = deflated;
        else releaseBuffer(deflated.buffer);
      }
      if (data !== input) method = ZIP_METHOD_DEFLATE;
    }
    const reference =
      method === ZIP_METHOD_STORE && input.length >= task.referenceBytes;
    const checksum = input.length > 0 ? crc32(input) : 0;
    const headerSize = writeLocalFileHeader(segment, position, {
      name: names[index],
      directory: entry.directory,
      method,
      level: entry.level,
      crc32: checksum,
      compressedSize: data.length,
      uncompressedSize: input.length,
      lastModified: entry.lastModified,
    });
    meta.set(
      [
        checksum,
        data.length,
        method | (reference ? FOLDER_ZIP_BATCH_REFERENCE : 0),
        position,
        headerSize,
      ],
      index * FOLDER_ZIP_BATCH_META_FIELDS,
    );
    position += headerSize;
    if (!reference) {
      segment.set(data, position);
      position += data.length;
    }
    // Entries without data share one empty buffer, which must stay usable.
    if (input.length > 0) releaseBuffer(input.buffer);
    // Native deflate output is a buffer of its own; zlib output is a view of
    // the deflater's reused scratch buffer.
    if (!deflater && data !== input) releaseBuffer(data.buffer as ArrayBuffer);
  }

  const output = shrinkBuffer(segment.buffer, position);
  return {
    result: { kind: "batch", id: task.id, segment: output, meta },
    transfer: [output, meta.buffer as ArrayBuffer],
  };
}

async function runRangeTask(
  task: Extract<FolderZipTask, { kind: "range" }>,
  { deflater }: FolderZipTaskContext,
): Promise<{ result: FolderZipTaskResult; transfer: ArrayBuffer[] }> {
  let input: Uint8Array<ArrayBuffer>;
  try {
    input = new Uint8Array(
      await task.file.slice(task.start, task.end).arrayBuffer(),
    );
  } catch (error) {
    throw readFailure(task.path, error);
  }
  if (input.length !== task.end - task.start) {
    throw readFailure(task.path, new Error("The file changed size."));
  }
  const checksum = crc32(input);
  if (task.level === 0) {
    releaseBuffer(input.buffer);
    return {
      result: { kind: "range", id: task.id, crc32: checksum, output: null },
      transfer: [],
    };
  }
  if (!deflater) {
    throw new Error("A ZIP range cannot be deflated without the zlib module.");
  }

  let output: Uint8Array<ArrayBuffer> | null = null;
  if (!looksIncompressible(input, deflater)) {
    const deflated = deflater.deflateRaw(input, task.level, task.final);
    if (deflated.length < storedDeflateSize(input.length, task.final)) {
      output = deflated.slice();
    }
  }
  output ??= storedDeflateBlocks(input, task.final);
  releaseBuffer(input.buffer);
  return {
    result: {
      kind: "range",
      id: task.id,
      crc32: checksum,
      output: output.buffer,
    },
    transfer: [output.buffer],
  };
}

/** Deflates a whole file with CompressionStream and returns its CRC-32. */
async function runStreamTask(
  task: Extract<FolderZipTask, { kind: "stream" }>,
  { emitPart, signal }: FolderZipTaskContext,
): Promise<number> {
  const compressor = new CompressionStream("deflate-raw");
  const writer = compressor.writable.getWriter();
  const reader = compressor.readable.getReader();
  let checksum = 0;

  const feed = async () => {
    const source = task.file.stream().getReader();
    try {
      for (;;) {
        signal?.throwIfAborted();
        const { value, done } = await source.read();
        if (done) break;
        checksum = crc32(value, checksum);
        await writer.write(value);
        // The compressor has consumed the chunk once the write settles.
        releaseBuffer(value.buffer as ArrayBuffer);
      }
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => undefined);
      await source.cancel(error).catch(() => undefined);
      throw signal?.aborted ? error : readFailure(task.path, error);
    }
  };
  const drain = async () => {
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const flush = () => {
      if (pendingBytes === 0) return;
      const part = new Uint8Array(pendingBytes);
      let offset = 0;
      for (const chunk of pending) {
        part.set(chunk, offset);
        offset += chunk.length;
      }
      pending = [];
      pendingBytes = 0;
      emitPart(task.id, part.buffer);
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending.push(value);
      pendingBytes += value.length;
      if (pendingBytes >= STREAM_PART_BYTES) flush();
    }
    flush();
  };
  await Promise.all([feed(), drain()]);
  return checksum;
}

/**
 * Reads every file of a batch, a few at a time. Many small disk-backed files
 * are limited by how fast the browser serves them, not by compression, and
 * overlapping the reads is measurably faster than one combined read.
 */
async function readBatch(
  entries: readonly FolderZipBatchEntry[],
): Promise<Uint8Array<ArrayBuffer>[]> {
  const sources = entries.map(() => EMPTY);
  let next = 0;
  const readNext = async () => {
    while (next < entries.length) {
      const index = next++;
      const { file, size, path } = entries[index];
      if (!file || size === 0) continue;
      let buffer: ArrayBuffer;
      try {
        buffer = await file.arrayBuffer();
      } catch (error) {
        throw readFailure(path, error);
      }
      if (buffer.byteLength !== size) {
        throw readFailure(path, new Error("The file changed size."));
      }
      sources[index] = new Uint8Array(buffer);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(BATCH_READ_CONCURRENCY, entries.length) },
      readNext,
    ),
  );
  return sources;
}

type ResizableBuffer = ArrayBuffer & {
  transfer?(length?: number): ArrayBuffer;
};

/**
 * Frees a buffer's memory now instead of at the next garbage collection.
 * Workers allocate a few megabytes per task, and that garbage would otherwise
 * pile up in every helper until its collector runs.
 */
export function releaseBuffer(buffer: ArrayBuffer): void {
  (buffer as ResizableBuffer).transfer?.(0);
}

/** Returns the first `length` bytes of `buffer`, which is consumed. */
function shrinkBuffer(buffer: ArrayBuffer, length: number): ArrayBuffer {
  if (length === buffer.byteLength) return buffer;
  return (
    (buffer as ResizableBuffer).transfer?.(length) ?? buffer.slice(0, length)
  );
}

function readFailure(path: string, error: unknown): Error {
  const reason = error instanceof Error && error.message ? error.message : "";
  return new Error(
    `"${path}" could not be read${reason ? `: ${reason}` : "."}`,
    { cause: error },
  );
}

function looksIncompressible(
  input: Uint8Array,
  deflater: RawDeflater,
): boolean {
  if (input.length < SAMPLE_MINIMUM_INPUT_BYTES) return false;
  for (const third of [1, 2]) {
    const start = Math.floor((input.length * third) / 3) - SAMPLE_BYTES / 2;
    const sample = input.subarray(start, start + SAMPLE_BYTES);
    if (
      deflater.deflateRaw(sample, 1, true).length < SAMPLE_INCOMPRESSIBLE_BYTES
    ) {
      return false;
    }
  }
  return true;
}
