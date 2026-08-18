import { randomPrefixedId } from "@/features/vault/protocol";

export const VAULT_RESUME_STORAGE_KEY = "aeralyth:vault-resume-v1";

const VAULT_RESUME_MARKER_VERSION = 1;
const VAULT_RESUME_SESSION_ID_PATTERN = /^vrs_[A-Za-z0-9_-]{24}$/u;
const MAX_VAULT_RESUME_MINUTES = 60;
const VAULT_RESUME_CLOCK_SKEW_MS = 60_000;

export type VaultResumeMarker = {
  version: typeof VAULT_RESUME_MARKER_VERSION;
  sessionId: string;
  expiresAt: number;
};

export function createVaultResumeMarker(expiresAt: number): VaultResumeMarker {
  return {
    version: VAULT_RESUME_MARKER_VERSION,
    sessionId: randomPrefixedId("vrs_"),
    expiresAt,
  };
}

export function readVaultResumeMarker(
  storage: Storage,
  now = Date.now(),
): VaultResumeMarker | null {
  let raw: string | null;
  try {
    raw = storage.getItem(VAULT_RESUME_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<VaultResumeMarker>;
    const latestAllowedExpiration =
      now + MAX_VAULT_RESUME_MINUTES * 60_000 + VAULT_RESUME_CLOCK_SKEW_MS;
    if (
      parsed.version !== VAULT_RESUME_MARKER_VERSION ||
      typeof parsed.sessionId !== "string" ||
      !VAULT_RESUME_SESSION_ID_PATTERN.test(parsed.sessionId) ||
      typeof parsed.expiresAt !== "number" ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      parsed.expiresAt <= now ||
      parsed.expiresAt > latestAllowedExpiration
    ) {
      clearVaultResumeMarker(storage);
      return null;
    }
    return parsed as VaultResumeMarker;
  } catch {
    clearVaultResumeMarker(storage);
    return null;
  }
}

export function writeVaultResumeMarker(
  storage: Storage,
  marker: VaultResumeMarker,
): boolean {
  try {
    storage.setItem(VAULT_RESUME_STORAGE_KEY, JSON.stringify(marker));
    return true;
  } catch {
    return false;
  }
}

export function clearVaultResumeMarker(storage: Storage): void {
  try {
    storage.removeItem(VAULT_RESUME_STORAGE_KEY);
  } catch {
    // Storage can be unavailable under restrictive browser policies. The
    // in-memory vault still locks even when its tab marker cannot be removed.
  }
}
