import {
  decodeRepositoryText,
  formatHexDump,
  getRepositoryFilePresentation,
  isProbablyText,
  type RepositoryFilePresentation,
} from "@/features/repositories/repository-file-types";
import { readEncryptedFileBlob } from "@/features/vault/encrypted-download";
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
  if (entry.sizeBytes > MAX_REPOSITORY_PREVIEW_BYTES) {
    throw new RepositoryPreviewTooLargeError(entry.sizeBytes);
  }

  if (entry.e2eeState === "encrypted") {
    if (!vault.client) {
      throw new Error("Unlock the vault to preview this encrypted file.");
    }
    const manifest = await vault.openNode(entry.id);
    if (manifest.entryType !== "file") {
      throw new Error("The encrypted repository metadata is inconsistent.");
    }
    if (manifest.plaintextBytes > MAX_REPOSITORY_PREVIEW_BYTES) {
      throw new RepositoryPreviewTooLargeError(manifest.plaintextBytes);
    }
    const plan = await getVaultDownloadPlan(entry.id, signal);
    const blob = await readEncryptedFileBlob({
      plan,
      manifest,
      client: vault.client,
      signal,
      onProgress,
    });
    return {
      blob,
      lastModified: manifest.lastModified,
      mimeType: manifest.mimeType,
      name: manifest.name,
      sizeBytes: manifest.plaintextBytes,
    };
  }

  const response = await fetch(
    `/api/files/${encodeURIComponent(entry.id)}/download`,
    { signal, cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(`File preview failed (${response.status}).`);
  }
  const blob = await readResponseBlob(response, entry.sizeBytes, onProgress);
  return {
    blob,
    lastModified: parseTimestamp(entry.updatedAt),
    mimeType: blob.type || entry.mimeType,
    name: resolvedName,
    sizeBytes: blob.size,
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

  if (presentation.kind === "binary" && isProbablyText(bytes)) {
    presentation = { kind: "text", label: "Text", language: "text" };
  }
  if (presentation.kind === "text" || presentation.kind === "markdown") {
    const decoded = decodeRepositoryText(bytes);
    encoding = decoded.encoding;
    textTruncated =
      file.blob.size > bytes.byteLength ||
      decoded.text.length > MAX_RENDERED_SOURCE_CHARACTERS;
    text = decoded.text.slice(0, MAX_RENDERED_SOURCE_CHARACTERS);
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

async function readResponseBlob(
  response: Response,
  expectedBytes: number,
  onProgress?: (percentage: number | null) => void,
): Promise<Blob> {
  if (!response.body) {
    const blob = await response.blob();
    onProgress?.(100);
    return blob;
  }

  const headerBytes = Number.parseInt(
    response.headers.get("content-length") ?? "",
    10,
  );
  const totalBytes =
    Number.isFinite(headerBytes) && headerBytes > 0
      ? headerBytes
      : expectedBytes > 0
        ? expectedBytes
        : null;
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Uint8Array.from(value);
    chunks.push(chunk);
    receivedBytes += chunk.byteLength;
    onProgress?.(
      totalBytes ? Math.min(99, (receivedBytes / totalBytes) * 100) : null,
    );
    if (receivedBytes > MAX_REPOSITORY_PREVIEW_BYTES) {
      await reader.cancel();
      throw new RepositoryPreviewTooLargeError(receivedBytes);
    }
  }

  onProgress?.(100);
  return new Blob(chunks, {
    type: response.headers.get("content-type") ?? "application/octet-stream",
  });
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}
