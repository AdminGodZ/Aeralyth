const NO_FAILURE = Symbol("no failure");

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
