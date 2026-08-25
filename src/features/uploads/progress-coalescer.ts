export function createAnimationFrameProgressCoalescer<T>(
  emit: (value: T) => void,
  schedule: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancelScheduled: (handle: number) => void = cancelAnimationFrame,
) {
  let scheduled: number | null = null;
  let pending: T | undefined;
  let hasPending = false;

  const deliver = () => {
    scheduled = null;
    if (!hasPending) return;
    const value = pending as T;
    pending = undefined;
    hasPending = false;
    emit(value);
  };

  return {
    publish(value: T, immediate = false) {
      pending = value;
      hasPending = true;
      if (immediate) {
        if (scheduled !== null) cancelScheduled(scheduled);
        deliver();
      } else if (scheduled === null) {
        scheduled = schedule(deliver);
      }
    },
    flush() {
      if (scheduled !== null) cancelScheduled(scheduled);
      deliver();
    },
    cancel() {
      if (scheduled !== null) cancelScheduled(scheduled);
      scheduled = null;
      pending = undefined;
      hasPending = false;
    },
  };
}

export function createIntervalProgressCoalescer<T>(
  emit: (value: T) => void,
  intervalMilliseconds = 100,
  now: () => number = performance.now.bind(performance),
) {
  let lastEmission = Number.NEGATIVE_INFINITY;
  let pending: T | undefined;
  let hasPending = false;

  const deliver = (timestamp: number) => {
    if (!hasPending) return;
    const value = pending as T;
    pending = undefined;
    hasPending = false;
    lastEmission = timestamp;
    emit(value);
  };

  return {
    publish(value: T, immediate = false) {
      pending = value;
      hasPending = true;
      const timestamp = now();
      if (immediate || timestamp - lastEmission >= intervalMilliseconds) {
        deliver(timestamp);
      }
    },
    flush() {
      deliver(now());
    },
  };
}
