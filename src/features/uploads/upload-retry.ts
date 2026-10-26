const DEFAULT_UPLOAD_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 400;
const RETRY_MAX_DELAY_MS = 10_000;

const TRANSIENT_UPLOAD_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const REFRESHABLE_SIGNATURE_MARKERS = [
  "expiredtoken",
  "requestexpired",
  "request has expired",
  "signaturedoesnotmatch",
  "authorizationqueryparameterserror",
];

export class UploadRequestError extends Error {
  readonly networkFailure: boolean;
  readonly responseBody: string;
  readonly retryAfter: string | null;
  readonly status: number | null;

  constructor({
    message,
    networkFailure = false,
    responseBody = "",
    retryAfter = null,
    status = null,
  }: {
    message: string;
    networkFailure?: boolean;
    responseBody?: string;
    retryAfter?: string | null;
    status?: number | null;
  }) {
    super(message);
    this.name = "UploadRequestError";
    this.networkFailure = networkFailure;
    this.responseBody = responseBody;
    this.retryAfter = retryAfter;
    this.status = status;
  }
}

export function getUploadFailureMessage(error: unknown): string {
  if (
    error instanceof TypeError ||
    (error instanceof UploadRequestError && error.networkFailure)
  ) {
    return "The upload could not be confirmed. Check your connection and try again. If it keeps failing, contact the administrator.";
  }
  if (error instanceof UploadRequestError && error.status === 403) {
    return "The storage service rejected the upload authorization. Try again. If it keeps failing, contact the administrator.";
  }
  return error instanceof Error && error.message
    ? error.message
    : "The upload could not finish. Please try again.";
}

type UploadRetryAction = "fail" | "refresh-url" | "retry";

export function classifyUploadFailure(error: unknown): UploadRetryAction {
  if (error instanceof UploadRequestError) {
    if (error.networkFailure) return "retry";
    if (
      error.status === 403 &&
      REFRESHABLE_SIGNATURE_MARKERS.some((marker) =>
        error.responseBody.toLowerCase().includes(marker),
      )
    ) {
      return "refresh-url";
    }
    return error.status !== null && TRANSIENT_UPLOAD_STATUSES.has(error.status)
      ? "retry"
      : "fail";
  }

  // Browser fetch reports transport failures as TypeError. Application and
  // validation errors use explicit Error subclasses and must not be retried.
  return error instanceof TypeError ? "retry" : "fail";
}

export function retryDelayMilliseconds(
  error: unknown,
  attempt: number,
  random: () => number = Math.random,
  now: () => number = Date.now,
): number {
  if (error instanceof UploadRequestError && error.retryAfter) {
    const retryAfter = error.retryAfter.trim();
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1_000);
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.max(0, retryAt - now());
    }
  }

  const ceiling = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt),
  );
  return Math.floor(Math.max(0, Math.min(1, random())) * ceiling);
}

export async function runUploadWithRetry<T>({
  initialUrl,
  maxAttempts = DEFAULT_UPLOAD_ATTEMPTS,
  onAttemptStart,
  random,
  refreshUrl,
  request,
  signal,
  wait = waitForUploadRetry,
}: {
  initialUrl: string;
  maxAttempts?: number;
  onAttemptStart?(): void;
  random?: () => number;
  refreshUrl?: () => Promise<string>;
  request(url: string): Promise<T>;
  signal: AbortSignal;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<T> {
  let url = initialUrl;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    throwIfUploadAborted(signal);
    onAttemptStart?.();

    try {
      return await request(url);
    } catch (error) {
      if (signal.aborted || isUploadAbortError(error)) throw error;
      lastError = error;
      const action = classifyUploadFailure(error);
      if (action === "fail" || attempt + 1 >= maxAttempts) throw error;

      if (action === "refresh-url") {
        if (!refreshUrl) throw error;
        url = await refreshUrl();
        continue;
      }

      await wait(retryDelayMilliseconds(error, attempt, random), signal);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("The object upload failed after multiple attempts.");
}

export async function uploadRequestErrorFromResponse(
  response: Response,
): Promise<UploadRequestError> {
  const responseBody = await response.text().catch(() => "");
  return new UploadRequestError({
    message: `Storage upload failed with status ${response.status}.`,
    responseBody,
    retryAfter: response.headers.get("Retry-After"),
    status: response.status,
  });
}

export function waitForUploadRetry(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Upload canceled", "AbortError"));
      return;
    }
    const cleanup = () => signal.removeEventListener("abort", abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new DOMException("Upload canceled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function throwIfUploadAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new DOMException("Upload canceled", "AbortError");
  }
}

function isUploadAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
