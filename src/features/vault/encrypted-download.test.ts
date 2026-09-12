import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  downloadEncryptedFile,
  MAX_IN_MEMORY_DOWNLOAD_BYTES,
  readEncryptedFileBlob,
  readEncryptedFilePrefix,
  readEncryptedFileStream,
} from "@/features/vault/encrypted-download";
import {
  VAULT_CRYPTO_CHUNK_BYTES,
  type VaultDownloadPlan,
  type VaultManifest,
} from "@/features/vault/protocol";
import { recentTransferMetrics } from "@/features/vault/transfer-metrics";
import type { VaultCryptoClient } from "@/features/vault/vault-client";

const { renewPlan } = vi.hoisted(() => ({ renewPlan: vi.fn() }));
vi.mock("@/features/vault/vault-api", () => ({
  getVaultDownloadPlan: renewPlan,
}));

beforeEach(() => {
  renewPlan.mockReset().mockResolvedValue(testPlan(1));
});

const manifest: VaultManifest = {
  name: "fragmented.bin",
  mimeType: "application/octet-stream",
  entryType: "file",
  plaintextBytes: 2,
  paddedBytes: VAULT_CRYPTO_CHUNK_BYTES + 107,
  lastModified: 0,
  parentId: null,
  chunkCount: 2,
  generationId: new Uint8Array(16),
  createdAt: 0,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("encrypted download buffering", () => {
  it("assembles fragmented network reads into exact transferable chunks", async () => {
    const firstChunkBytes = VAULT_CRYPTO_CHUNK_BYTES + 16;
    const secondChunkBytes = 123;
    const ciphertext = new Uint8Array(firstChunkBytes + secondChunkBytes);
    ciphertext.fill(3, 0, firstChunkBytes);
    ciphertext.fill(9, firstChunkBytes);
    const networkChunkBytes = 64 * 1024;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (
          let offset = 0;
          offset < ciphertext.length;
          offset += networkChunkBytes
        ) {
          controller.enqueue(
            ciphertext.slice(
              offset,
              Math.min(ciphertext.length, offset + networkChunkBytes),
            ),
          );
        }
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const received: Uint8Array[] = [];
    let finalized = false;
    const client = {
      async startDecryption() {
        return { sessionId: "session", manifest };
      },
      async decryptChunk(
        _sessionId: string,
        chunkIndex: number,
        chunk: ArrayBuffer,
      ) {
        received.push(new Uint8Array(chunk));
        return {
          plaintext: Uint8Array.of(chunkIndex + 1).buffer,
          plaintextBytes: 1,
        };
      },
      async finalizeDecryption() {
        finalized = true;
      },
      async abortDecryption() {},
    } as unknown as VaultCryptoClient;
    const plan = {
      nodeId: "node",
      entryType: "file",
      generationNumber: 1,
      generationId: "generation",
      ciphertextLength: ciphertext.length,
      cryptoChunkBytes: VAULT_CRYPTO_CHUNK_BYTES,
      chunkCount: 2,
      ciphertextMerkleRoot: "root",
      downloadUrl: "https://storage.invalid/object",
      bootstrapCbor: "",
      bootstrapSignature: "",
      encryptedManifest: "",
      wrappers: [],
      signerKeyVersion: 1,
      signerEd25519PublicKey: "",
      recordVersion: 1,
      recordHash: "",
      share: null,
    } satisfies VaultDownloadPlan;

    const blob = await readEncryptedFileBlob({ plan, manifest, client });

    expect(received).toHaveLength(2);
    expect(received[0]).toHaveLength(firstChunkBytes);
    expect(received[0]?.[0]).toBe(3);
    expect(received[0]?.[firstChunkBytes - 1]).toBe(3);
    expect(received[1]).toHaveLength(secondChunkBytes);
    expect(received[1]?.[0]).toBe(9);
    expect(finalized).toBe(true);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      Uint8Array.of(1, 2),
    );
  });

  it("releases a decryption session that starts after the network fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    );
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const aborted: string[] = [];
    const client = {
      async startDecryption() {
        await startGate;
        return { sessionId: "late-session", manifest };
      },
      async abortDecryption(sessionId: string) {
        aborted.push(sessionId);
      },
    } as unknown as VaultCryptoClient;
    const plan = testPlan(1);

    const download = readEncryptedFileBlob({ plan, manifest, client });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    releaseStart?.();

    await expect(download).rejects.toThrow("network unavailable");
    expect(aborted).toEqual(["late-session"]);
  });

  it("aborts an active decryption session after bounded truncated-response retries", async () => {
    const truncatedPlan = testPlan(VAULT_CRYPTO_CHUNK_BYTES + 16);
    renewPlan.mockResolvedValue(truncatedPlan);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, options: RequestInit) =>
          new Response(new Uint8Array(1), {
            status: options.headers ? 206 : 200,
            headers: options.headers
              ? {
                  "Content-Range": `bytes 0-${truncatedPlan.ciphertextLength - 1}/${truncatedPlan.ciphertextLength}`,
                }
              : {},
          }),
      ),
    );
    const aborted: string[] = [];
    const client = {
      async startDecryption() {
        return { sessionId: "active-session", manifest };
      },
      async abortDecryption(sessionId: string) {
        aborted.push(sessionId);
      },
    } as unknown as VaultCryptoClient;

    await expect(
      readEncryptedFileBlob({
        plan: testPlan(VAULT_CRYPTO_CHUNK_BYTES + 16),
        manifest,
        client,
      }),
    ).rejects.toThrow("ended before all chunks arrived");
    expect(aborted).toEqual(["active-session"]);
  });

  it("rejects an unsafe large in-memory fallback before starting I/O", async () => {
    vi.stubGlobal("navigator", { storage: {} });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = {
      startDecryption: vi.fn(),
    } as unknown as VaultCryptoClient;

    await expect(
      downloadEncryptedFile({
        plan: testPlan(1),
        manifest: {
          ...manifest,
          chunkCount: 1,
          paddedBytes: 1,
          plaintextBytes: MAX_IN_MEMORY_DOWNLOAD_BYTES + 1,
        },
        client,
      }),
    ).rejects.toThrow("cannot stream this large download to disk");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.startDecryption).not.toHaveBeenCalled();
  });

  it("streams compatibility downloads through OPFS and removes the temp entry", async () => {
    vi.useFakeTimers();
    const writes: ArrayBuffer[] = [];
    const writable = {
      write: vi.fn(async (data: ArrayBuffer) => {
        writes.push(data);
      }),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const removeEntry = vi.fn(async () => undefined);
    const getFile = vi.fn(async () => new Blob(writes) as unknown as File);
    const getFileHandle = vi.fn(async () => ({
      createWritable: async () => writable,
      getFile,
    }));
    const getDirectory = vi.fn(async () => ({
      getFileHandle,
      removeEntry,
    }));
    vi.stubGlobal("navigator", { storage: { getDirectory } });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(Uint8Array.of(5), {
            status: 200,
          }),
      ),
    );
    const anchor = {
      href: "",
      download: "",
      rel: "",
      click: vi.fn(),
    };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
    });
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:aeralyth-test");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const client = {
      async startDecryption() {
        return { sessionId: "session", manifest };
      },
      async decryptChunk() {
        return { plaintext: Uint8Array.of(7).buffer, plaintextBytes: 1 };
      },
      async finalizeDecryption() {},
      async abortDecryption() {},
    } as unknown as VaultCryptoClient;

    await downloadEncryptedFile({
      plan: testPlan(1),
      manifest: {
        ...manifest,
        chunkCount: 1,
        paddedBytes: 1,
        plaintextBytes: 1,
      },
      client,
    });

    expect(writes.map((part) => Array.from(new Uint8Array(part)))).toEqual([
      [7],
    ]);
    expect(writable.close).toHaveBeenCalledOnce();
    expect(getFile).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchor.download).toBe("fragmented.bin");
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(removeEntry).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:aeralyth-test");
    expect(removeEntry).toHaveBeenCalledOnce();
  });

  it("bounds archive streams to one queued chunk and one decrypted lookahead", async () => {
    const ciphertextLength = 2 * (VAULT_CRYPTO_CHUNK_BYTES + 16) + 1;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(ciphertextLength), {
            status: 200,
          }),
      ),
    );
    const streamManifest: VaultManifest = {
      ...manifest,
      plaintextBytes: 3,
      paddedBytes: 3,
      chunkCount: 3,
    };
    const decryptChunk = vi.fn(
      async (_sessionId: string, chunkIndex: number) => ({
        plaintext: Uint8Array.of(chunkIndex + 10).buffer,
        plaintextBytes: 1,
      }),
    );
    const client = {
      async startDecryption() {
        return { sessionId: "stream-session", manifest: streamManifest };
      },
      decryptChunk,
      async finalizeDecryption() {},
      async abortDecryption() {},
    } as unknown as VaultCryptoClient;
    const stream = readEncryptedFileStream({
      plan: { ...testPlan(ciphertextLength), chunkCount: 3 },
      manifest: streamManifest,
      client,
    });
    const reader = stream.getReader();

    expect(await reader.read()).toMatchObject({
      done: false,
      value: Uint8Array.of(10),
    });
    await vi.waitFor(() => expect(decryptChunk).toHaveBeenCalledTimes(3));
    expect(decryptChunk).toHaveBeenCalledTimes(3);
    expect(await reader.read()).toMatchObject({
      done: false,
      value: Uint8Array.of(11),
    });
    await vi.waitFor(() => expect(decryptChunk).toHaveBeenCalledTimes(3));
    expect(await reader.read()).toMatchObject({
      done: false,
      value: Uint8Array.of(12),
    });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it("fetches only complete authenticated chunks for a bounded preview and marks verification partial", async () => {
    const encryptedChunkBytes = VAULT_CRYPTO_CHUNK_BYTES + 16;
    const prefixPlan = { ...testPlan(encryptedChunkBytes * 3), chunkCount: 3 };
    const prefixManifest = {
      ...manifest,
      plaintextBytes: VAULT_CRYPTO_CHUNK_BYTES * 3,
      paddedBytes: VAULT_CRYPTO_CHUNK_BYTES * 3,
      chunkCount: 3,
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(new Uint8Array(encryptedChunkBytes), {
          status: 206,
          headers: {
            "Content-Range": `bytes 0-${encryptedChunkBytes - 1}/${prefixPlan.ciphertextLength}`,
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const plaintext = Uint8Array.from(
      { length: VAULT_CRYPTO_CHUNK_BYTES },
      (_v, i) => i % 256,
    );
    const client = {
      startDecryption: vi.fn(async () => ({
        sessionId: "prefix-session",
        manifest: prefixManifest,
      })),
      decryptChunk: vi.fn(async () => ({
        plaintext: plaintext.buffer,
        plaintextBytes: plaintext.length,
      })),
      abortDecryption: vi.fn(async () => undefined),
      finalizeDecryption: vi.fn(async () => undefined),
    };
    const result = await readEncryptedFilePrefix({
      plan: prefixPlan,
      manifest: prefixManifest,
      client: client as unknown as VaultCryptoClient,
      maxPlaintextBytes: 2 * 1024 * 1024,
    });
    expect(result.verification).toBe("partial");
    expect(result.blob.size).toBe(2 * 1024 * 1024);
    expect(new Uint8Array(await result.blob.slice(0, 3).arrayBuffer())).toEqual(
      Uint8Array.of(0, 1, 2),
    );
    expect(plaintext.every((value) => value === 0)).toBe(true);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Range: `bytes=0-${encryptedChunkBytes - 1}` },
    });
    expect(client.decryptChunk).toHaveBeenCalledOnce();
    expect(client.finalizeDecryption).not.toHaveBeenCalled();
    expect(client.abortDecryption).toHaveBeenCalledWith("prefix-session");
  });

  it("verifies the full Merkle root for a preview that needs the complete file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Uint8Array.of(1))),
    );
    const client = {
      startDecryption: vi.fn(async () => ({ sessionId: "session", manifest })),
      decryptChunk: vi.fn(async () => ({
        plaintext: Uint8Array.of(9).buffer,
        plaintextBytes: 1,
      })),
      abortDecryption: vi.fn(async () => undefined),
      finalizeDecryption: vi.fn(async () => undefined),
    };
    const result = await readEncryptedFilePrefix({
      plan: testPlan(1),
      manifest: { ...manifest, plaintextBytes: 1, chunkCount: 1 },
      client: client as unknown as VaultCryptoClient,
      maxPlaintextBytes: 1024,
    });
    expect(result.verification).toBe("full");
    expect(client.finalizeDecryption).toHaveBeenCalledOnce();
    expect(client.abortDecryption).not.toHaveBeenCalled();
  });

  it("overlaps one ordered decryption with a slow sink without growing the pipeline", async () => {
    const cipherBytes = 3 * (VAULT_CRYPTO_CHUNK_BYTES + 16);
    const sinkGate = Promise.withResolvers<void>();
    const writes: number[] = [];
    const writable = {
      write: vi.fn(async (data: ArrayBuffer) => {
        writes.push(new Uint8Array(data)[0] ?? -1);
        if (writes.length === 1) await sinkGate.promise;
      }),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    vi.stubGlobal("showSaveFilePicker", async () => ({
      createWritable: async () => writable,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(cipherBytes))),
    );
    let activeDecryptions = 0;
    let maxActiveDecryptions = 0;
    const client = {
      startDecryption: vi.fn(async () => ({ sessionId: "session", manifest })),
      decryptChunk: vi.fn(async (_session: string, index: number) => {
        activeDecryptions += 1;
        maxActiveDecryptions = Math.max(
          maxActiveDecryptions,
          activeDecryptions,
        );
        await Promise.resolve();
        activeDecryptions -= 1;
        return { plaintext: Uint8Array.of(index).buffer, plaintextBytes: 1 };
      }),
      abortDecryption: vi.fn(async () => undefined),
      finalizeDecryption: vi.fn(async () => undefined),
    };
    const download = downloadEncryptedFile({
      plan: { ...testPlan(cipherBytes), chunkCount: 3 },
      manifest,
      client: client as unknown as VaultCryptoClient,
    });
    await vi.waitFor(() =>
      expect(client.decryptChunk).toHaveBeenCalledTimes(2),
    );
    expect(writes).toEqual([0]);
    expect(client.decryptChunk).toHaveBeenCalledTimes(2);
    sinkGate.resolve();
    await download;
    expect(writes).toEqual([0, 1, 2]);
    expect(maxActiveDecryptions).toBe(1);
    expect(client.finalizeDecryption).toHaveBeenCalledOnce();
    expect(writable.close).toHaveBeenCalledOnce();
  });

  it("propagates a parent abort while the archive sink is backpressured", async () => {
    const cipherBytes = 3 * (VAULT_CRYPTO_CHUNK_BYTES + 16);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(cipherBytes))),
    );
    const client = {
      startDecryption: vi.fn(async () => ({ sessionId: "session", manifest })),
      decryptChunk: vi.fn(async () => ({
        plaintext: Uint8Array.of(1).buffer,
        plaintextBytes: 1,
      })),
      abortDecryption: vi.fn(async () => undefined),
      finalizeDecryption: vi.fn(async () => undefined),
    };
    const operation = new AbortController();
    const stream = readEncryptedFileStream({
      plan: { ...testPlan(cipherBytes), chunkCount: 3 },
      manifest,
      client: client as unknown as VaultCryptoClient,
      signal: operation.signal,
    });
    await vi.waitFor(() =>
      expect(client.decryptChunk).toHaveBeenCalledTimes(2),
    );
    operation.abort(new Error("stop"));
    await vi.waitFor(() =>
      expect(client.abortDecryption).toHaveBeenCalledOnce(),
    );
    await expect(stream.getReader().read()).rejects.toThrow("stop");
    expect(client.finalizeDecryption).not.toHaveBeenCalled();
  });

  it("keeps final authentication after losing EOF at the final ciphertext boundary", async () => {
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  if (reads++ === 0) controller.enqueue(Uint8Array.of(1));
                  else
                    controller.error(
                      new TypeError("connection lost after last byte"),
                    );
                },
              },
              { highWaterMark: 0 },
            ),
          ),
      ),
    );
    const client = {
      startDecryption: vi.fn(async () => ({ sessionId: "session", manifest })),
      decryptChunk: vi.fn(async () => ({
        plaintext: Uint8Array.of(7).buffer,
        plaintextBytes: 1,
      })),
      abortDecryption: vi.fn(async () => undefined),
      finalizeDecryption: vi.fn(async () => undefined),
    };
    const blob = await readEncryptedFileBlob({
      plan: testPlan(1),
      manifest,
      client: client as unknown as VaultCryptoClient,
    });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(Uint8Array.of(7));
    expect(client.finalizeDecryption).toHaveBeenCalledOnce();
    expect(renewPlan).not.toHaveBeenCalled();
  });

  it("fails on trailing ciphertext before publishing a completed download", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Uint8Array.of(1, 2))),
    );
    const client = {
      startDecryption: vi.fn(async () => ({ sessionId: "session", manifest })),
      decryptChunk: vi.fn(async () => ({
        plaintext: Uint8Array.of(7).buffer,
        plaintextBytes: 1,
      })),
      abortDecryption: vi.fn(async () => undefined),
      finalizeDecryption: vi.fn(async () => undefined),
    };
    await expect(
      readEncryptedFileBlob({
        plan: testPlan(1),
        manifest,
        client: client as unknown as VaultCryptoClient,
      }),
    ).rejects.toThrow("unexpected trailing data");
    expect(client.finalizeDecryption).not.toHaveBeenCalled();
    expect(client.abortDecryption).toHaveBeenCalledOnce();
  });

  it("aborts partial disk output and wipes abandoned plaintext after a sink failure", async () => {
    const bytes = 3 * (VAULT_CRYPTO_CHUNK_BYTES + 16);
    const gate = Promise.withResolvers<void>();
    const writable = {
      write: vi.fn(async () => {
        await gate.promise;
        throw new Error("disk full");
      }),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    vi.stubGlobal("showSaveFilePicker", async () => ({
      createWritable: async () => writable,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(bytes))),
    );
    const plaintexts: Uint8Array[] = [];
    const client = {
      startDecryption: vi.fn(async () => ({ sessionId: "session", manifest })),
      decryptChunk: vi.fn(async () => {
        const plaintext = Uint8Array.of(123);
        plaintexts.push(plaintext);
        return { plaintext: plaintext.buffer, plaintextBytes: 1 };
      }),
      abortDecryption: vi.fn(async () => undefined),
      finalizeDecryption: vi.fn(async () => undefined),
    };
    const failure = expect(
      downloadEncryptedFile({
        plan: { ...testPlan(bytes), chunkCount: 3 },
        manifest,
        client: client as unknown as VaultCryptoClient,
      }),
    ).rejects.toThrow("disk full");
    await vi.waitFor(() =>
      expect(client.decryptChunk).toHaveBeenCalledTimes(2),
    );
    gate.resolve();
    await failure;
    expect(plaintexts).toHaveLength(2);
    expect(plaintexts.every((value) => value[0] === 0)).toBe(true);
    expect(writable.close).not.toHaveBeenCalled();
    expect(writable.abort).toHaveBeenCalledOnce();
    expect(client.abortDecryption).toHaveBeenCalledOnce();
    expect(recentTransferMetrics().at(-1)?.outcome).toBe("failed");
  });

  it.each([
    ["network", 30, 1, 1],
    ["crypto", 1, 30, 1],
    ["disk", 1, 1, 30],
    ["balanced", 10, 10, 10],
  ] as const)(
    "reduces controlled %s-limited stage latency against a serial baseline",
    async (_name, networkMs, cryptoMs, sinkMs) => {
      vi.useFakeTimers();
      vi.spyOn(performance, "now").mockImplementation(() => Date.now());
      const pause = (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms));
      const chunkBytes = VAULT_CRYPTO_CHUNK_BYTES + 16;
      const chunks = 4;
      let produced = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>(
                {
                  async pull(controller) {
                    if (produced === chunks) {
                      controller.close();
                      return;
                    }
                    await pause(networkMs);
                    controller.enqueue(new Uint8Array(chunkBytes));
                    produced += 1;
                  },
                },
                { highWaterMark: 0 },
              ),
            ),
        ),
      );
      vi.stubGlobal("showSaveFilePicker", async () => ({
        createWritable: async () => ({
          write: async () => pause(sinkMs),
          close: async () => undefined,
          abort: async () => undefined,
        }),
      }));
      const client = {
        startDecryption: async () => ({ sessionId: "session", manifest }),
        decryptChunk: async () => {
          await pause(cryptoMs);
          return { plaintext: Uint8Array.of(1).buffer, plaintextBytes: 1 };
        },
        abortDecryption: async () => undefined,
        finalizeDecryption: async () => undefined,
      };
      const started = Date.now();
      let elapsed = 0;
      const download = downloadEncryptedFile({
        plan: { ...testPlan(chunks * chunkBytes), chunkCount: chunks },
        manifest,
        client: client as unknown as VaultCryptoClient,
      }).then(() => {
        elapsed = Date.now() - started;
      });
      await vi.runAllTimersAsync();
      await download;
      const serialMs = chunks * (networkMs + cryptoMs + sinkMs);
      expect(elapsed).toBeLessThan(serialMs);
      if (_name === "balanced") expect(elapsed).toBe(60);
      const metric = recentTransferMetrics().at(-1);
      expect(metric?.ciphertextBytes).toBe(chunks * chunkBytes);
      expect(metric?.stages.decrypt.durationMs).toBe(chunks * cryptoMs);
      expect(metric?.stages.sink.durationMs).toBe(chunks * sinkMs);
      expect(metric?.outcome).toBe("completed");
    },
  );

  it("keeps the worker and sink in order while resuming only the interrupted crypto chunk", async () => {
    vi.useFakeTimers();
    const chunkBytes = VAULT_CRYPTO_CHUNK_BYTES + 16;
    const resumePlan = { ...testPlan(chunkBytes * 3), chunkCount: 3 };
    renewPlan.mockResolvedValue({
      ...resumePlan,
      downloadUrl: "https://storage.invalid/renewed",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Uint8Array(chunkBytes + 8)))
      .mockResolvedValueOnce(
        new Response(new Uint8Array(chunkBytes * 2), {
          status: 206,
          headers: {
            "Content-Range": `bytes ${chunkBytes}-${resumePlan.ciphertextLength - 1}/${resumePlan.ciphertextLength}`,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const indices: number[] = [];
    const client = {
      startDecryption: vi.fn(async () => ({ sessionId: "session", manifest })),
      decryptChunk: vi.fn(async (_session: string, index: number) => {
        indices.push(index);
        return {
          plaintext: Uint8Array.of(index + 1).buffer,
          plaintextBytes: 1,
        };
      }),
      finalizeDecryption: vi.fn(async () => undefined),
      abortDecryption: vi.fn(async () => undefined),
    };
    const downloading = readEncryptedFileBlob({
      plan: resumePlan,
      manifest,
      client: client as unknown as VaultCryptoClient,
    });
    await vi.runAllTimersAsync();
    const blob = await downloading;
    expect(indices).toEqual([0, 1, 2]);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      Uint8Array.of(1, 2, 3),
    );
    expect(client.startDecryption).toHaveBeenCalledOnce();
    expect(client.finalizeDecryption).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[1]?.[1].headers.Range).toBe(
      `bytes=${chunkBytes}-${resumePlan.ciphertextLength - 1}`,
    );
    expect(recentTransferMetrics().at(-1)?.ciphertextBytes).toBe(
      resumePlan.ciphertextLength + 8,
    );
  });

  it("does not close disk output when final Merkle verification fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Uint8Array.of(1))),
    );
    const writable = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    vi.stubGlobal("showSaveFilePicker", async () => ({
      createWritable: async () => writable,
    }));
    const client = {
      startDecryption: vi.fn(async () => ({ sessionId: "session", manifest })),
      decryptChunk: vi.fn(async () => ({
        plaintext: Uint8Array.of(7).buffer,
        plaintextBytes: 1,
      })),
      abortDecryption: vi.fn(async () => undefined),
      finalizeDecryption: vi.fn(async () => {
        throw new Error("Merkle root invalid");
      }),
    };
    await expect(
      downloadEncryptedFile({
        plan: testPlan(1),
        manifest,
        client: client as unknown as VaultCryptoClient,
      }),
    ).rejects.toThrow("Merkle root invalid");
    expect(writable.write).toHaveBeenCalledOnce();
    expect(writable.close).not.toHaveBeenCalled();
    expect(writable.abort).toHaveBeenCalledOnce();
    expect(recentTransferMetrics().at(-1)?.outcome).toBe("failed");
  });

  it("does not publish an OPFS result or report completion after cancellation during close", async () => {
    const closing = Promise.withResolvers<void>();
    const writable = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => closing.promise),
      abort: vi.fn(async () => undefined),
    };
    const getFile = vi.fn(async () => new Blob());
    const removeEntry = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: async () => ({
          getFileHandle: async () => ({
            createWritable: async () => writable,
            getFile,
          }),
          removeEntry,
        }),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Uint8Array.of(1))),
    );
    const client = {
      startDecryption: vi.fn(async () => ({ sessionId: "session", manifest })),
      decryptChunk: vi.fn(async () => ({
        plaintext: Uint8Array.of(7).buffer,
        plaintextBytes: 1,
      })),
      abortDecryption: vi.fn(async () => undefined),
      finalizeDecryption: vi.fn(async () => undefined),
    };
    const controller = new AbortController();
    const onProgress = vi.fn();
    const failure = expect(
      downloadEncryptedFile({
        plan: testPlan(1),
        manifest,
        client: client as unknown as VaultCryptoClient,
        signal: controller.signal,
        onProgress,
      }),
    ).rejects.toThrow("stop before publication");
    await vi.waitFor(() => expect(writable.close).toHaveBeenCalledOnce());
    controller.abort(new Error("stop before publication"));
    closing.resolve();
    await failure;
    expect(getFile).not.toHaveBeenCalled();
    expect(removeEntry).toHaveBeenCalledOnce();
    expect(onProgress).not.toHaveBeenCalledWith(100);
    expect(recentTransferMetrics().at(-1)?.outcome).toBe("canceled");
  });

  it("does not return a Blob after cancellation during final verification", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Uint8Array.of(1))),
    );
    const verification = Promise.withResolvers<void>();
    const client = {
      startDecryption: vi.fn(async () => ({ sessionId: "session", manifest })),
      decryptChunk: vi.fn(async () => ({
        plaintext: Uint8Array.of(7).buffer,
        plaintextBytes: 1,
      })),
      abortDecryption: vi.fn(async () => undefined),
      finalizeDecryption: vi.fn(async () => verification.promise),
    };
    const controller = new AbortController();
    const failure = expect(
      readEncryptedFileBlob({
        plan: testPlan(1),
        manifest,
        client: client as unknown as VaultCryptoClient,
        signal: controller.signal,
      }),
    ).rejects.toThrow("stop verifying");
    await vi.waitFor(() =>
      expect(client.finalizeDecryption).toHaveBeenCalledOnce(),
    );
    controller.abort(new Error("stop verifying"));
    verification.resolve();
    await failure;
    expect(recentTransferMetrics().at(-1)?.outcome).toBe("canceled");
  });
});

function testPlan(ciphertextLength: number): VaultDownloadPlan {
  return {
    nodeId: "node",
    entryType: "file",
    generationNumber: 1,
    generationId: "generation",
    ciphertextLength,
    cryptoChunkBytes: VAULT_CRYPTO_CHUNK_BYTES,
    chunkCount: 1,
    ciphertextMerkleRoot: "root",
    downloadUrl: "https://storage.invalid/object",
    bootstrapCbor: "",
    bootstrapSignature: "",
    encryptedManifest: "",
    wrappers: [],
    signerKeyVersion: 1,
    signerEd25519PublicKey: "",
    recordVersion: 1,
    recordHash: "",
    share: null,
  };
}
