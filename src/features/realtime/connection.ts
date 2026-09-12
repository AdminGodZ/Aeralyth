import { parseChanges, type RealtimeChange } from "./changes";

type Update = { cursor: string; reset: boolean; changes: RealtimeChange[] };

export function validCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{1,19}$/.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}

export function recoveryDelay(attempt: number, random = Math.random()): number {
  return Math.floor(
    Math.min(1_000 * 2 ** Math.min(attempt, 4), 10_000) * random,
  );
}

export function retryAfterDelay(
  value: string | null,
  now = Date.now(),
): number {
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - now;
  // setTimeout overflows above this bound and would retry immediately.
  return Number.isFinite(delay)
    ? Math.min(Math.max(delay, 0), 2_147_483_647)
    : 0;
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

/** Recovery alternates replay and SSE through one budget, never parallel polls. */
export class RealtimeConnection {
  private active = false;
  private disposed = false;
  private cursor: string;
  private source: EventSource | null = null;
  private connectedOnce = false;
  private probe: AbortController | null = null;
  private attempt = 0;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private retryNotBefore = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onChanges: (
      changes: RealtimeChange[],
      reset: boolean,
    ) => void,
    private readonly onExpired: () => void,
    initialCursor?: string,
    private readonly onUpdate?: (
      changes: RealtimeChange[],
      reset: boolean,
      cursor: string,
    ) => void,
  ) {
    this.cursor = validCursor(initialCursor) ? initialCursor : "";
  }

  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return;
    this.active = active;
    if (active) {
      if (this.attempt || this.retryNotBefore > Date.now())
        this.schedule(false);
      else this.connect();
    } else this.stop();
  }

  dispose(): void {
    this.disposed = true;
    this.active = false;
    this.stop();
  }

  private stop(): void {
    this.source?.close();
    this.source = null;
    clearTimeout(this.recoveryTimer);
    clearTimeout(this.watchdog);
    this.recoveryTimer = undefined;
    this.probe?.abort();
    this.probe = null;
  }

  private expire(): void {
    this.dispose();
    this.onExpired();
  }

  private schedule(stream: boolean): void {
    if (!this.active || this.source || this.probe || this.recoveryTimer) return;
    const delay =
      Math.max(
        0,
        this.lastRequestAt + 500 - Date.now(),
        this.retryNotBefore - Date.now(),
      ) + recoveryDelay(this.attempt);
    this.recoveryTimer = setTimeout(
      () => {
        this.recoveryTimer = undefined;
        if (stream) this.connect();
        else void this.catchUp();
      },
      Math.min(delay, 2_147_483_647),
    );
  }

  private connect(): void {
    if (!this.active || this.source || this.probe) return;
    this.lastRequestAt = Date.now();
    const baseCursor = this.cursor;
    const query = new URLSearchParams();
    if (baseCursor) query.set("cursor", baseCursor);
    if (this.connectedOnce) query.set("reconnect", "1");
    this.connectedOnce = true;
    const source = new EventSource(
      `/api/events${query.size ? `?${query}` : ""}`,
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
      this.attempt = 0;
      this.retryNotBefore = 0;
      clearTimeout(this.watchdog);
      // Three five-second heartbeat intervals allow queued/slow first frames.
      this.watchdog = setTimeout(() => this.failed(source), 15_000);
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
    this.watchdog = setTimeout(() => this.failed(source), 15_000);
  }

  private failed(source: EventSource): void {
    if (!this.active || this.source !== source) return;
    source.close();
    this.source = null;
    clearTimeout(this.watchdog);
    this.schedule(false);
    this.attempt = Math.min(this.attempt + 1, 4);
  }

  private apply(update: Update, baseCursor: string): void {
    if (this.cursor && BigInt(update.cursor) <= BigInt(this.cursor)) {
      // A reset can correct a future cursor. An abandoned response cannot
      // regress the cursor or reapply changes delivered by another request.
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
    this.onUpdate?.(update.changes, update.reset, update.cursor);
  }

  private async catchUp(): Promise<void> {
    if (!this.active || this.source || this.probe) return;
    const controller = new AbortController();
    this.probe = controller;
    this.lastRequestAt = Date.now();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const baseCursor = this.cursor;
    let healthy = false;
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
      this.retryNotBefore =
        Date.now() + retryAfterDelay(response.headers.get("retry-after"));
      if (!response.ok) return;
      const update = parseUpdate(await response.json());
      if (update && !controller.signal.aborted && this.probe === controller) {
        this.apply(update, baseCursor);
        healthy = true;
      }
    } catch {
      // Keep the current page during outages and retry within the shared budget.
    } finally {
      clearTimeout(timeout);
      if (this.probe === controller) {
        this.probe = null;
        this.schedule(healthy);
        if (!healthy) this.attempt = Math.min(this.attempt + 1, 4);
      }
    }
  }
}
