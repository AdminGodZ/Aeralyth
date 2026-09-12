import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadRepositoryFile,
  MAX_REPOSITORY_PREVIEW_BYTES,
  MAX_REPOSITORY_TEXT_BYTES,
  prepareRepositoryFile,
  RepositoryPreviewTooLargeError,
} from "@/features/repositories/repository-file-loader";
import type { VaultManifest } from "@/features/vault/protocol";
import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type { RepositoryEntry } from "@/lib/api";

const encrypted = vi.hoisted(() => ({
  prefix: vi.fn(),
  full: vi.fn(),
  plan: vi.fn(),
}));
vi.mock("@/features/vault/encrypted-download", () => ({
  readEncryptedFilePrefix: encrypted.prefix,
  readEncryptedFileBlob: encrypted.full,
}));
vi.mock("@/features/vault/vault-api", () => ({
  getVaultDownloadPlan: encrypted.plan,
}));

const entry: RepositoryEntry = {
  id: "file-id",
  name: "source.txt",
  mimeType: "text/plain",
  entryType: "file",
  parentId: null,
  sizeBytes: 32 * 1024 * 1024,
  e2eeState: "legacy",
  updatedAt: "2026-09-12T12:00:00Z",
  vaultGenerationId: null,
  vaultRecordVersion: null,
  vaultRecordHash: null,
};
const vault = { client: null, openNode: vi.fn() };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function load(overrides: Partial<RepositoryEntry> = {}, signal?: AbortSignal) {
  const fileEntry = { ...entry, ...overrides };
  return loadRepositoryFile({
    entry: fileEntry,
    resolvedName: fileEntry.name,
    vault,
    signal,
  });
}

