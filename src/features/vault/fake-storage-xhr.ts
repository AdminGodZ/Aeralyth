// Test support: an XMLHttpRequest stand-in for the storage PUTs, which run on
// XHR so they can report upload progress.

type ProgressLike = { lengthComputable: boolean; loaded: number };
type Listener = (event: ProgressLike) => void;

class ListenerSet {
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(
    type: string,
    event: ProgressLike = { lengthComputable: false, loaded: 0 },
  ) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** One recorded request; the test drives it and observes `abort`. */
export class FakeStorageRequest {
  method = "";
  url = "";
  requestHeaders: Record<string, string> = {};
  body: Uint8Array<ArrayBuffer> = new Uint8Array();
  status = 0;
  responseText = "";
  aborted = false;
  onAbort: (() => void) | undefined;
  readonly upload = new ListenerSet();
  private readonly events = new ListenerSet();
  private responseHeaders = new Map<string, string>();

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name] = value;
  }

  addEventListener(type: string, listener: Listener): void {
    this.events.addEventListener(type, listener);
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders.get(name.toLowerCase()) ?? null;
  }

  send(body: Uint8Array<ArrayBuffer>): void {
    // Kept by reference so tests can check the caller wipes its buffer.
    this.body = body;
    this.sent();
  }

  abort(): void {
    this.aborted = true;
    this.onAbort?.();
    this.events.emit("abort");
  }

  progress(loaded: number): void {
    this.upload.emit("progress", { lengthComputable: true, loaded });
  }

  respond(
    status: number,
    {
      headers = {},
      body = "",
    }: { headers?: Record<string, string>; body?: string } = {},
  ): void {
    this.status = status;
    this.responseText = body;
    this.responseHeaders = new Map(
      Object.entries(headers).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    );
    this.events.emit("load");
  }

  fail(): void {
    this.events.emit("error");
  }

  protected sent(): void {}
}

/** An XMLHttpRequest constructor that records every request it creates. */
export function createFakeXhr(onSend?: (request: FakeStorageRequest) => void) {
  const requests: FakeStorageRequest[] = [];
  class RecordedRequest extends FakeStorageRequest {
    protected override sent(): void {
      requests.push(this);
      onSend?.(this);
    }
  }
  return { XMLHttpRequest: RecordedRequest, requests };
}

/**
 * Answers each request through the global `fetch`, so tests that script
 * storage with a fetch mock keep doing so.
 */
export function createFetchBackedXhr() {
  return createFakeXhr((request) => {
    const controller = new AbortController();
    request.onAbort = () => controller.abort();
    fetch(request.url, {
      method: request.method,
      headers: request.requestHeaders,
      body: request.body,
      signal: controller.signal,
    }).then(
      async (response) =>
        request.respond(response.status, {
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
        }),
      () => {
        if (!request.aborted) request.fail();
      },
    );
  });
}
