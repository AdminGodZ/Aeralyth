export const VAULT_AUTO_LOCK_OPTIONS = [5, 15, 30, 60, 0] as const;

export type VaultAutoLockMinutes = (typeof VAULT_AUTO_LOCK_OPTIONS)[number];

export const VAULT_AUTO_LOCK_CHANGE_EVENT = "aeralyth:vault-auto-lock-change";

export function normalizeVaultAutoLockMinutes(
  value: number,
): VaultAutoLockMinutes {
  return VAULT_AUTO_LOCK_OPTIONS.includes(value as VaultAutoLockMinutes)
    ? (value as VaultAutoLockMinutes)
    : 15;
}

/** Zero means the authenticated session has no inactivity deadline. */
export function vaultAutoLockDeadline(
  minutes: number,
  now = Date.now(),
): number {
  const duration = normalizeVaultAutoLockMinutes(minutes);
  return duration === 0 ? 0 : now + duration * 60_000;
}

export function validVaultResumeExpiration(
  value: unknown,
  now = Date.now(),
): value is number {
  return (
    value === 0 ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > now &&
      value <= now + 61 * 60_000)
  );
}

export function vaultResumeRecordExpiration(expiresAt: number): number {
  return expiresAt === 0 ? 0 : expiresAt + 5_000;
}
