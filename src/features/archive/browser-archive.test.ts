import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimArchivePath,
  createBrowserZip,
  createStreamingZipDestination,
  MAX_IN_MEMORY_ARCHIVE_SOURCE_BYTES,
} from "@/features/archive/browser-archive";
import type { FolderZipWorkerResponse } from "@/features/dashboard/folder-zip-messages";

class FakeWorker {
  static current: FakeWorker | null = null;

  readonly messages: unknown[] = [];
  terminated = false;
  private readonly listeners = new Map<
    string,
    Array<(event: unknown) => void>
  >();

  constructor() {
    FakeWorker.current = this;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: FolderZipWorkerResponse): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: message });
    }
  }
}

afterEach(() => {
  FakeWorker.current = null;
  vi.unstubAllGlobals();
});

describe("browser archive worker", () => {
  it("forwards progress and terminates after returning the ZIP", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const onProgress = vi.fn();
    const result = createBrowserZip({
      sources: [],
      workerName: "test-zip",
      errorMessage: "failed",
      onProgress,
    });
    const worker = FakeWorker.current;
    expect(worker?.messages).toEqual([{ type: "compress", sources: [] }]);

    worker?.emit({
      type: "progress",
      processedBytes: 4,
      totalBytes: 10,
      currentPath: "folder/file.txt",
    });
    expect(onProgress).toHaveBeenCalledOnce();
    const archive = new Blob(["zip"]);
    worker?.emit({ type: "complete", archive });

    await expect(result).resolves.toBe(archive);
    expect(worker?.terminated).toBe(true);
  });

  it("cancels and terminates the worker exactly once", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const controller = new AbortController();
    const result = createBrowserZip({
      sources: [],
      signal: controller.signal,
      workerName: "test-zip",
      errorMessage: "failed",
      onProgress: () => undefined,
    });
    const worker = FakeWorker.current;

    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(worker?.messages).toEqual([
      { type: "compress", sources: [] },
      { type: "cancel" },
    ]);
    expect(worker?.terminated).toBe(true);

    worker?.emit({ type: "complete", archive: new Blob() });
    expect(worker?.terminated).toBe(true);
  });

  it("forwards a hard output limit to the ZIP worker", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const result = createBrowserZip({
      sources: [],
      maxOutputBytes: 160,
      workerName: "test-zip",
      errorMessage: "failed",
      onProgress: () => undefined,
    });
    const worker = FakeWorker.current;

    expect(worker?.messages).toEqual([
      { type: "compress", sources: [], maxOutputBytes: 160 },
    ]);
    worker?.emit({ type: "complete", archive: new Blob(["zip"]) });
    await expect(result).resolves.toBeInstanceOf(Blob);
  });
});

describe("streaming ZIP destination", () => {
  it("creates a valid ZIP without retaining source files", async () => {
    vi.stubGlobal("navigator", { storage: {} });
    const destination = await createStreamingZipDestination({
      totalSourceBytes: 11,
    });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello "));
        controller.enqueue(new TextEncoder().encode("world"));
        controller.close();
      },
    });

    await destination.zipWriter.add("project/readme.txt", source);
    const archive = await destination.close();
    const reader = new ZipReader(new BlobReader(archive));
    const entries = await reader.getEntries();

    expect(destination.diskBacked).toBe(false);
    expect(entries.map((entry) => entry.filename)).toEqual([
      "project/readme.txt",
    ]);
    const entry = entries[0];
    if (!entry || entry.directory || !("getData" in entry)) {
      throw new Error("The streamed ZIP file entry is missing.");
    }
    await expect(entry.getData(new TextWriter())).resolves.toBe("hello world");
    await reader.close();
  });

  it("rejects a large archive before using the memory fallback", async () => {
    vi.stubGlobal("navigator", { storage: {} });

    await expect(
      createStreamingZipDestination({
        totalSourceBytes: MAX_IN_MEMORY_ARCHIVE_SOURCE_BYTES + 1,
      }),
    ).rejects.toThrow("cannot stream this ZIP archive to disk");
  });

  it("routes a logical 1 GiB archive to OPFS and releases its temporary entry", async () => {
    const output: Uint8Array[] = [];
    const writable = {
      async write(chunk: Uint8Array) {
        output.push(chunk.slice());
      },
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const removeEntry = vi.fn(async () => undefined);
    const getFileHandle = vi.fn(async () => ({
      createWritable: async () => writable,
      getFile: async () =>
        new Blob(
          output.map((chunk) => {
            const copy = new Uint8Array(chunk.byteLength);
            copy.set(chunk);
            return copy.buffer;
          }),
        ) as unknown as File,
    }));
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: async () => ({ getFileHandle, removeEntry }),
      },
    });
    const destination = await createStreamingZipDestination({
      totalSourceBytes: 1024 * 1024 * 1024,
    });

    await destination.zipWriter.add(
      "large.bin",
      new Blob([Uint8Array.of(1, 2, 3)]).stream(),
    );
    const archive = await destination.close();

    expect(destination.diskBacked).toBe(true);
    expect(archive.size).toBeGreaterThan(0);
    expect(writable.close).toHaveBeenCalledOnce();
    expect(removeEntry).not.toHaveBeenCalled();
    await destination.release();
    expect(removeEntry).toHaveBeenCalledOnce();
  });
});

describe("portable archive paths", () => {
  it("rejects case-insensitive extraction collisions", () => {
    const paths = new Set<string>();
    claimArchivePath(paths, "Project/Foo.txt");

    expect(() => claimArchivePath(paths, "project/foo.TXT")).toThrow(
      "same ZIP extraction path",
    );
  });

  it("rejects canonically equivalent Unicode extraction collisions", () => {
    const paths = new Set<string>();
    claimArchivePath(paths, "Project/Café.txt");

    expect(() => claimArchivePath(paths, "Project/Cafe\u0301.txt")).toThrow(
      "same ZIP extraction path",
    );
  });
});
