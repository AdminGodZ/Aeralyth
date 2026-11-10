import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BlobReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { instantiateRawDeflater } from "@/features/archive/raw-deflate";
import {
  createFolderZipArchive,
  type FolderZipEnvironment,
  type FolderZipHelperListener,
  type FolderZipHelperPort,
  type FolderZipProgress,
} from "@/features/dashboard/folder-zip-archive";
import type { FolderZipSource } from "@/features/dashboard/folder-zip-messages";
import {
  type FolderZipHelperRequest,
  type FolderZipTaskContext,
  runFolderZipTask,
} from "@/features/dashboard/folder-zip-tasks";
import { ZIP_ARCHIVE_SAFETY_LIMIT_ERROR } from "@/features/dashboard/zip-archive-limit";

const MEBIBYTE = 1024 * 1024;
const lastModified = Date.UTC(2026, 5, 15, 12, 30, 45);

async function loadWasm() {
  const bytes = await readFile(
    fileURLToPath(import.meta.resolve("@zip.js/zip.js/dist/zip-module.wasm")),
  );
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function text(length: number, salt = 0) {
  const words = ["const", "value", "return", "archive", "entry", "=>", "{}"];
  let output = "";
  for (let index = salt; output.length < length; index++) {
    output += `${words[(index * 7) % words.length]} ${index % 97} `;
  }
  return new TextEncoder().encode(output.slice(0, length));
}

function random(length: number, seed: number) {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

type Fixture = {
  sources: FolderZipSource[];
  expected: Array<{ path: string; content: Uint8Array | null }>;
};

function fixture(
  files: Array<[path: string, content: Uint8Array | null, type?: string]>,
): Fixture {
  return {
    sources: files.map(([path, content, type = ""]) =>
      content === null
        ? { directory: true, path, lastModified }
        : {
            path,
            file: new File(
              [new Uint8Array(content)],
              path.split("/").at(-1) ?? path,
              {
                type,
                lastModified,
              },
            ),
          },
    ),
    expected: files.map(([path, content]) => ({
      path: content === null ? `${path}/` : path,
      content,
    })),
  };
}

/** Small and large, compressible and not, so every kind of task runs. */
function mixedFixture() {
  return fixture([
    ["project", null],
    ["project/readme.md", text(3_000), "text/markdown"],
    ["project/empty.txt", new Uint8Array(0), "text/plain"],
    ["project/Grüße/日本語.txt", text(700, 3), "text/plain"],
    ["project/icon.png", random(20_000, 1), "image/png"],
    ["project/photo.jpg", random(1.5 * MEBIBYTE, 2), "image/jpeg"],
    ["project/big.log", text(5 * MEBIBYTE + 123, 5), "text/plain"],
    ["project/src/a.ts", text(40_000, 7), ""],
    ["project/movie.mp4", random(4.5 * MEBIBYTE, 3), "video/mp4"],
    ["project/noise.dat", random(4.2 * MEBIBYTE, 4), ""],
    ["project/src/b.ts", text(900, 9), ""],
    ["project/medium-noise.bin", random(700_000, 5), ""],
  ]);
}

async function readArchive(archive: Blob) {
  const reader = new ZipReader(new BlobReader(archive), {
    useWebWorkers: false,
  });
  try {
    const entries = await reader.getEntries();
    return await Promise.all(
      entries.map(async (entry) => ({
        path: entry.filename,
        method: entry.compressionMethod,
        compressedSize: entry.compressedSize,
        dataDescriptor: entry.bitFlag?.dataDescriptor,
        lastModified: entry.lastModDate.getTime(),
        content: entry.directory
          ? null
          : await entry.getData(new Uint8ArrayWriter(), {
              checkSignature: true,
            }),
      })),
    );
  } finally {
    await reader.close();
  }
}

async function expectArchive(archive: Blob, { expected }: Fixture) {
  expect(archive.type).toBe("application/zip");
  const read = await readArchive(archive);
  expect(read.map((entry) => entry.path)).toEqual(
    expected.map((entry) => entry.path),
  );
  for (const [index, entry] of read.entries()) {
    const { content } = expected[index];
    if (content === null) expect(entry.content).toBeNull();
    else expect(Buffer.compare(entry.content as Uint8Array, content)).toBe(0);
    expect(entry.dataDescriptor).toBe(false);
    expect(entry.lastModified).toBe(lastModified);
  }
  return Object.fromEntries(read.map((entry) => [entry.path, entry]));
}

type FakeHelperBehavior = {
  /** Fails instead of answering, after this many completed tasks. */
  crashAfterTasks?: number;
  /** Never answers at all, like a script that fails to load. */
  silent?: boolean;
};

/** Runs the helper protocol in-process, without worker threads. */
function fakeHelpers(behaviors: FakeHelperBehavior[] = []) {
  const state = { spawned: 0, terminated: 0, tasks: [] as number[] };
  const spawnHelper = (
    listener: FolderZipHelperListener,
  ): FolderZipHelperPort => {
    const index = state.spawned++;
    const behavior = behaviors[index] ?? {};
    let alive = true;
    let completed = 0;
    let context: Promise<FolderZipTaskContext> | null = null;
    state.tasks[index] = 0;
    const handle = async (message: FolderZipHelperRequest) => {
      if (behavior.silent) return;
      if (message.type === "helper-init") {
        context = (async () => ({
          deflater: message.wasm
            ? await instantiateRawDeflater(message.wasm)
            : null,
          nativeDeflate: message.nativeDeflate,
          emitPart: (id: number, part: ArrayBuffer) => {
            if (alive) listener.message({ type: "helper-part", id, part });
          },
        }))();
        await context;
        if (alive) listener.message({ type: "helper-ready" });
        return;
      }
      if (completed === behavior.crashAfterTasks) {
        alive = false;
        listener.failure();
        return;
      }
      try {
        const { result } = await runFolderZipTask(
          message.task,
          await (context as Promise<FolderZipTaskContext>),
        );
        completed += 1;
        state.tasks[index] += 1;
        if (alive) listener.message({ type: "helper-result", result });
      } catch (error) {
        if (alive) {
          listener.message({
            type: "helper-error",
            id: message.task.id,
            message: (error as Error).message,
          });
        }
      }
    };
    return {
      post(message) {
        setTimeout(() => void handle(message), 0);
      },
      terminate() {
        if (alive) state.terminated += 1;
        alive = false;
      },
    };
  };
  return { state, spawnHelper };
}

function environment(
  overrides: Partial<FolderZipEnvironment> = {},
): FolderZipEnvironment {
  return { hardwareConcurrency: 4, loadWasm, ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("folder ZIP archive", () => {
  it("builds a valid archive inline, in source order", async () => {
    const files = mixedFixture();
    const archive = await createFolderZipArchive(
      { type: "compress", sources: files.sources, compressionMode: "speed" },
      { environment: environment() },
    );
    const entries = await expectArchive(archive, files);

    expect(entries["project/readme.md"].method).toBe(8);
    expect(entries["project/big.log"].method).toBe(8);
    expect(entries["project/big.log"].compressedSize).toBeLessThan(MEBIBYTE);
    // Known incompressible types are stored without being deflated.
    expect(entries["project/icon.png"].method).toBe(0);
    expect(entries["project/photo.jpg"].method).toBe(0);
    expect(entries["project/movie.mp4"].method).toBe(0);
    // Unknown types that do not compress fall back to stored data, either as
    // a stored entry or as stored blocks inside a deflate stream.
    expect(entries["project/medium-noise.bin"].method).toBe(0);
    expect(entries["project/noise.dat"].method).toBe(8);
    expect(entries["project/noise.dat"].compressedSize).toBeLessThan(
      4.2 * MEBIBYTE * 1.001,
    );
  });

  it("builds the same archive with helper workers", async () => {
    const files = mixedFixture();
    const request = {
      type: "compress",
      sources: files.sources,
      compressionMode: "speed",
    } as const;
    const inline = await createFolderZipArchive(request, {
      environment: environment(),
    });
    const { state, spawnHelper } = fakeHelpers();
    const parallel = await createFolderZipArchive(request, {
      environment: environment({ spawnHelper }),
    });

    await expectArchive(parallel, files);
    expect(state.spawned).toBe(4);
    expect(state.terminated).toBe(4);
    expect(state.tasks.every((count) => count > 0)).toBe(true);
    // The archive bytes do not depend on which helper finished first.
    expect(
      Buffer.compare(
        new Uint8Array(await parallel.arrayBuffer()),
        new Uint8Array(await inline.arrayBuffer()),
      ),
    ).toBe(0);
  });

  it("limits helpers to the requested worker count", async () => {
    const files = mixedFixture();
    const { state, spawnHelper } = fakeHelpers();
    await createFolderZipArchive(
      { type: "compress", sources: files.sources, maxWorkers: 2 },
      { environment: environment({ hardwareConcurrency: 16, spawnHelper }) },
    );
    expect(state.spawned).toBe(2);
  });

  it("uses the higher compression level in balanced mode", async () => {
    const files = fixture([["a.txt", text(600_000), "text/plain"]]);
    const sizes = await Promise.all(
      (["speed", "balanced"] as const).map(async (compressionMode) => {
        const archive = await createFolderZipArchive(
          { type: "compress", sources: files.sources, compressionMode },
          { environment: environment() },
        );
        await expectArchive(archive, files);
        return archive.size;
      }),
    );
    expect(sizes[1]).toBeLessThan(sizes[0]);
  });

  it("falls back to CompressionStream when the zlib module cannot load", async () => {
    const files = mixedFixture();
    for (const spawnHelper of [undefined, fakeHelpers().spawnHelper]) {
      const archive = await createFolderZipArchive(
        { type: "compress", sources: files.sources, compressionMode: "speed" },
        {
          environment: environment({
            loadWasm: () => Promise.reject(new Error("offline")),
            ...(spawnHelper ? { spawnHelper } : {}),
          }),
        },
      );
      const entries = await expectArchive(archive, files);
      expect(entries["project/readme.md"].method).toBe(8);
      expect(entries["project/big.log"].method).toBe(8);
      expect(entries["project/big.log"].compressedSize).toBeLessThan(MEBIBYTE);
      expect(entries["project/movie.mp4"].method).toBe(0);
    }
  });

  it("stores every entry when no deflate implementation is available", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const files = mixedFixture();
    const archive = await createFolderZipArchive(
      { type: "compress", sources: files.sources },
      { environment: environment({ loadWasm: undefined }) },
    );
    const entries = await expectArchive(archive, files);
    expect(Object.values(entries).every((entry) => entry.method === 0)).toBe(
      true,
    );
  });

  it("reports monotonic progress that ends at the total", async () => {
    const files = mixedFixture();
    const total = files.expected.reduce(
      (sum, entry) => sum + (entry.content?.length ?? 0),
      0,
    );
    for (const spawnHelper of [undefined, fakeHelpers().spawnHelper]) {
      const progress: FolderZipProgress[] = [];
      await createFolderZipArchive(
        { type: "compress", sources: files.sources },
        {
          onProgress: (update) => progress.push(update),
          environment: environment(spawnHelper ? { spawnHelper } : {}),
        },
      );
      expect(progress[0]).toEqual({
        type: "progress",
        processedBytes: 0,
        totalBytes: total,
        currentPath: "",
      });
      expect(progress.at(-1)?.processedBytes).toBe(total);
      expect(progress.length).toBeGreaterThan(5);
      for (let index = 1; index < progress.length; index++) {
        expect(progress[index].totalBytes).toBe(total);
        expect(progress[index].processedBytes).toBeGreaterThanOrEqual(
          progress[index - 1].processedBytes,
        );
      }
    }
  });

  it("repeats the task of a helper that dies and finishes with the others", async () => {
    const files = mixedFixture();
    const { state, spawnHelper } = fakeHelpers([
      { crashAfterTasks: 1 },
      { crashAfterTasks: 0 },
    ]);
    const archive = await createFolderZipArchive(
      { type: "compress", sources: files.sources, compressionMode: "speed" },
      { environment: environment({ spawnHelper }) },
    );
    await expectArchive(archive, files);
    expect(state.tasks[0]).toBe(1);
    expect(state.tasks[1]).toBe(0);
    expect(state.tasks[2] + state.tasks[3]).toBeGreaterThan(2);
  });

  it("repeats a streamed entry from the start when its helper dies", async () => {
    const files = fixture([["big.log", text(6 * MEBIBYTE), "text/plain"]]);
    const more = fixture([
      ["big.log", text(6 * MEBIBYTE), "text/plain"],
      ["other.log", text(3 * MEBIBYTE, 4), "text/plain"],
    ]);
    for (const input of [files, more]) {
      const { spawnHelper } = fakeHelpers([{ crashAfterTasks: 0 }]);
      const archive = await createFolderZipArchive(
        { type: "compress", sources: input.sources, compressionMode: "speed" },
        {
          environment: environment({
            spawnHelper,
            loadWasm: () => Promise.reject(new Error("offline")),
          }),
        },
      );
      await expectArchive(archive, input);
    }
  });

  it("finishes inline when no helper starts", async () => {
    const files = mixedFixture();
    const failing: FolderZipEnvironment["spawnHelper"] = () => {
      throw new Error("blocked");
    };
    const { spawnHelper: silent } = fakeHelpers(
      Array.from({ length: 4 }, () => ({ silent: true })),
    );
    const crashing = fakeHelpers(
      Array.from({ length: 4 }, () => ({ crashAfterTasks: 0 })),
    ).spawnHelper;
    for (const spawnHelper of [failing, silent, crashing]) {
      const archive = await createFolderZipArchive(
        { type: "compress", sources: files.sources, compressionMode: "speed" },
        {
          environment: environment({ spawnHelper, helperStartupTimeoutMs: 20 }),
        },
      );
      await expectArchive(archive, files);
    }
  });

  it("fails with the path of a source that cannot be read", async () => {
    const files = fixture([
      ["ok.txt", text(100), "text/plain"],
      ["gone.txt", text(100), "text/plain"],
      ["big-gone.log", text(3 * MEBIBYTE), "text/plain"],
    ]);
    const unreadable = (size: number) =>
      ({
        size,
        type: "text/plain",
        lastModified,
        arrayBuffer: () => Promise.reject(new Error("The file is gone.")),
        slice() {
          return this;
        },
      }) as unknown as File;
    const small = files.sources.slice(0, 2);
    (small[1] as { file: File }).file = unreadable(100);
    for (const spawnHelper of [undefined, fakeHelpers().spawnHelper]) {
      await expect(
        createFolderZipArchive(
          { type: "compress", sources: small },
          { environment: environment(spawnHelper ? { spawnHelper } : {}) },
        ),
      ).rejects.toThrow('"gone.txt" could not be read: The file is gone.');
    }
    const large = [files.sources[0], files.sources[2]];
    (large[1] as { file: File }).file = unreadable(3 * MEBIBYTE);
    await expect(
      createFolderZipArchive(
        { type: "compress", sources: large },
        { environment: environment() },
      ),
    ).rejects.toThrow('"big-gone.log" could not be read: The file is gone.');
  });

  it("enforces the output limit, counting referenced sources", async () => {
    const files = fixture([
      ["a.txt", text(50_000), "text/plain"],
      ["photo.jpg", random(1.2 * MEBIBYTE, 1), "image/jpeg"],
      ["big.log", text(3 * MEBIBYTE), "text/plain"],
    ]);
    const request = { type: "compress", sources: files.sources } as const;
    const unbounded = await createFolderZipArchive(request, {
      environment: environment(),
    });
    const exact = await createFolderZipArchive(
      { ...request, maxOutputBytes: unbounded.size },
      { environment: environment() },
    );
    expect(exact.size).toBe(unbounded.size);
    for (const maxOutputBytes of [unbounded.size - 1, MEBIBYTE, 100]) {
      for (const spawnHelper of [undefined, fakeHelpers().spawnHelper]) {
        await expect(
          createFolderZipArchive(
            { ...request, maxOutputBytes },
            { environment: environment(spawnHelper ? { spawnHelper } : {}) },
          ),
        ).rejects.toThrow(ZIP_ARCHIVE_SAFETY_LIMIT_ERROR);
      }
    }
    for (const maxOutputBytes of [0, -1, 1.5, Number.NaN]) {
      await expect(
        createFolderZipArchive({ ...request, maxOutputBytes }),
      ).rejects.toThrow("The ZIP archive output limit is invalid.");
    }
  });

  it("stops and terminates its helpers when canceled", async () => {
    const files = mixedFixture();
    const { state, spawnHelper } = fakeHelpers();
    const controller = new AbortController();
    const progress: FolderZipProgress[] = [];
    const pending = createFolderZipArchive(
      { type: "compress", sources: files.sources },
      {
        signal: controller.signal,
        environment: environment({ spawnHelper }),
        onProgress(update) {
          progress.push(update);
          if (update.processedBytes > 0) controller.abort();
        },
      },
    );
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(state.terminated).toBe(state.spawned);
    const seen = progress.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(progress.length).toBe(seen);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      createFolderZipArchive(
        { type: "compress", sources: files.sources },
        { signal: aborted.signal, environment: environment() },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels an inline run between tasks", async () => {
    const files = mixedFixture();
    const controller = new AbortController();
    await expect(
      createFolderZipArchive(
        { type: "compress", sources: files.sources },
        {
          signal: controller.signal,
          environment: environment(),
          onProgress(update) {
            if (update.processedBytes > 0) controller.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("normalizes paths, skips empty ones and rejects duplicates", async () => {
    const files = fixture([
      ["a\\b/./c.txt", text(10), "text/plain"],
      ["../", null],
      ["dir/", null],
      ["/x/\u0001y.txt", text(10), "text/plain"],
    ]);
    const archive = await createFolderZipArchive(
      { type: "compress", sources: files.sources },
      { environment: environment() },
    );
    expect((await readArchive(archive)).map((entry) => entry.path)).toEqual([
      "a/b/c.txt",
      "dir/",
      "x/y.txt",
    ]);

    const duplicate = fixture([
      ["a/b.txt", text(10), "text/plain"],
      ["a/./b.txt", text(10), "text/plain"],
    ]);
    await expect(
      createFolderZipArchive({ type: "compress", sources: duplicate.sources }),
    ).rejects.toThrow("Two entries resolve to the same ZIP path: a/b.txt");
  });

  it("creates an empty archive from no sources", async () => {
    const archive = await createFolderZipArchive({
      type: "compress",
      sources: [],
    });
    expect(archive.size).toBe(22);
    expect(await readArchive(archive)).toEqual([]);
  });
});
