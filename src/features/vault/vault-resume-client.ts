import type { VaultCryptoClient } from "@/features/vault/vault-client";
import { normalizeVaultAutoLockMinutes } from "@/features/vault/vault-preferences";
import {
  clearVaultResumeMarker,
  createVaultResumeMarker,
  type VaultResumeMarker,
  writeVaultResumeMarker,
} from "@/features/vault/vault-session";

export const VAULT_RESUME_RECORD_GRACE_MS = 5_000;

export async function persistVaultResumeSession(
  client: VaultCryptoClient,
  sessionBinding: string,
  autoLockMinutes: number,
  vaultVersion: number,
  storage: Storage,
): Promise<VaultResumeMarker> {
  const expiresAt =
    Date.now() + normalizeVaultAutoLockMinutes(autoLockMinutes) * 60 * 1_000;
  const marker = createVaultResumeMarker(expiresAt);
  if (!writeVaultResumeMarker(storage, marker)) {
    throw new Error("This browser cannot persist the vault session.");
  }
  try {
    await client.persistSession(
      marker.sessionId,
      sessionBinding,
      expiresAt + VAULT_RESUME_RECORD_GRACE_MS,
      vaultVersion,
    );
    return marker;
  } catch (error) {
    clearVaultResumeMarker(storage);
    throw error;
  }
}
