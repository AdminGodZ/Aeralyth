import {
  decodeRepositoryText,
  formatHexDump,
  getRepositoryFilePresentation,
  isProbablyText,
  type RepositoryFilePresentation,
} from "@/features/repositories/repository-file-types";
import {
  readEncryptedFileBlob,
  readEncryptedFilePrefix,
} from "@/features/vault/encrypted-download";
import type { VaultManifest } from "@/features/vault/protocol";
import { getVaultDownloadPlan } from "@/features/vault/vault-api";
import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type { RepositoryEntry } from "@/lib/api";

export const MAX_REPOSITORY_PREVIEW_BYTES = 100 * 1024 * 1024;
export const MAX_REPOSITORY_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_RENDERED_SOURCE_CHARACTERS = 500_000;

export type LoadedRepositoryFile = {
  blob: Blob;
  lastModified: number;
  mimeType: string | null;
  name: string;
  sizeBytes: number;
  verification: "none" | "full" | "partial";
};

export type PreparedRepositoryFile = LoadedRepositoryFile & {
  encoding: string | null;
  hex: string;
  presentation: RepositoryFilePresentation;
  text: string | null;
  textTruncated: boolean;
};

type VaultFileAccess = {
  client: VaultCryptoClient | null;
  openNode(nodeId: string): Promise<VaultManifest>;
};

export async function loadRepositoryFile({
  entry,
  resolvedName,
  vault,
  signal,
  onProgress,
}: {
  entry: RepositoryEntry;
  resolvedName: string;
  vault: VaultFileAccess;
  signal?: AbortSignal;
  onProgress?(percentage: number | null): void;
}): Promise<LoadedRepositoryFile> {
  if (entry.entryType !== "file") {
    throw new Error("Only repository files can be previewed.");
  }
  if (entry.e2eeState === "encrypted") {
    if (!vault.client) {
      throw new Error("Unlock the vault to preview this encrypted file.");
    }
    const manifest = await vault.openNode(entry.id);
    if (manifest.entryType !== "file") {
      throw new Error("The encrypted repository metadata is inconsistent.");
    }
    const budget = previewBudget(
      manifest.name,
      manifest.mimeType,
      manifest.plaintextBytes,
    );
    const plan = await getVaultDownloadPlan(entry.id, signal);
    const options = {
      plan,
      manifest,
      client: vault.client,
      signal,
      onProgress,
    };
    const { blob, verification } =
      budget < manifest.plaintextBytes
        ? await readEncryptedFilePrefix({
            ...options,
            maxPlaintextBytes: budget,
          })
        : {
            blob: await readEncryptedFileBlob(options),
            verification: "full" as const,
          };
    return {
      blob,
      lastModified: manifest.lastModified,
      mimeType: manifest.mimeType,
      name: manifest.name,
      sizeBytes: manifest.plaintextBytes,
      verification,
    };
  }

  const budget = previewBudget(resolvedName, entry.mimeType, entry.sizeBytes);
  const partial = budget < entry.sizeBytes;
  const response = await fetch(
    `/api/files/${encodeURIComponent(entry.id)}/download`,
    {
      signal,
      cache: "no-store",
      ...(partial ? { headers: { Range: `bytes=0-${budget - 1}` } } : {}),
    },
  );
  if (!response.ok) {
    throw new Error(`File preview failed (${response.status}).`);
  }
  const blob = await readResponseBlob({
    response,
    expectedBytes: Math.min(entry.sizeBytes, budget),
    totalBytes: entry.sizeBytes,
    byteLimit: budget,
    partial,
    signal,
    onProgress,
  });
  return {
    blob,
    lastModified: parseTimestamp(entry.updatedAt),
    mimeType: entry.mimeType,
    name: resolvedName,
    sizeBytes: entry.sizeBytes,
    verification: "none",
  };
}

export class RepositoryPreviewTooLargeError extends Error {
  constructor(readonly sizeBytes: number) {
    super("This file is too large for an in-browser preview.");
    this.name = "RepositoryPreviewTooLargeError";
  }
}

