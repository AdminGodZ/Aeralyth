import { afterEach, describe, expect, it, vi } from "vitest";

import {
  claimArchivePath,
  createBrowserZip,
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
