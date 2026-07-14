export const VAULT_AUTO_LOCK_OPTIONS = [5, 15, 30, 60] as const;

export type VaultAutoLockMinutes = (typeof VAULT_AUTO_LOCK_OPTIONS)[number];

export const VAULT_AUTO_LOCK_CHANGE_EVENT = "aeralyth:vault-auto-lock-change";

export function normalizeVaultAutoLockMinutes(
  value: number,
): VaultAutoLockMinutes {
  return VAULT_AUTO_LOCK_OPTIONS.includes(value as VaultAutoLockMinutes)
    ? (value as VaultAutoLockMinutes)
    : 15;
}