describe("bounded repository previews", () => {
  it("requests only the text prefix and preserves the full source size", async () => {
    const prefix = new Uint8Array(MAX_REPOSITORY_TEXT_BYTES).fill(65);
    const fetch = vi.fn(
      async () =>
        new Response(prefix, {
          status: 206,
          headers: {
            "content-range": `bytes 0-${prefix.length - 1}/${entry.sizeBytes}`,
          },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const file = await load();
    expect(fetch).toHaveBeenCalledWith(
      "/api/files/file-id/download",
      expect.objectContaining({
        headers: { Range: `bytes=0-${prefix.length - 1}` },
      }),
    );
    expect(file.blob.size).toBe(MAX_REPOSITORY_TEXT_BYTES);
    expect(file.sizeBytes).toBe(entry.sizeBytes);
    expect(file.verification).toBe("none");
    const prepared = await prepareRepositoryFile(file);
    expect(prepared.textTruncated).toBe(true);
    expect(prepared.text).toHaveLength(500_000);
  });

  it("stops reading and cancels a server that ignores the requested range", async () => {
    let readBytes = 0;
    const cancel = vi.fn();
    const chunkBytes = 64 * 1024;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          readBytes += chunkBytes;
          controller.enqueue(new Uint8Array(chunkBytes).fill(65));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    const file = await load();
    expect(readBytes).toBe(MAX_REPOSITORY_TEXT_BYTES);
    expect(file.blob.size).toBe(MAX_REPOSITORY_TEXT_BYTES);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("limits binary prefixes and permits huge source files with bounded previews", async () => {
    const prefix = new Uint8Array(MAX_REPOSITORY_TEXT_BYTES).fill(1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(prefix)),
    );
    const file = await load({
      name: "large.bin",
      mimeType: "application/octet-stream",
      sizeBytes: MAX_REPOSITORY_PREVIEW_BYTES * 4,
    });
    expect(file.blob.size).toBe(MAX_REPOSITORY_TEXT_BYTES);
    expect(file.sizeBytes).toBe(MAX_REPOSITORY_PREVIEW_BYTES * 4);
    const prepared = await prepareRepositoryFile(file);
    expect(prepared.presentation.kind).toBe("binary");
    expect(prepared.text).toBeNull();
  });

  it.each([
    "image.png",
    "movie.mp4",
    "sound.mp3",
    "manual.pdf",
    "source.zip",
    "font.woff2",
  ])("loads complete %s content for viewers that need it", async (name) => {
    const payload = new Uint8Array(MAX_REPOSITORY_TEXT_BYTES + 123).fill(17);
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(payload),
    );
    vi.stubGlobal("fetch", fetch);
    const file = await load({
      name,
      mimeType: null,
      sizeBytes: payload.length,
    });
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty("headers");
    expect(file.blob.size).toBe(payload.length);
  });

  it("refuses oversized full-media previews before making a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      load({ name: "movie.mp4", sizeBytes: MAX_REPOSITORY_PREVIEW_BYTES + 1 }),
    ).rejects.toBeInstanceOf(RepositoryPreviewTooLargeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains native response views and lets Blob snapshot the received bytes", async () => {
    const first = new Uint8Array([65, 66]);
    const second = new Uint8Array([67, 68]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      },
    });
    const nativeBlob = Blob;
    const retained: BlobPart[] = [];
    vi.stubGlobal(
      "Blob",
      class extends nativeBlob {
        constructor(parts: BlobPart[], options?: BlobPropertyBag) {
          retained.push(...parts);
          super(parts, options);
        }
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    const file = await load({ sizeBytes: 4 });
    expect(retained[0]).toBe(first);
    expect(retained[1]).toBe(second);
    first.fill(0);
    second.fill(0);
    expect(await file.blob.text()).toBe("ABCD");
  });

  it.each([
    "bytes 1-2097152/33554432",
    "bytes 0-50/33554432",
    "bytes 0-2097151/20",
    "bytes 0-2097151/33554433",
    "invalid",
  ])("rejects malformed range metadata %s", async (contentRange) => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(stream, {
            status: 206,
            headers: { "content-range": contentRange },
          }),
      ),
    );
    await expect(load()).rejects.toThrow("invalid byte range");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects truncated responses instead of presenting them as complete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("short")),
    );
    await expect(load()).rejects.toThrow("incomplete");
  });

  it("cancels pending reads and releases the stream lock on abort", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          controller.abort();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    await expect(load({}, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("classifies encrypted files from authenticated manifest metadata", async () => {
    const manifest = {
      name: "secret.log",
      mimeType: "text/plain",
      plaintextBytes: entry.sizeBytes,
      entryType: "file",
      lastModified: 123,
    } as VaultManifest;
    const client = {} as VaultCryptoClient;
    const plan = { nodeId: entry.id };
    encrypted.plan.mockResolvedValue(plan);
    encrypted.prefix.mockResolvedValue({
      blob: new Blob([new Uint8Array(MAX_REPOSITORY_TEXT_BYTES)]),
      verification: "partial",
    });
    const file = await loadRepositoryFile({
      entry: { ...entry, e2eeState: "encrypted", name: "opaque.png" },
      resolvedName: "opaque.png",
      vault: { client, openNode: vi.fn(async () => manifest) },
    });
    expect(encrypted.prefix).toHaveBeenCalledWith(
      expect.objectContaining({
        plan,
        manifest,
        client,
        maxPlaintextBytes: MAX_REPOSITORY_TEXT_BYTES,
      }),
    );
    expect(encrypted.full).not.toHaveBeenCalled();
    expect(file.name).toBe("secret.log");
    expect(file.verification).toBe("partial");
    expect(file.sizeBytes).toBe(entry.sizeBytes);
  });

  it("propagates encrypted prefix authentication failures", async () => {
    encrypted.prefix.mockRejectedValue(
      new Error("Chunk authentication failed"),
    );
    const manifest = {
      name: "secret.log",
      mimeType: "text/plain",
      plaintextBytes: entry.sizeBytes,
      entryType: "file",
      lastModified: 123,
    } as VaultManifest;
    await expect(
      loadRepositoryFile({
        entry: { ...entry, e2eeState: "encrypted" },
        resolvedName: "secret.log",
        vault: {
          client: {} as VaultCryptoClient,
          openNode: vi.fn(async () => manifest),
        },
      }),
    ).rejects.toThrow("Chunk authentication failed");
  });

  it("loads and verifies complete encrypted media instead of sending a prefix", async () => {
    const manifest = {
      name: "movie.mp4",
      mimeType: "video/mp4",
      plaintextBytes: MAX_REPOSITORY_TEXT_BYTES + 1,
      entryType: "file",
      lastModified: 123,
    } as VaultManifest;
    const payload = new Blob([new Uint8Array(manifest.plaintextBytes)]);
    encrypted.full.mockResolvedValue(payload);
    const file = await loadRepositoryFile({
      entry: { ...entry, e2eeState: "encrypted" },
      resolvedName: "opaque.txt",
      vault: {
        client: {} as VaultCryptoClient,
        openNode: vi.fn(async () => manifest),
      },
    });
    expect(encrypted.prefix).not.toHaveBeenCalled();
    expect(encrypted.full).toHaveBeenCalledOnce();
    expect(file.blob).toBe(payload);
    expect(file.verification).toBe("full");
    expect(file.mimeType).toBe("video/mp4");
  });

  it("does not introduce replacement characters at an incomplete UTF-8 prefix", async () => {
    const prepared = await prepareRepositoryFile({
      blob: new Blob([Uint8Array.of(65, 0xf0, 0x9f, 0x98)]),
      name: "source.txt",
      mimeType: "text/plain",
      sizeBytes: 100,
      lastModified: 0,
      verification: "none",
    });
    expect(prepared.text).toBe("A");
    expect(prepared.textTruncated).toBe(true);
  });
});
