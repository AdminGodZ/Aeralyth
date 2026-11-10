// Synchronous raw deflate on top of the zlib WebAssembly module that zip.js
// ships (`@zip.js/zip.js/dist/zip-module.wasm`). Calling the module directly
// avoids one stream pipeline per entry. raw-deflate.test.ts pins the module's
// exports, so a zip.js upgrade that changes them fails the tests.

const Z_NO_FLUSH = 0;
const Z_SYNC_FLUSH = 2;
const Z_FINISH = 4;
const Z_STREAM_END = 1;
const Z_BUF_ERROR = -5;
// The module's memory is fixed at about 16 MiB, so input is fed in pieces.
const INPUT_BYTES = 256 * 1024;
const OUTPUT_BYTES = INPUT_BYTES + (INPUT_BYTES >>> 3) + 1024;
const STORED_BLOCK_BYTES = 0xffff;

type ZlibModuleExports = {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  deflate_new(): number;
  deflate_init_raw(stream: number, level: number): number;
  deflate_process(
    stream: number,
    input: number,
    inputLength: number,
    output: number,
    outputLength: number,
    flush: number,
  ): number;
  deflate_last_consumed(stream: number): number;
  deflate_end(stream: number): number;
};

const REQUIRED_FUNCTIONS = [
  "malloc",
  "deflate_new",
  "deflate_init_raw",
  "deflate_process",
  "deflate_last_consumed",
  "deflate_end",
] as const;

export type RawDeflater = {
  /**
   * Returns the raw deflate stream of `input`. A final stream ends the deflate
   * data; a non-final one ends byte-aligned with a sync flush so that further
   * raw deflate data can be appended. The result is a view of an internal
   * buffer that the next call overwrites.
   */
  deflateRaw(input: Uint8Array, level: number, final: boolean): Uint8Array;
};

export async function instantiateRawDeflater(
  wasm: BufferSource,
): Promise<RawDeflater> {
  const { instance } = await WebAssembly.instantiate(wasm, {});
  const zlib = instance.exports as unknown as ZlibModuleExports;
  if (
    !(zlib.memory instanceof WebAssembly.Memory) ||
    REQUIRED_FUNCTIONS.some((name) => typeof zlib[name] !== "function")
  ) {
    throw new Error("The zlib module does not provide raw deflate.");
  }
  const inputPointer = zlib.malloc(INPUT_BYTES);
  const outputPointer = zlib.malloc(OUTPUT_BYTES);
  if (!inputPointer || !outputPointer) {
    throw new Error("The zlib module is out of memory.");
  }
  let scratch = new Uint8Array(OUTPUT_BYTES);

  return {
    deflateRaw(input, level, final) {
      const stream = zlib.deflate_new();
      if (!stream) throw new Error("The zlib module is out of memory.");
      let produced = 0;
      try {
        const initialized = zlib.deflate_init_raw(stream, level);
        if (initialized !== 0) {
          throw new Error(`Deflate could not start (${initialized}).`);
        }
        const heap = new Uint8Array(zlib.memory.buffer);
        let offset = 0;
        for (;;) {
          const length = Math.min(INPUT_BYTES, input.length - offset);
          heap.set(input.subarray(offset, offset + length), inputPointer);
          offset += length;
          const last = offset === input.length;
          const flush = !last ? Z_NO_FLUSH : final ? Z_FINISH : Z_SYNC_FLUSH;
          let consumed = 0;
          for (;;) {
            const result = zlib.deflate_process(
              stream,
              inputPointer + consumed,
              length - consumed,
              outputPointer,
              OUTPUT_BYTES,
              flush,
            );
            const code = result >> 24;
            if (code < 0 && code !== Z_BUF_ERROR) {
              throw new Error(`Deflate failed (${code}).`);
            }
            const count = code < 0 ? 0 : result & 0xffffff;
            const taken = code < 0 ? 0 : zlib.deflate_last_consumed(stream);
            if (produced + count > scratch.length) {
              const grown = new Uint8Array(
                Math.max(scratch.length * 2, produced + count),
              );
              grown.set(scratch.subarray(0, produced));
              scratch = grown;
            }
            scratch.set(
              heap.subarray(outputPointer, outputPointer + count),
              produced,
            );
            produced += count;
            consumed += taken;
            if (flush === Z_FINISH) {
              if (code === Z_STREAM_END) break;
            } else if (consumed === length && count < OUTPUT_BYTES) {
              // All input is taken and the output had room to spare, so
              // nothing is left pending for this piece (or for the flush).
              break;
            }
            if (count === 0 && taken === 0) {
              throw new Error("Deflate made no progress.");
            }
          }
          if (last) break;
        }
      } finally {
        zlib.deflate_end(stream);
      }
      return scratch.subarray(0, produced);
    },
  };
}

export function storedDeflateSize(length: number, final: boolean): number {
  const blocks = Math.ceil(length / STORED_BLOCK_BYTES) || (final ? 1 : 0);
  return length + blocks * 5;
}

/**
 * Wraps `input` in stored (uncompressed) deflate blocks. Like a non-final
 * `deflateRaw` result, a non-final result can be followed by more deflate data.
 */
export function storedDeflateBlocks(
  input: Uint8Array,
  final: boolean,
): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(storedDeflateSize(input.length, final));
  let position = 0;
  let offset = 0;
  do {
    const length = Math.min(STORED_BLOCK_BYTES, input.length - offset);
    const last = offset + length === input.length;
    if (length === 0 && !final) break;
    output[position] = final && last ? 1 : 0;
    output[position + 1] = length & 0xff;
    output[position + 2] = length >>> 8;
    output[position + 3] = ~length & 0xff;
    output[position + 4] = (~length >>> 8) & 0xff;
    output.set(input.subarray(offset, offset + length), position + 5);
    position += 5 + length;
    offset += length;
  } while (offset < input.length);
  return output;
}

export function supportsNativeRawDeflate(): boolean {
  try {
    return (
      typeof CompressionStream !== "undefined" &&
      Boolean(new CompressionStream("deflate-raw"))
    );
  } catch {
    return false;
  }
}

/** Raw deflate of a whole buffer with the browser's CompressionStream. */
export async function nativeDeflateRaw(
  input: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const compressed = new Blob([input])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

/**
 * Checks a deflater against the browser's own inflate before it is trusted
 * with an archive: a sync-flushed range, a stored range and a final range must
 * concatenate into one valid deflate stream. Resolves true when the check
 * cannot run because DecompressionStream is unavailable.
 */
export async function verifyRawDeflater(
  deflater: RawDeflater,
): Promise<boolean> {
  if (typeof DecompressionStream === "undefined") return true;
  const sample = new Uint8Array(6000);
  for (let index = 0; index < sample.length; index++) {
    sample[index] = (index * 7 + (index >>> 5) * 13) % 61;
  }
  try {
    const parts = [
      deflater.deflateRaw(sample.subarray(0, 2500), 1, false).slice(),
      storedDeflateBlocks(sample.subarray(2500, 3000), false),
      deflater.deflateRaw(sample.subarray(3000), 1, true).slice(),
    ];
    const inflated = new Uint8Array(
      await new Response(
        new Blob(parts)
          .stream()
          .pipeThrough(new DecompressionStream("deflate-raw")),
      ).arrayBuffer(),
    );
    return (
      inflated.length === sample.length &&
      inflated.every((byte, index) => byte === sample[index])
    );
  } catch {
    return false;
  }
}
