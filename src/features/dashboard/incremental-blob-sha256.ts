import { sha256 } from "@noble/hashes/sha2.js";
import { abortReason } from "@/lib/abort";

const ABORT_MESSAGE = "Upload canceled";

export const BLOB_HASH_CHUNK_BYTES = 1024 * 1024;

export async function incrementalBlobSha256(
  blob: Blob,
  signal?: AbortSignal,
  onChunk?: (chunkBytes: number) => void,
): Promise<Uint8Array> {
  const hasher = sha256.create();
  let digested = false;

  try {
    for (let offset = 0; offset < blob.size; offset += BLOB_HASH_CHUNK_BYTES) {
      if (signal?.aborted) throw abortReason(signal, ABORT_MESSAGE);
      const chunk = blob.slice(offset, offset + BLOB_HASH_CHUNK_BYTES);
      const reader = chunk.stream().getReader();
      // Blob slices stay sequential so the worker retains at most one bounded slice.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      try {
        while (true) {
          if (signal?.aborted) throw abortReason(signal, ABORT_MESSAGE);
          // Each slice can itself contain multiple stream chunks.
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          const { done, value } = await reader.read();
          if (done) break;
          hasher.update(value);
          onChunk?.(value.byteLength);
        }
      } finally {
        // Cancel before releasing the only bounded reader; concurrent slice
        // reads would reorder the digest and retain multiple chunks.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    if (signal?.aborted) throw abortReason(signal, ABORT_MESSAGE);
    const digest = hasher.digest();
    digested = true;
    return digest;
  } finally {
    if (!digested) hasher.destroy();
  }
}
