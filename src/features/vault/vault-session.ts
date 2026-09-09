import { randomPrefixedId } from "@/features/vault/protocol";
import { validVaultResumeExpiration } from "@/features/vault/vault-preferences";

export const VAULT_RESUME_STORAGE_KEY = "aeralyth:vault-resume-v1";

const VAULT_RESUME_MARKER_VERSION = 1;
const VAULT_RESUME_SESSION_ID_PATTERN = /^vrs_[A-Za-z0-9_-]{24}$/u;

export function vaultSessionStorage(autoLockMinutes: number): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return autoLockMinutes === 0 ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function clearVaultResumeMarkers(): void {
  for (const minutes of [0, 15]) {
    const storage = vaultSessionStorage(minutes);
    if (storage) clearVaultResumeMarker(storage);
  }
}

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
    if (
      parsed.version !== VAULT_RESUME_MARKER_VERSION ||
      typeof parsed.sessionId !== "string" ||
      !VAULT_RESUME_SESSION_ID_PATTERN.test(parsed.sessionId) ||
      !validVaultResumeExpiration(parsed.expiresAt, now)
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
