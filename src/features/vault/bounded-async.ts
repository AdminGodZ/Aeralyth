import { abortReason } from "@/lib/abort";

const NO_FAILURE = Symbol("no failure");

type WeightedWaiter = {
  weight: number;
  resolve(release: () => void): void;
  reject(reason: unknown): void;
  signal?: AbortSignal;
  abort?: () => void;
};

export class WeightedSemaphore {
  private available: number;
  private readonly waiters: WeightedWaiter[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("Semaphore capacity must be a positive integer.");
    }
    this.available = capacity;
  }

  acquire(weight = 1, signal?: AbortSignal): Promise<() => void> {
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > this.capacity) {
      return Promise.reject(new Error("Semaphore weight is out of range."));
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    return new Promise((resolve, reject) => {
      const waiter: WeightedWaiter = { weight, resolve, reject, signal };
      if (signal) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          reject(abortReason(signal));
          this.drain();
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.waiters.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    while (this.waiters[0]?.weight <= this.available) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      if (waiter.abort) {
        waiter.signal?.removeEventListener("abort", waiter.abort);
      }
      this.available -= waiter.weight;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.available += waiter.weight;
        this.drain();
      });
    }
  }
}

export class BoundedBatchPipeline<Input, Output> {
  private readonly pending: Input[] = [];
  private readonly output: Output[] = [];
  private inFlight: Promise<void> | null = null;
  private failure: unknown | typeof NO_FAILURE = NO_FAILURE;
  private closed = false;

  constructor(
    readonly batchSize: number,
    readonly lookahead: number,
    private readonly processBatch: (batch: Input[]) => Promise<Output[]>,
  ) {
    if (
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      !Number.isSafeInteger(lookahead) ||
      lookahead < 1
    ) {
      throw new Error("Invalid bounded-pipeline configuration.");
    }
  }

  get bufferedInputs(): number {
    return this.pending.length;
  }

  get processing(): boolean {
    return this.inFlight !== null;
  }

  async push(value: Input): Promise<void> {
    this.assertOpen();
    this.throwIfFailed();
    this.pending.push(value);

    if (!this.inFlight && this.pending.length >= this.batchSize) {
      this.startBatch(this.batchSize);
    }
    if (this.inFlight && this.pending.length >= this.lookahead) {
      await this.settle();
      this.throwIfFailed();
    }
  }

  async finish(): Promise<Output[]> {
    this.assertOpen();
    while (this.inFlight || this.pending.length > 0) {
      if (this.inFlight) {
        // Batches must settle sequentially to enforce the single-batch memory ceiling.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await this.settle();
        this.throwIfFailed();
      }
      if (this.pending.length > 0) {
        this.startBatch(Math.min(this.batchSize, this.pending.length));
      }
    }
    this.closed = true;
    return this.output;
  }

  async stop(): Promise<Input[]> {
    this.closed = true;
    await this.settle();
    return this.pending.splice(0);
  }

  private startBatch(size: number): void {
    const batch = this.pending.splice(0, size);
    this.inFlight = this.processBatch(batch).then(
      (output) => {
        this.output.push(...output);
      },
      (error: unknown) => {
        if (this.failure === NO_FAILURE) this.failure = error;
      },
    );
  }

  private async settle(): Promise<void> {
    const inFlight = this.inFlight;
    if (!inFlight) return;
    await inFlight;
    if (this.inFlight === inFlight) this.inFlight = null;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("The bounded pipeline is closed.");
  }

  private throwIfFailed(): void {
    if (this.failure !== NO_FAILURE) throw this.failure;
  }
}

/**
 * A single producer awaits each push, so backpressure retains at most its next
 * input outside the byte budget. Completed slots refill independently.
 */
export class BoundedRollingPipeline<Input, Output> {
  private readonly slots: WeightedSemaphore;
  private readonly bytes: WeightedSemaphore;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly output: Output[] = [];
  private failure: unknown | typeof NO_FAILURE = NO_FAILURE;
  private closed = false;
  private nextIndex = 0;
  private activeBytes = 0;

  constructor(
    concurrency: number,
    readonly capacityBytes: number,
    private readonly sizeOf: (input: Input) => number,
    private readonly process: (input: Input) => Promise<Output>,
    private readonly signal: AbortSignal,
    private readonly onFailure: (error: unknown) => void,
  ) {
    this.slots = new WeightedSemaphore(concurrency);
    this.bytes = new WeightedSemaphore(capacityBytes);
  }

  get processingBytes(): number {
    return this.activeBytes;
  }

  async push(value: Input): Promise<void> {
    this.assertOpen();
    this.throwIfFailed();
    const size = this.sizeOf(value);
    const releaseSlot = await this.slots.acquire(1, this.signal);
    let releaseBytes: (() => void) | undefined;
    try {
      releaseBytes = await this.bytes.acquire(size, this.signal);
      this.assertOpen();
      this.throwIfFailed();
      if (this.signal.aborted) throw abortReason(this.signal);
    } catch (error) {
      releaseBytes?.();
      releaseSlot();
      throw error;
    }

    const index = this.nextIndex++;
    this.activeBytes += size;
    const work = Promise.resolve()
      .then(() => this.process(value))
      .then(
        (output) => {
          this.output[index] = output;
        },
        (error: unknown) => {
          if (this.failure === NO_FAILURE) {
            this.failure = error;
            this.onFailure(error);
          }
        },
      )
      .finally(() => {
        this.activeBytes -= size;
        releaseBytes();
        releaseSlot();
        this.inFlight.delete(work);
      });
    this.inFlight.add(work);
  }

  async finish(): Promise<Output[]> {
    this.assertOpen();
    this.closed = true;
    await Promise.all(this.inFlight);
    this.throwIfFailed();
    if (this.signal.aborted) throw abortReason(this.signal);
    return this.output;
  }

  async stop(): Promise<void> {
    this.closed = true;
    await Promise.all(this.inFlight);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("The bounded pipeline is closed.");
  }

  private throwIfFailed(): void {
    if (this.failure !== NO_FAILURE) throw this.failure;
  }
}

export function concurrencyForHardware(
  hardwareConcurrency: number | undefined,
  maximum: number,
  divisor = 1,
  fallback = 4,
): number {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    !Number.isSafeInteger(divisor) ||
    divisor < 1 ||
    !Number.isSafeInteger(fallback) ||
    fallback < 1
  ) {
    throw new Error("Invalid bounded-concurrency configuration.");
  }
  const available =
    typeof hardwareConcurrency === "number" &&
    Number.isFinite(hardwareConcurrency) &&
    hardwareConcurrency >= 1
      ? Math.floor(hardwareConcurrency)
      : fallback;
  return Math.max(1, Math.min(maximum, Math.ceil(available / divisor)));
}

export function detectedCryptoConcurrency(
  maximum: number,
  divisor = 1,
): number {
  const hardwareConcurrency =
    typeof navigator === "undefined"
      ? undefined
      : navigator.hardwareConcurrency;
  return concurrencyForHardware(hardwareConcurrency, maximum, divisor);
}

export async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  transform: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer.");
  }
  if (values.length === 0) return [];

  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  let stopped = false;
  let failure: unknown | typeof NO_FAILURE = NO_FAILURE;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (!stopped) {
        const index = nextIndex;
        if (index >= values.length) return;
        nextIndex += 1;
        try {
          results[index] = await transform(values[index], index);
        } catch (error) {
          if (failure === NO_FAILURE) failure = error;
          stopped = true;
        }
      }
    },
  );
  await Promise.all(workers);
  if (failure !== NO_FAILURE) throw failure;
  return results;
}
