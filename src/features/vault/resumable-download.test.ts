import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VaultDownloadPlan } from "@/features/vault/protocol";
import {
  DOWNLOAD_STALL_TIMEOUT_MS,
  MAX_DOWNLOAD_RECOVERIES,
  ResumableDownload,
} from "@/features/vault/resumable-download";

const { renewPlan } = vi.hoisted(() => ({ renewPlan: vi.fn() }));
vi.mock("@/features/vault/vault-api", () => ({
  getVaultDownloadPlan: renewPlan,
}));

const plan = {
  nodeId: "node",
  entryType: "file",
  generationNumber: 1,
  generationId: "generation",
  ciphertextLength: 12,
  cryptoChunkBytes: 4,
  chunkCount: 3,
  ciphertextMerkleRoot: "root",
  downloadUrl: "https://storage.invalid/first-url",
} as VaultDownloadPlan;

beforeEach(() => {
  vi.useFakeTimers();
  renewPlan.mockReset().mockResolvedValue({
    ...plan,
    downloadUrl: "https://storage.invalid/renewed-url",
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function response(start: number, end = 11): Response {
  return new Response(
    Uint8Array.from({ length: end - start + 1 }, (_v, i) => start + i),
    {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/12`,
        ETag: '"immutable"',
      },
    },
  );
}

describe("encrypted download recovery", () => {
  it.each([0, 4, 8])(
    "restarts an interrupted chunk at byte %i without rereading completed chunks",
    async (boundary) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  Uint8Array.from({ length: boundary + 2 }, (_v, i) => i),
                );
                controller.close();
              },
            }),
            { headers: { ETag: '"immutable"' } },
          ),
        )
        .mockResolvedValueOnce(response(boundary));
      vi.stubGlobal("fetch", fetchMock);
      const download = new ResumableDownload(plan, 12);
      await download.open();
      const bytes: number[] = [];
      for (let offset = 0; offset < boundary; offset += 4) {
        bytes.push(...(await download.readChunk(4)));
      }
      const recovering = download.readChunk(4);
      await vi.advanceTimersByTimeAsync(2_000);
      bytes.push(...(await recovering));
      for (let offset = boundary + 4; offset < 12; offset += 4) {
        bytes.push(...(await download.readChunk(4)));
      }
      await download.finish();
      await download.cancel();
      expect(bytes).toEqual(Array.from({ length: 12 }, (_v, i) => i));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]).toMatchObject([
        "https://storage.invalid/renewed-url",
        { headers: { Range: `bytes=${boundary}-11` } },
      ]);
      expect(renewPlan).toHaveBeenCalledOnce();
    },
  );

  it("renews an expired URL and requires a validated range from zero", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(response(0));
    vi.stubGlobal("fetch", fetchMock);
    const download = new ResumableDownload(plan, 12);
    const opening = download.open();
    await vi.advanceTimersByTimeAsync(2_000);
    await opening;
    expect(await download.readChunk(12)).toHaveLength(12);
    await download.finish();
    await download.cancel();
    expect(fetchMock.mock.calls[1]?.[1].headers).toEqual({
      Range: "bytes=0-11",
    });
  });

  it.each([
    new Response(new Uint8Array(12), { status: 200 }),
    new Response(new Uint8Array(8), {
      status: 206,
      headers: { "Content-Range": "bytes 0-7/12" },
    }),
    new Response(new Uint8Array(8), {
      status: 206,
      headers: { "Content-Range": "bytes 4-11/13" },
    }),
  ])(
    "fails closed when a resumed response ignores or misstates the requested range",
    async (badResponse) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(new Response(Uint8Array.of(0, 1, 2, 3)))
          .mockResolvedValueOnce(badResponse),
      );
      const download = new ResumableDownload(plan, 12);
      await download.open();
      await download.readChunk(4);
      const failure = expect(download.readChunk(4)).rejects.toThrow(
        "invalid byte range",
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await failure;
      await download.cancel();
    },
  );

  it("rejects a changed generation before fetching the renewed URL", async () => {
    renewPlan.mockResolvedValue({ ...plan, generationId: "replacement" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(Uint8Array.of(0, 1, 2, 3)));
    vi.stubGlobal("fetch", fetchMock);
    const download = new ResumableDownload(plan, 12);
    await download.open();
    await download.readChunk(4);
    const failure = expect(download.readChunk(4)).rejects.toThrow(
      "generation changed",
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await failure;
    expect(fetchMock).toHaveBeenCalledOnce();
    await download.cancel();
  });

  it("rejects a changed storage ETag even if generation metadata stays the same", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(Uint8Array.of(0, 1, 2, 3), {
            headers: { ETag: '"previous"' },
          }),
        )
        .mockResolvedValueOnce(response(4)),
    );
    const download = new ResumableDownload(plan, 12);
    await download.open();
    await download.readChunk(4);
    const failure = expect(download.readChunk(4)).rejects.toThrow(
      "object changed",
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await failure;
    await download.cancel();
  });

  it("bounds failed recoveries across the entire download", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new TypeError("network offline"));
    vi.stubGlobal("fetch", fetchMock);
    const download = new ResumableDownload(plan, 12);
    const failure = expect(download.open()).rejects.toThrow("network offline");
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
    expect(fetchMock).toHaveBeenCalledTimes(MAX_DOWNLOAD_RECOVERIES + 1);
    expect(renewPlan).toHaveBeenCalledTimes(MAX_DOWNLOAD_RECOVERIES);
    await download.cancel();
  });

  it("recovers a stalled read without counting empty chunks as progress", async () => {
    const cancel = vi.fn();
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(body))
        .mockResolvedValueOnce(response(0)),
    );
    const download = new ResumableDownload(plan, 12);
    await download.open();
    const reading = download.readChunk(4);
    await vi.advanceTimersByTimeAsync(10_000);
    streamController?.enqueue(new Uint8Array());
    await vi.advanceTimersByTimeAsync(10_000);
    streamController?.enqueue(new Uint8Array());
    await vi.advanceTimersByTimeAsync(
      DOWNLOAD_STALL_TIMEOUT_MS - 20_000 + 2_000,
    );
    expect(await reading).toEqual(Uint8Array.of(0, 1, 2, 3));
    expect(cancel).toHaveBeenCalledOnce();
    await download.cancel();
  });

  it("allows a slow stream that continues making progress beyond the stall interval", async () => {
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
        ),
      ),
    );
    const download = new ResumableDownload(plan, 12);
    await download.open();
    const reading = download.readChunk(12);
    for (let index = 0; index < 12; index += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      streamController?.enqueue(Uint8Array.of(index));
    }
    streamController?.close();
    expect(await reading).toHaveLength(12);
    await download.finish();
    expect(renewPlan).not.toHaveBeenCalled();
    await download.cancel();
  });

  it("cancels a stalled read promptly without renewing authorization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new ReadableStream())),
    );
    const controller = new AbortController();
    const download = new ResumableDownload(plan, 12, controller.signal);
    await download.open();
    const failure = expect(download.readChunk(4)).rejects.toThrow("stop");
    controller.abort(new Error("stop"));
    await failure;
    await download.cancel();
    expect(renewPlan).not.toHaveBeenCalled();
  });
});