export async function prepareRepositoryFile(
  file: LoadedRepositoryFile,
): Promise<PreparedRepositoryFile> {
  let presentation = getRepositoryFilePresentation(file.name, file.mimeType);
  const sampleBytes =
    presentation.kind === "text" ||
    presentation.kind === "markdown" ||
    presentation.kind === "binary"
      ? MAX_REPOSITORY_TEXT_BYTES
      : 32 * 1024;
  const bytes = new Uint8Array(
    await file.blob.slice(0, sampleBytes).arrayBuffer(),
  );
  let encoding: string | null = null;
  let text: string | null = null;
  let textTruncated = false;

  if (
    presentation.kind === "binary" &&
    isProbablyText(bytes, bytes.byteLength < file.sizeBytes)
  ) {
    presentation = { kind: "text", label: "Text", language: "text" };
  }
  if (presentation.kind === "text" || presentation.kind === "markdown") {
    const decoded = decodeRepositoryText(
      bytes,
      bytes.byteLength < file.sizeBytes,
    );
    encoding = decoded.encoding;
    textTruncated =
      file.sizeBytes > bytes.byteLength ||
      decoded.text.length > MAX_RENDERED_SOURCE_CHARACTERS;
    text = decoded.text.slice(0, MAX_RENDERED_SOURCE_CHARACTERS);
    // Keep the display cap from splitting an otherwise valid surrogate pair.
    if (textTruncated && /[\uD800-\uDBFF]$/u.test(text))
      text = text.slice(0, -1);
  }

  return {
    ...file,
    encoding,
    hex: formatHexDump(bytes),
    presentation,
    text,
    textTruncated,
  };
}

function previewBudget(
  name: string,
  mimeType: string | null,
  sizeBytes: number,
) {
  const { kind } = getRepositoryFilePresentation(name, mimeType);
  if (kind === "text" || kind === "markdown" || kind === "binary") {
    return MAX_REPOSITORY_TEXT_BYTES;
  }
  if (sizeBytes > MAX_REPOSITORY_PREVIEW_BYTES) {
    throw new RepositoryPreviewTooLargeError(sizeBytes);
  }
  return MAX_REPOSITORY_PREVIEW_BYTES;
}

async function readResponseBlob({
  response,
  expectedBytes,
  totalBytes,
  byteLimit,
  partial,
  signal,
  onProgress,
}: {
  response: Response;
  expectedBytes: number;
  totalBytes: number;
  byteLimit: number;
  partial: boolean;
  signal?: AbortSignal;
  onProgress?: (percentage: number | null) => void;
}): Promise<Blob> {
  signal?.throwIfAborted();
  if (response.status === 206) {
    const range = /^bytes 0-(\d+)\/(\d+)$/u.exec(
      response.headers.get("content-range") ?? "",
    );
    if (
      !partial ||
      !range ||
      Number(range[1]) + 1 !== expectedBytes ||
      Number(range[2]) !== totalBytes
    ) {
      await response.body?.cancel();
      throw new Error("The file preview returned an invalid byte range.");
    }
  }
  if (!response.body) {
    if (expectedBytes > 0) {
      throw new Error("The file preview response did not contain file data.");
    }
    onProgress?.(100);
    return new Blob([], { type: response.headers.get("content-type") ?? "" });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let receivedBytes = 0;
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      const remaining = byteLimit - receivedBytes;
      if (!partial && value.byteLength > remaining) {
        throw new RepositoryPreviewTooLargeError(
          receivedBytes + value.byteLength,
        );
      }
      // Fetch gives each read its own immutable chunk. Retain that view instead
      // of making a second application copy; Blob snapshots it before release.
      const chunk =
        value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      receivedBytes += chunk.byteLength;
      onProgress?.(
        expectedBytes
          ? Math.min(99, (receivedBytes / expectedBytes) * 100)
          : null,
      );
      if (partial && receivedBytes === byteLimit) break;
    }
    if (receivedBytes !== expectedBytes) {
      throw new Error("The file preview response was incomplete.");
    }
    onProgress?.(100);
    return new Blob(chunks, {
      type: response.headers.get("content-type") ?? "application/octet-stream",
    });
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    chunks.length = 0;
  }
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}
