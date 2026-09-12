import type { FilesData } from "@/lib/api";
import { recoveryDelay, retryAfterDelay } from "./connection";

export type FileSummary = FilesData["summary"];

function parseSummary(value: unknown): FileSummary | null {
  if (!value || typeof value !== "object") return null;
  const summary = (value as { summary?: FileSummary }).summary;
  if (
    !summary ||
    (summary.treeOperationPending !== undefined &&
      typeof summary.treeOperationPending !== "boolean")
  )
    return null;
  const fields: (keyof FileSummary)[] = [
    "totalFiles",
    "totalFolders",
    "activeFiles",
    "trashedFiles",
    "favoriteFiles",
    "sharedFiles",
    "usedBytes",
  ];
  return fields.every(
    (field) =>
      typeof summary[field] === "number" &&
      Number.isFinite(summary[field]) &&
      summary[field] >= 0,
  )
    ? summary
    : null;
}

/** One account snapshot per burst, independent of the current folder's RSC. */
export class SummaryResource {
  private value: FileSummary | null = null;
  private listeners = new Set<() => void>();
  private active = false;
  private dirty = false;
  private probe: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private retryNotBefore = 0;

  constructor(private readonly onExpired: () => void) {}

  getSnapshot = (): FileSummary | null => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.schedule();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stop();
    };
  };

  acceptSnapshot(summary: FileSummary): void {
    // A newly committed route supplies its own counter snapshot. Abort any
    // older in-flight request and retain its invalidation for a trailing read.
    // The route fence also replays events consumed after this SSR snapshot.
    // The SSR read may precede a completed live read even when its commit is
    // later. A conflicting snapshot requires a fresh serialized confirmation.
    if (
      this.value &&
      (
        [
          ...new Set([...Object.keys(summary), ...Object.keys(this.value)]),
        ] as (keyof FileSummary)[]
      ).some((field) => this.value?.[field] !== summary[field])
    )
      this.dirty = true;
    this.stop();
    this.value = summary;
    for (const listener of this.listeners) listener();
    this.schedule();
  }

  invalidate(): void {
    this.dirty = true;
    this.schedule();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) this.schedule();
    else this.stop();
  }

  private stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.probe) this.dirty = true;
    this.probe?.abort();
    this.probe = null;
  }

  private schedule(delay = 250): void {
    if (
      !this.active ||
      !this.listeners.size ||
      !this.dirty ||
      this.probe ||
      this.timer
    )
      return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.load();
      },
      Math.max(delay, this.retryNotBefore - Date.now()),
    );
  }

  private async load(): Promise<void> {
    if (!this.active || !this.listeners.size || this.probe) return;
    const controller = new AbortController();
    this.probe = controller;
    this.dirty = false;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let delay = 250;
    try {
      const response = await fetch("/api/files/summary", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (controller.signal.aborted || this.probe !== controller) return;
      if (response.status === 401) {
        this.setActive(false);
        this.onExpired();
        return;
      }
      this.retryNotBefore =
        Date.now() + retryAfterDelay(response.headers.get("retry-after"));
      delay = Math.max(delay, this.retryNotBefore - Date.now());
      const summary = response.ok ? parseSummary(await response.json()) : null;
      if (controller.signal.aborted || this.probe !== controller) return;
      if (!summary) throw new Error("File summary unavailable");
      this.attempt = 0;
      this.value = summary;
      for (const listener of this.listeners) listener();
    } catch {
      if (this.probe === controller) {
        this.dirty = true;
        delay = Math.max(delay, recoveryDelay(this.attempt++));
      }
    } finally {
      clearTimeout(timeout);
      if (this.probe === controller) {
        this.probe = null;
        if (controller.signal.aborted) this.dirty = true;
        this.schedule(delay);
      }
    }
  }
}
