import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import { streamDownload } from "@/lib/stream-download";

type DownloadMessage = {
  type: string;
  id: string;
  fileName: string;
  size: number | null;
  stream: ReadableStream<Uint8Array>;
  port: MessagePort;
};

function sourceOf(chunks: Uint8Array[], failWith?: Error) {
  let index = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index += 1;
      } else if (failWith) {
        controller.error(failWith);
      } else {
        controller.close();
      }
    },
    cancel,
  });
  return { stream, cancel };
}

/** Plays the download service worker and the browser's download manager. */
function fakeBrowser({
  respond = "ready",
  consume = "all",
}: {
  respond?: "ready" | "rejected" | "silent";
  consume?: "all" | "cancel-after-first";
} = {}) {
  const received: Uint8Array[] = [];
  let message: DownloadMessage | null = null;
  let consumed: Promise<void> = Promise.resolve();
  const assign = vi.fn((url: string) => {
    if (!message || url !== `/download-stream/${message.id}`) return;
    message.port.postMessage({ type: "started" });
    const reader = message.stream.getReader();
    consumed = (async () => {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        received.push(next.value);
        if (consume === "cancel-after-first") {
          await reader.cancel("user canceled");
          return;
        }
      }
    })();
    // A failing download surfaces through streamDownload itself.
    void consumed.catch(() => undefined);
  });
  vi.stubGlobal("window", { location: { assign } });
  const worker = {
    postMessage: vi.fn((data: DownloadMessage) => {
      if (data.type !== "download") return;
      message = data;
      if (respond !== "silent") data.port.postMessage({ type: respond });
    }),
  } as unknown as ServiceWorker;
  return {
    worker,
    assign,
    received,
    message: () => message,
    consumed: () => consumed,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("streamDownload", () => {
  it("hands every byte to the browser download and resolves", async () => {
    const browser = fakeBrowser();
    const { stream } = sourceOf([new Uint8Array([1, 2]), new Uint8Array([3])]);

    await streamDownload({
      worker: browser.worker,
      stream,
      fileName: "report.pdf",
      size: 3,
    });
    await browser.consumed();

    expect(browser.message()).toMatchObject({
      type: "download",
      fileName: "report.pdf",
      size: 3,
    });
    expect(browser.message()?.id).toMatch(/^[0-9a-f]{32}$/u);
    expect(browser.assign).toHaveBeenCalledTimes(1);
    expect(browser.received.flatMap((chunk) => [...chunk])).toEqual([1, 2, 3]);
  });

  it("reports a canceled browser download as an AbortError", async () => {
    const browser = fakeBrowser({ consume: "cancel-after-first" });
    const source = sourceOf([new Uint8Array([1]), new Uint8Array([2])]);

    await expect(
      streamDownload({
        worker: browser.worker,
        stream: source.stream,
        fileName: "a.bin",
        size: 2,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(source.cancel).toHaveBeenCalled();
  });

  it("surfaces a decryption failure from the source stream", async () => {
    const browser = fakeBrowser();
    const failure = new Error("chunk 2 failed authentication");
    const { stream } = sourceOf([new Uint8Array([1])], failure);

    await expect(
      streamDownload({
        worker: browser.worker,
        stream,
        fileName: "a.bin",
        size: 2,
      }),
    ).rejects.toBe(failure);
  });

  it("fails without navigating when the worker refuses the stream", async () => {
    const browser = fakeBrowser({ respond: "rejected" });
    const source = sourceOf([new Uint8Array([1])]);

    await expect(
      streamDownload({
        worker: browser.worker,
        stream: source.stream,
        fileName: "a.bin",
        size: 1,
      }),
    ).rejects.toThrow("refused");
    expect(browser.assign).not.toHaveBeenCalled();
    expect(source.cancel).toHaveBeenCalled();
  });

  it("stops the source when the caller aborts", async () => {
    const browser = fakeBrowser({ respond: "silent" });
    const source = sourceOf([new Uint8Array([1])]);
    const controller = new AbortController();

    const download = streamDownload({
      worker: browser.worker,
      stream: source.stream,
      fileName: "a.bin",
      size: 1,
      signal: controller.signal,
    });
    controller.abort(new DOMException("stop", "AbortError"));

    await expect(download).rejects.toMatchObject({ name: "AbortError" });
    expect(source.cancel).toHaveBeenCalled();
  });
});

describe("download service worker", () => {
  type Listener = (event: unknown) => void;

  function loadWorker() {
    const listeners = new Map<string, Listener>();
    const self = {
      location: { origin: "https://cloud.example" },
      addEventListener: (type: string, listener: Listener) =>
        listeners.set(type, listener),
      skipWaiting: vi.fn(),
    };
    runInNewContext(
      readFileSync(
        resolve(import.meta.dirname, "../../public/download-sw.js"),
        {
          encoding: "utf8",
        },
      ),
      {
        self,
        ReadableStream,
        MessagePort,
        Headers,
        Response,
        URL,
        setTimeout,
        clearTimeout,
      },
    );
    const register = (data: unknown, origin = self.location.origin) =>
      listeners.get("message")?.({ origin, data });
    const fetch = (url: string) => {
      let response: Response | null = null;
      listeners.get("fetch")?.({
        request: { url },
        respondWith: (value: Response) => {
          response = value;
        },
      });
      return response as Response | null;
    };
    return { register, fetch };
  }

  function nextMessage(port: MessagePort): Promise<{ type: string }> {
    return new Promise((resolveMessage) => {
      port.onmessage = (event) => resolveMessage(event.data);
    });
  }

  const id = "0123456789abcdef0123456789abcdef";

  it("answers the registered download with the stream as an attachment", async () => {
    const sw = loadWorker();
    const channel = new MessageChannel();
    const ready = nextMessage(channel.port1);
    sw.register({
      type: "download",
      id,
      fileName: 'Résumé "final".pdf',
      size: 3,
      stream: new Blob([new Uint8Array([7, 8, 9])]).stream(),
      port: channel.port2,
    });
    expect(await ready).toEqual({ type: "ready" });

    const started = nextMessage(channel.port1);
    const response = sw.fetch(`https://cloud.example/download-stream/${id}`);
    expect(await started).toEqual({ type: "started" });
    expect(response).not.toBeNull();
    expect(response?.headers.get("Content-Disposition")).toBe(
      `attachment; filename="R_sum_ _final_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.pdf`,
    );
    expect(response?.headers.get("Content-Length")).toBe("3");
    expect(response?.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
    expect([
      ...new Uint8Array(await (response as Response).arrayBuffer()),
    ]).toEqual([7, 8, 9]);

    // The id is single use; a second request falls through to the server.
    expect(sw.fetch(`https://cloud.example/download-stream/${id}`)).toBeNull();
    channel.port1.close();
  });

  it("ignores other paths, unknown ids, and other origins", () => {
    const sw = loadWorker();
    expect(sw.fetch("https://cloud.example/files")).toBeNull();
    expect(sw.fetch(`https://cloud.example/download-stream/${id}`)).toBeNull();

    const channel = new MessageChannel();
    sw.register(
      {
        type: "download",
        id,
        fileName: "a",
        size: 1,
        stream: new ReadableStream(),
        port: channel.port2,
      },
      "https://evil.example",
    );
    expect(sw.fetch(`https://cloud.example/download-stream/${id}`)).toBeNull();
    channel.port1.close();
  });

  it("rejects malformed registrations", async () => {
    const sw = loadWorker();
    const channel = new MessageChannel();
    const reply = nextMessage(channel.port1);
    sw.register({
      type: "download",
      id: "../../api/files",
      fileName: "a",
      size: 1,
      stream: new ReadableStream(),
      port: channel.port2,
    });
    expect(await reply).toEqual({ type: "rejected" });
    channel.port1.close();
  });
});
