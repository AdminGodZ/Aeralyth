import { readEncryptedFileStream } from "@/features/vault/encrypted-download";
import {
  toBase64Url,
  type VaultDownloadPlan,
  type VaultManifest,
} from "@/features/vault/protocol";
import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type { RepositoryArchiveEntry } from "@/lib/api";

export async function readLegacyArchiveFileStream(
  entry: RepositoryArchiveEntry,
  resolvedName: string,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(
    `/api/files/${encodeURIComponent(entry.id)}/download?version=${encodeURIComponent(entry.contentVersion)}`,
    { signal, cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(`Could not download ${resolvedName} (${response.status}).`);
  }
  if (!response.body) {
    throw new Error(`Could not stream ${resolvedName}.`);
  }
  return requireExactStreamLength(
    response.body,
    entry.sizeBytes,
    `The downloaded size of ${resolvedName} changed.`,
  );
}

export function readEncryptedArchiveFileStream({
  entry,
  manifest,
  plan,
  client,
  signal,
  subject,
}: {
  entry: RepositoryArchiveEntry;
  manifest: VaultManifest | undefined;
  plan: VaultDownloadPlan | undefined;
  client: VaultCryptoClient | null;
  signal?: AbortSignal;
  /** What is being archived, used in error messages ("folder", "repository"). */
  subject: string;
}): ReadableStream<Uint8Array> {
  if (!manifest || !plan || !client) {
    throw new Error(`The encrypted ${subject} is not unlocked.`);
  }
  if (
    plan.nodeId !== entry.id ||
    plan.generationId !== toBase64Url(manifest.generationId) ||
    plan.generationId !== entry.vaultGenerationId ||
    plan.recordHash !== entry.vaultRecordHash
  ) {
    throw new Error(`The encrypted ${subject} changed during ZIP preparation.`);
  }
  return requireExactStreamLength(
    readEncryptedFileStream({ plan, manifest, client, signal }),
    manifest.plaintextBytes,
    `The downloaded size of ${manifest.name} changed.`,
  );
}

function requireExactStreamLength(
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
  errorMessage: string,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let receivedBytes = 0;
  // Reads only on demand, unlike a pipe, so a stream opened ahead of the ZIP
  // writer leaves its source backpressured instead of draining a chunk.
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            if (receivedBytes !== expectedBytes) throw new Error(errorMessage);
            controller.close();
            return;
          }
          receivedBytes += result.value.byteLength;
          if (receivedBytes > expectedBytes) throw new Error(errorMessage);
          controller.enqueue(result.value);
        } catch (error) {
          await reader.cancel(error).catch(() => undefined);
          throw error;
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Archive progress: names occupy 0–20%, file bytes 20–99%. */
export function archivePercentage(
  processedBytes: number,
  totalBytes: number,
): number {
  if (totalBytes === 0) return 99;
  return Math.min(99, 20 + (processedBytes / totalBytes) * 79);
}
