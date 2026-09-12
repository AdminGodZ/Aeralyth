import { recoveryDelay } from "./connection";

/** Retry a failed SSR read without treating a valid event cursor as loaded data. */
export class SnapshotRetry {
  private ready = true;
  private active = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly retry: () => void) {}

  setReady(ready: boolean): void {
    this.ready = ready;
    if (ready) {
      this.attempt = 0;
      clearTimeout(this.timer);
      this.timer = undefined;
    } else this.schedule();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) this.schedule();
    else {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    if (this.ready || !this.active || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.attempt += 1;
      this.retry();
      this.schedule();
    }, 2_000 + recoveryDelay(this.attempt));
  }
}
