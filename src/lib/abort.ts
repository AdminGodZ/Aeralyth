/** The signal's own abort reason, or an `AbortError` carrying `message`. */
export function abortReason(
  signal: AbortSignal | undefined,
  message = "The operation was aborted.",
): unknown {
  return signal?.reason ?? new DOMException(message, "AbortError");
}

export function throwIfAborted(
  signal: AbortSignal | undefined,
  message?: string,
): void {
  if (signal?.aborted) throw abortReason(signal, message);
}

export function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === "AbortError";
}
