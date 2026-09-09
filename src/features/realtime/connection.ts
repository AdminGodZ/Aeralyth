import { parseChanges, type RealtimeChange } from "./changes";

type Update = { cursor: string; reset: boolean; changes: RealtimeChange[] };

function validCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{1,19}$/.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}

function parseUpdate(value: unknown): Update | null {
  if (!value || typeof value !== "object") return null;
  const update = value as Partial<Update>;
  if (!validCursor(update.cursor) || typeof update.reset !== "boolean")
    return null;
  const changes = parseChanges(JSON.stringify(update.changes));
  return changes
    ? { cursor: update.cursor, reset: update.reset, changes }
    : null;
}

/** SSE normally; short, single-flight replay requests while SSE is unhealthy. */
export class RealtimeConnection {
  private active = false;
  private disposed = false;
  private recovering = false;
  private cursor = "";
  private source: EventSource | null = null;
  private probe: AbortController | null = null;
  private retryDelay = 250;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onChanges: (
      changes: RealtimeChange[],
      reset: boolean,
    ) => void,
    private readonly onExpired: () => void,
  ) {}

  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return;
    this.active = active;
    if (active) this.connect();
    else this.stop();
  }

  dispose(): void {
    this.disposed = true;
    this.active = false;
    this.stop();
  }

  private stop(): void {
    this.source?.close();
    this.source = null;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.watchdog);
    this.reconnectTimer = undefined;
    this.stopPolling();
  }

  private stopPolling(): void {
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.probe?.abort();
    this.probe = null;
  }

  private expire(): void {
    this.dispose();
    this.onExpired();
  }

  private connect(): void {
    if (!this.active || this.source) return;
    const baseCursor = this.cursor;
    const source = new EventSource(
      `/api/events${baseCursor ? `?cursor=${baseCursor}` : ""}`,
    );
    this.source = source;
    const receive = (
      event: MessageEvent,
      reset: boolean,
      changes: RealtimeChange[],
    ) => {
      if (this.source !== source) return;
      if (!validCursor(event.lastEventId)) {
        this.failed(source);
        return;
      }
      this.recovering = false;
      this.retryDelay = 250;
      this.stopPolling();
      clearTimeout(this.watchdog);
      // The API sends a checkpoint every five seconds, even when idle.
      this.watchdog = setTimeout(() => this.failed(source), 8_000);
      this.apply({ cursor: event.lastEventId, reset, changes }, baseCursor);
    };
    source.addEventListener("reset", (event: MessageEvent) =>
      receive(event, true, []),
    );
    source.addEventListener("changes", (event: MessageEvent) => {
      const changes = parseChanges(event.data);
      receive(event, changes === null, changes ?? []);
    });
    source.addEventListener("checkpoint", (event: MessageEvent) =>
      receive(event, false, []),
    );
    source.addEventListener("session-expired", () => {
      if (this.source === source) this.expire();
    });
    source.onerror = () => this.failed(source);
    // Opening a socket is not proof that its first frame can get through.
    this.watchdog = setTimeout(() => this.failed(source), 2_000);
  }

  private failed(source: EventSource): void {
    if (!this.active || this.source !== source) return;
    source.close(); // Replace native retry timing with bounded recovery.
    this.source = null;
    clearTimeout(this.watchdog);
    this.recovering = true;
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    void this.catchUp();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 5_000);
  }

  private apply(update: Update, baseCursor: string): void {
    if (this.cursor && BigInt(update.cursor) <= BigInt(this.cursor)) {
      // A reset may legitimately correct a future cursor, but an old response
      // must never undo progress from another request or reapply its changes.
      if (
        !update.reset ||
        update.cursor === this.cursor ||
        baseCursor !== this.cursor
      )
        return;
    }
    this.cursor = update.cursor;
    if (update.reset || update.changes.length)
      this.onChanges(update.changes, update.reset);
  }

  private async catchUp(): Promise<void> {
    if (!this.active || !this.recovering || this.probe) return;
    const controller = new AbortController();
    this.probe = controller;
    const timeout = setTimeout(() => controller.abort(), 3_000);
    const baseCursor = this.cursor;
    try {
      const response = await fetch(
        `/api/events/sync${baseCursor ? `?cursor=${baseCursor}` : ""}`,
        { cache: "no-store", signal: controller.signal },
      );
      if (controller.signal.aborted || this.probe !== controller) return;
      if (response.status === 401) {
        this.expire();
        return;
      }
      if (!response.ok) return;
      const update = parseUpdate(await response.json());
      if (update && !controller.signal.aborted && this.probe === controller)
        this.apply(update, baseCursor);
    } catch {
      // Preserve the current page during outages; retry without overlapping.
    } finally {
      clearTimeout(timeout);
      if (this.probe === controller) {
        this.probe = null;
        if (this.active && this.recovering)
          this.pollTimer = setTimeout(() => {
            this.pollTimer = undefined;
            void this.catchUp();
          }, 1_000);
      }
    }
  }
}
