import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VaultCryptoClient } from "@/features/vault/vault-client";
import type { VaultEncryptionInput } from "@/features/vault/vault-messages";

const vaultApi = vi.hoisted(() => ({
  abortVaultUpload: vi.fn(),
  getVaultContentUrl: vi.fn(),
  getVaultPartUrl: vi.fn(),
  getVaultPartUrls: vi.fn(),
  initVaultUpload: vi.fn(),
  publishVaultFoldersBatch: vi.fn(),
  publishVaultUpload: vi.fn(),
}));

vi.mock("@/features/vault/vault-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/vault/vault-api")>()),
  ...vaultApi,
}));

import { uploadEncryptedSelections } from "@/features/vault/encrypted-upload";

const emptyRecord = {
  bootstrapCbor: new Uint8Array(),
  bootstrapSignature: new Uint8Array(),
  encryptedManifest: new Uint8Array(),
  wrappers: [],
};

describe("encrypted upload scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vaultApi.abortVaultUpload.mockResolvedValue(undefined);
    vaultApi.publishVaultFoldersBatch.mockResolvedValue({ folders: [] });
    vaultApi.publishVaultUpload.mockResolvedValue({
      nodeId: "node",
      generationNumber: 1,
      generationId: "generation",
      recordVersion: 1,
      recordHash: "record-hash",
      shareSyncRequired: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs three small encrypted files concurrently", async () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
    let activePuts = 0;
    let peakPuts = 0;
    let releasePuts: (() => void) | undefined;
    const putGate = new Promise<void>((resolve) => {
      releasePuts = resolve;
    });
    vaultApi.initVaultUpload.mockImplementation(
      async (_csrfToken, payload: { nodeId: string }) => ({
        uploadId: `upload-${payload.nodeId}`,
        nodeId: payload.nodeId,
        mode: "single",
        partSizeBytes: null,
      }),
    );
    vaultApi.getVaultContentUrl.mockImplementation(
      async (_csrfToken, uploadId: string) => ({
        url: `https://storage.invalid/${uploadId}`,
        contentLength: 1,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        activePuts += 1;
        peakPuts = Math.max(peakPuts, activePuts);
        await putGate;
        activePuts -= 1;
        return new Response(null, { status: 200 });
      }),
    );

    const client = createCryptoClient(() => 1);
    const onProgress = vi.fn();
    const upload = uploadEncryptedSelections({
      selections: ["one", "two", "three"].map((name) => ({
        file: new File([Uint8Array.of(1)], `${name}.txt`),
        relativePath: `${name}.txt`,
      })),
      parentFolderId: null,
      csrfToken: "csrf",
      client,
      signal: new AbortController().signal,
      onProgress,
      onFileStart: () => undefined,
      onFileComplete: () => undefined,
    });

    await vi.waitFor(() => expect(activePuts).toBe(3));
    expect(onProgress).not.toHaveBeenCalled();
    releasePuts?.();
    await upload;

    expect(peakPuts).toBe(3);
    expect(vaultApi.publishVaultUpload).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenLastCalledWith(3, 3, expect.any(Number), 1);
  });

  it("does not count encrypted bytes when storage rejects a single upload", async () => {
    vaultApi.initVaultUpload.mockResolvedValue({
      uploadId: "upload-rejected",
      nodeId: "node-rejected",
      mode: "single",
      partSizeBytes: null,
    });
    vaultApi.getVaultContentUrl.mockResolvedValue({
      url: "https://storage.invalid/rejected",
      contentLength: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("AccessDenied", { status: 403 })),
    );
    const onProgress = vi.fn();
    const onFileComplete = vi.fn();
    const onFileError = vi.fn();

    await expect(
      uploadEncryptedSelections({
        selections: [
          {
            file: new File([Uint8Array.of(1)], "rejected.bin"),
            relativePath: "rejected.bin",
          },
        ],
        parentFolderId: null,
        csrfToken: "csrf",
        client: createCryptoClient(() => 1),
        signal: new AbortController().signal,
        onProgress,
        onFileStart: () => undefined,
        onFileComplete,
        onFileError,
      }),
    ).rejects.toThrow("403");

    expect(onProgress).not.toHaveBeenCalled();
    expect(onFileComplete).not.toHaveBeenCalled();
    expect(onFileError).toHaveBeenCalledExactlyOnceWith(0);
    expect(vaultApi.publishVaultUpload).not.toHaveBeenCalled();
  });

  it("counts multipart progress only as storage accepts each part", async () => {
    vaultApi.initVaultUpload.mockResolvedValue({
      uploadId: "upload-parts",
      nodeId: "node-parts",
      mode: "multipart",
      partSizeBytes: 2,
    });
    vaultApi.getVaultPartUrls.mockImplementation(
      async (_csrf, _upload, parts) => ({
        parts: parts.map(({ partNumber }: { partNumber: number }) => ({
          partNumber,
          url: `https://storage.invalid/part-${partNumber}`,
          contentLength: 2,
        })),
      }),
    );
    const releases = new Map<string, () => void>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        await new Promise<void>((resolve) => releases.set(url, resolve));
        return new Response(null, {
          status: 200,
          headers: { ETag: '"part-etag"' },
        });
      }),
    );
    const onProgress = vi.fn();
    const upload = uploadEncryptedSelections({
      selections: [
        {
          file: new File([Uint8Array.of(1, 2, 3)], "parts.bin"),
          relativePath: "parts.bin",
        },
      ],
      parentFolderId: null,
      csrfToken: "csrf",
      client: createCryptoClient(() => 4),
      signal: new AbortController().signal,
      onProgress,
      onFileStart: () => undefined,
      onFileComplete: () => undefined,
    });
    await vi.waitFor(() => expect(releases.size).toBe(2));
    expect(onProgress).not.toHaveBeenCalled();
    releases.get("https://storage.invalid/part-1")?.();
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith(1, 3, 0, 1));
    releases.get("https://storage.invalid/part-2")?.();
    await upload;
    expect(onProgress).toHaveBeenLastCalledWith(3, 3, 0, 3);
  });

  it("refreshes an expired single-upload signature before retrying", async () => {
    vaultApi.initVaultUpload.mockResolvedValue({
      uploadId: "upload-refresh",
      nodeId: "node-refresh",
      mode: "single",
      partSizeBytes: null,
    });
    vaultApi.getVaultContentUrl
      .mockResolvedValueOnce({
        url: "https://storage.invalid/expired",
        contentLength: 1,
      })
      .mockResolvedValueOnce({
        url: "https://storage.invalid/refreshed",
        contentLength: 1,
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<Code>ExpiredToken</Code>", { status: 403 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadEncryptedSelections({
      selections: [
        {
          file: new File([Uint8Array.of(1)], "refresh.bin"),
          relativePath: "refresh.bin",
        },
      ],
      parentFolderId: null,
      csrfToken: "csrf",
      client: createCryptoClient(() => 1),
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onFileStart: () => undefined,
      onFileComplete: () => undefined,
    });

    expect(vaultApi.getVaultContentUrl).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://storage.invalid/expired",
      "https://storage.invalid/refreshed",
    ]);
  });

  it("uploads ready root files while an unrelated folder is still being prepared", async () => {
    vaultApi.initVaultUpload.mockImplementation(async (_csrf, input) => ({
      uploadId: input.nodeId,
      nodeId: input.nodeId,
      mode: "single",
      partSizeBytes: null,
    }));
    vaultApi.getVaultContentUrl.mockResolvedValue({
      url: "https://storage.invalid/file",
      contentLength: 1,
    });
    vaultApi.publishVaultFoldersBatch.mockResolvedValue({
      folders: [
        {
          nodeId: "node-slow",
          generationNumber: 1,
          generationId: "generation-slow",
          recordVersion: 1,
          recordHash: "record-slow",
          shareSyncRequired: false,
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const client = createCryptoClient(() => 1);
    const originalStart = client.startEncryption.bind(client);
    let releaseFolder: (() => void) | undefined;
    const folder = new Promise<void>((resolve) => {
      releaseFolder = resolve;
    });
    vi.spyOn(client, "startEncryption").mockImplementation(async (input) => {
      if (input.entryType === "folder") await folder;
      return originalStart(input);
    });
    const finished: number[] = [];
    const upload = uploadEncryptedSelections({
      selections: ["root.txt", "slow/nested.txt"].map((path) => ({
        file: new File([Uint8Array.of(1)], path.split("/").at(-1) as string),
        relativePath: path,
      })),
      parentFolderId: null,
      csrfToken: "csrf",
      client,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onFileStart: () => undefined,
      onFileComplete: (index) => {
        finished.push(index);
      },
    });
    await vi.waitFor(() => expect(finished).toEqual([0]));
    expect(vaultApi.publishVaultFoldersBatch).not.toHaveBeenCalled();
    releaseFolder?.();
    await upload;
    expect(finished).toEqual([0, 1]);
  });

  it("bounds ready presign batches, fills four PUT slots, and publishes in order", async () => {
    let activePuts = 0;
    let peakPuts = 0;
    let releaseFirstBatch: (() => void) | undefined;
    const firstBatchGate = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    });
    vaultApi.initVaultUpload.mockResolvedValue({
      uploadId: "upload-multipart",
      nodeId: "node-multipart",
      mode: "multipart",
      partSizeBytes: 8,
    });
    vaultApi.getVaultPartUrls.mockImplementation(
      async (_csrfToken, _uploadId, parts: Array<{ partNumber: number }>) => ({
        parts: parts.map(({ partNumber }) => ({
          partNumber,
          url: `https://storage.invalid/part-${partNumber}`,
          contentLength: 8,
        })),
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const partNumber = Number(String(input).split("-").at(-1));
        activePuts += 1;
        peakPuts = Math.max(peakPuts, activePuts);
        if (partNumber <= 4) await firstBatchGate;
        activePuts -= 1;
        return new Response(null, {
          status: 200,
          headers: { ETag: `"etag-${partNumber}"` },
        });
      }),
    );

    const client = createCryptoClient(() => 40);
    const upload = uploadEncryptedSelections({
      selections: [
        {
          file: new File([Uint8Array.of(1)], "multipart.bin"),
          relativePath: "multipart.bin",
        },
      ],
      parentFolderId: null,
      csrfToken: "csrf",
      client,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onFileStart: () => undefined,
      onFileComplete: () => undefined,
    });

    await vi.waitFor(() => expect(activePuts).toBe(4));
    expect(
      vaultApi.getVaultPartUrls.mock.calls
        .flatMap((call) =>
          call[2].map((part: { partNumber: number }) => part.partNumber),
        )
        .sort((left, right) => left - right),
    ).toEqual([1, 2, 3, 4]);
    releaseFirstBatch?.();
    await upload;

    expect(peakPuts).toBe(4);
    // Hashes can complete in any order and the short flush deadline may split
    // ready parts into smaller batches. Neither changes their PUT identities.
    expect(
      vaultApi.getVaultPartUrls.mock.calls.every(
        (call) => call[2].length > 0 && call[2].length <= 4,
      ),
    ).toBe(true);
    expect(
      vaultApi.getVaultPartUrls.mock.calls
        .flatMap((call) =>
          call[2].map((part: { partNumber: number }) => part.partNumber),
        )
        .sort((left, right) => left - right),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(vaultApi.publishVaultUpload.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({ partNumber: 1, etag: '"etag-1"' }),
      expect.objectContaining({ partNumber: 2, etag: '"etag-2"' }),
      expect.objectContaining({ partNumber: 3, etag: '"etag-3"' }),
      expect.objectContaining({ partNumber: 4, etag: '"etag-4"' }),
      expect.objectContaining({ partNumber: 5, etag: '"etag-5"' }),
    ]);
  });

  it("publishes parent-ordered folders in one batch without staging folder uploads", async () => {
    vaultApi.publishVaultFoldersBatch.mockResolvedValue({
      folders: ["root", "nested"].map((name) => ({
        nodeId: `node-${name}`,
        generationNumber: 1,
        generationId: `generation-${name}`,
        recordVersion: 1,
        recordHash: `record-${name}`,
        shareSyncRequired: false,
      })),
    });
    vaultApi.initVaultUpload.mockResolvedValue({
      uploadId: "upload-file",
      nodeId: "node-file.txt",
      mode: "single",
      partSizeBytes: null,
    });
    vaultApi.getVaultContentUrl.mockResolvedValue({
      url: "https://storage.invalid/file",
      contentLength: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const client = createCryptoClient(() => 1);
    const startEncryption = vi.spyOn(client, "startEncryption");

    const result = await uploadEncryptedSelections({
      selections: [
        {
          file: new File([Uint8Array.of(1)], "file.txt"),
          relativePath: "root/nested/file.txt",
        },
      ],
      parentFolderId: null,
      csrfToken: "csrf",
      client,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onFileStart: () => undefined,
      onFileComplete: () => undefined,
    });

    expect(result.rootFolderId).toBe("node-root");
    expect(vaultApi.publishVaultFoldersBatch).toHaveBeenCalledTimes(1);
    expect(vaultApi.publishVaultFoldersBatch.mock.calls[0]?.[1]).toHaveLength(
      2,
    );
    expect(vaultApi.initVaultUpload).toHaveBeenCalledTimes(1);
    expect(startEncryption.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        entryType: "folder",
        name: "root",
        parentId: null,
      }),
      expect.objectContaining({
        entryType: "folder",
        name: "nested",
        parentId: "node-root",
      }),
      expect.objectContaining({
        entryType: "file",
        name: "file.txt",
        parentId: "node-nested",
      }),
    ]);
  });

  it("discards every unpublished folder key when a batch is rejected", async () => {
    vaultApi.publishVaultFoldersBatch.mockRejectedValue(
      new Error("batch rejected"),
    );
    const client = createCryptoClient(() => 1);
    const abortEncryption = vi.spyOn(client, "abortEncryption");

    await expect(
      uploadEncryptedSelections({
        selections: [
          {
            file: new File([Uint8Array.of(1)], "file.txt"),
            relativePath: "root/nested/file.txt",
          },
        ],
        parentFolderId: null,
        csrfToken: "csrf",
        client,
        signal: new AbortController().signal,
        onProgress: () => undefined,
        onFileStart: () => undefined,
        onFileComplete: () => undefined,
      }),
    ).rejects.toThrow("batch rejected");

    expect(abortEncryption.mock.calls).toEqual(
      expect.arrayContaining([
        ["session-root", "node-root"],
        ["session-nested", "node-nested"],
      ]),
    );
    expect(vaultApi.initVaultUpload).not.toHaveBeenCalled();
  });

  it("rejects folder ancestry beyond the server safety bound before encryption", async () => {
    const client = createCryptoClient(() => 1);
    const startEncryption = vi.spyOn(client, "startEncryption");
    const relativePath = `${Array.from({ length: 101 }, (_, index) => `d${index}`).join("/")}/file.txt`;

    await expect(
      uploadEncryptedSelections({
        selections: [
          {
            file: new File([Uint8Array.of(1)], "file.txt"),
            relativePath,
          },
        ],
        parentFolderId: null,
        csrfToken: "csrf",
        client,
        signal: new AbortController().signal,
        onProgress: () => undefined,
        onFileStart: () => undefined,
        onFileComplete: () => undefined,
      }),
    ).rejects.toThrow("exceeds 100 levels");

    expect(startEncryption).not.toHaveBeenCalled();
    expect(vaultApi.publishVaultFoldersBatch).not.toHaveBeenCalled();
  });

  it("starts the first multipart PUT before the next crypto chunk is ready", async () => {
    vaultApi.initVaultUpload.mockResolvedValue({
      uploadId: "rolling",
      nodeId: "node-rolling.bin",
      mode: "multipart",
      partSizeBytes: 8,
    });
    vaultApi.getVaultPartUrls.mockImplementation(async (_csrf, _id, parts) => ({
      parts: parts.map(({ partNumber }: { partNumber: number }) => ({
        partNumber,
        url: `https://storage.invalid/part-${partNumber}`,
        contentLength: 8,
      })),
    }));
    const fetchMock = vi.fn(
      async () =>
        new Response(null, { status: 200, headers: { ETag: "etag" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    let releaseSecond: (() => void) | undefined;
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const client = createCryptoClient(() => 16);
    const originalStart = client.startEncryption.bind(client);
    vi.spyOn(client, "startEncryption").mockImplementation(async (input) => ({
      ...(await originalStart(input)),
      chunkCount: 2,
    }));
    vi.spyOn(client, "encryptChunk").mockImplementation(
      async (_session, index) => {
        if (index === 1) await second;
        return {
          ciphertext: new Uint8Array(8).fill(7).buffer,
          ciphertextBytes: 8,
        };
      },
    );
    const upload = runSelectionUpload(client, [
      new File([Uint8Array.of(1)], "rolling.bin"),
    ]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(vaultApi.publishVaultUpload).not.toHaveBeenCalled();
    releaseSecond?.();
    await upload;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refills PUT slots around a slow part and preserves checksums and completion order", async () => {
    vaultApi.initVaultUpload.mockResolvedValue({
      uploadId: "rolling",
      nodeId: "node-rolling.bin",
      mode: "multipart",
      partSizeBytes: 8,
    });
    vaultApi.getVaultPartUrls.mockImplementation(async (_csrf, _id, parts) => ({
      parts: parts.map(({ partNumber }: { partNumber: number }) => ({
        partNumber,
        url: `https://storage.invalid/part-${partNumber}`,
        contentLength: 8,
      })),
    }));
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const putParts: number[] = [];
    const bodies: Uint8Array[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const part = Number(String(url).split("-").at(-1));
        putParts.push(part);
        const body = new Uint8Array(
          init.body.buffer,
          init.body.byteOffset,
          init.body.byteLength,
        );
        bodies.push(body);
        if (part === 1) await first;
        expect(Array.from(body)).toEqual(Array(8).fill(7));
        return new Response(null, {
          status: 200,
          headers: { ETag: `etag-${part}` },
        });
      }),
    );
    const client = createCryptoClient(() => 48);
    const upload = runSelectionUpload(client, [
      new File([Uint8Array.of(1)], "rolling.bin"),
    ]);
    await vi.waitFor(() => expect(putParts).toContain(6));
    expect(vaultApi.publishVaultUpload).not.toHaveBeenCalled();
    releaseFirst?.();
    await upload;
    expect(
      vaultApi.publishVaultUpload.mock.calls[0]?.[2].map(
        (part: { partNumber: number }) => part.partNumber,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(bodies.every((body) => body.every((byte) => byte === 0))).toBe(true);
  });

  it("allows a small file to finish while a large file waits for final publication", async () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
    vaultApi.initVaultUpload.mockImplementation(async (_csrf, input) => ({
      uploadId: input.nodeId,
      nodeId: input.nodeId,
      mode: "single",
      partSizeBytes: null,
    }));
    vaultApi.getVaultContentUrl.mockImplementation(async (_csrf, id) => ({
      url: `https://storage.invalid/${id}`,
      contentLength: 1,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    let releaseLarge: (() => void) | undefined;
    const largePublication = new Promise<void>((resolve) => {
      releaseLarge = resolve;
    });
    let smallFinished = false;
    vaultApi.publishVaultUpload.mockImplementation(async (_csrf, id) => {
      if (id === "node-large.bin") await largePublication;
      else smallFinished = true;
      return {
        nodeId: id,
        generationNumber: 1,
        generationId: "g",
        recordVersion: 1,
        recordHash: "h",
        shareSyncRequired: false,
      };
    });
    const large = new File([Uint8Array.of(1)], "large.bin");
    Object.defineProperty(large, "size", { value: 9 * 1024 * 1024 });
    const upload = runSelectionUpload(
      createCryptoClient(() => 1),
      [large, new File([Uint8Array.of(1)], "small.bin")],
    );
    await vi.waitFor(() => expect(smallFinished).toBe(true));
    releaseLarge?.();
    await upload;
  });

  it("refreshes one expired part without changing its checksum or blocking other parts", async () => {
    vaultApi.initVaultUpload.mockResolvedValue({
      uploadId: "rolling",
      nodeId: "node-rolling.bin",
      mode: "multipart",
      partSizeBytes: 8,
    });
    vaultApi.getVaultPartUrls.mockImplementation(async (_csrf, _id, parts) => ({
      parts: parts.map(({ partNumber }: { partNumber: number }) => ({
        partNumber,
        url: `https://storage.invalid/part-${partNumber}`,
        contentLength: 8,
      })),
    }));
    vaultApi.getVaultPartUrl.mockResolvedValue({
      partNumber: 1,
      url: "https://storage.invalid/refreshed-1",
      contentLength: 8,
    });
    const fetchMock = vi.fn(async (url) =>
      String(url) === "https://storage.invalid/part-1"
        ? new Response("<Code>ExpiredToken</Code>", { status: 403 })
        : new Response(null, { status: 200, headers: { ETag: "etag" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await runSelectionUpload(
      createCryptoClient(() => 16),
      [new File([Uint8Array.of(1)], "rolling.bin")],
    );
    const firstPresign = vaultApi.getVaultPartUrls.mock.calls
      .flatMap((call) => call[2])
      .find((part) => part.partNumber === 1);
    expect(vaultApi.getVaultPartUrl).toHaveBeenCalledWith(
      "csrf",
      "rolling",
      1,
      firstPresign.checksumSha256,
      expect.any(AbortSignal),
    );
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
      "https://storage.invalid/refreshed-1",
    );
  });

  it("aborts sibling PUTs before clearing their bodies and cleans up the upload", async () => {
    vaultApi.initVaultUpload.mockResolvedValue({
      uploadId: "rolling",
      nodeId: "node-rolling.bin",
      mode: "multipart",
      partSizeBytes: 8,
    });
    vaultApi.getVaultPartUrls.mockImplementation(async (_csrf, _id, parts) => ({
      parts: parts.map(({ partNumber }: { partNumber: number }) => ({
        partNumber,
        url: `https://storage.invalid/part-${partNumber}`,
        contentLength: 8,
      })),
    }));
    const activeBodies: Uint8Array[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).endsWith("part-1"))
          return new Response(null, { status: 400 });
        const body = new Uint8Array(
          init.body.buffer,
          init.body.byteOffset,
          init.body.byteLength,
        );
        activeBodies.push(body);
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            expect(body.every((byte) => byte === 7)).toBe(true);
            reject(init.signal.reason);
          };
          init.signal.addEventListener("abort", abort, { once: true });
          if (init.signal.aborted) abort();
        });
      }),
    );
    const client = createCryptoClient(() => 48);
    const abortEncryption = vi.spyOn(client, "abortEncryption");
    await expect(
      runSelectionUpload(client, [new File([Uint8Array.of(1)], "rolling.bin")]),
    ).rejects.toThrow();
    expect(activeBodies.length).toBeGreaterThan(0);
    expect(activeBodies.every((body) => body.every((byte) => byte === 0))).toBe(
      true,
    );
    expect(abortEncryption).toHaveBeenCalledWith(
      "session-rolling.bin",
      "node-rolling.bin",
    );
    expect(vaultApi.abortVaultUpload).toHaveBeenCalledWith("csrf", "rolling");
    expect(vaultApi.publishVaultUpload).not.toHaveBeenCalled();
  });
});

function createCryptoClient(
  ciphertextLength: (fileName: string) => number,
): VaultCryptoClient {
  const lengths = new Map<string, number>();
  return {
    async startEncryption(input: VaultEncryptionInput) {
      const length = ciphertextLength(input.name);
      const sessionId = `session-${input.name}`;
      lengths.set(sessionId, length);
      return {
        sessionId,
        nodeId: `node-${input.name}`,
        generationNumber: 1,
        generationId: `generation-${input.name}`,
        recordVersion: 1,
        paddedBytes: length,
        ciphertextLength: length,
        chunkCount: 1,
      };
    },
    async encryptChunk(sessionId: string) {
      const length = lengths.get(sessionId);
      if (!length) throw new Error("Unknown encryption session.");
      return {
        ciphertext: new Uint8Array(length).fill(7).buffer,
        ciphertextBytes: length,
      };
    },
    async finalizeEncryption(sessionId: string) {
      const length = lengths.get(sessionId);
      if (!length) throw new Error("Unknown encryption session.");
      return {
        nodeId: sessionId.replace("session-", "node-"),
        generationNumber: 1,
        generationId: sessionId.replace("session-", "generation-"),
        recordVersion: 1,
        ciphertextLength: length,
        chunkCount: 1,
        record: emptyRecord,
      };
    },
    async abortEncryption() {},
  } as unknown as VaultCryptoClient;
}

function runSelectionUpload(client: VaultCryptoClient, files: File[]) {
  return uploadEncryptedSelections({
    selections: files.map((file) => ({ file, relativePath: file.name })),
    parentFolderId: null,
    csrfToken: "csrf",
    client,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    onFileStart: () => undefined,
    onFileComplete: () => undefined,
  });
}
