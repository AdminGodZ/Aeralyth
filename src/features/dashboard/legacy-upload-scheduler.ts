import {
  mapWithConcurrency,
  WeightedSemaphore,
} from "@/features/vault/bounded-async";

export const LEGACY_FILE_CONCURRENCY = 3;
export const LEGACY_CONCURRENT_FILE_MAX_BYTES = 8 * 1024 * 1024;

export async function scheduleLegacyUploads<Input, Output>(
  inputs: readonly Input[],
  parentSignal: AbortSignal,
  sizeOf: (input: Input) => number,
  upload: (input: Input, signal: AbortSignal) => Promise<Output>,
): Promise<Output[]> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(abortReason(parentSignal));
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener("abort", abortFromParent, { once: true });

  const slots = new WeightedSemaphore(LEGACY_FILE_CONCURRENCY);
  let primaryFailure: unknown;

  try {
    return await mapWithConcurrency(
      inputs,
      LEGACY_FILE_CONCURRENCY,
      async (input) => {
        const weight =
          sizeOf(input) <= LEGACY_CONCURRENT_FILE_MAX_BYTES
            ? 1
            : LEGACY_FILE_CONCURRENCY;
        const release = await slots.acquire(weight, controller.signal);
        try {
          return await upload(input, controller.signal);
        } catch (error) {
          primaryFailure ??= error;
          controller.abort(error);
          throw error;
        } finally {
          release();
        }
      },
    );
  } catch (error) {
    throw primaryFailure ?? error;
  } finally {
    parentSignal.removeEventListener("abort", abortFromParent);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Upload canceled", "AbortError");
}
