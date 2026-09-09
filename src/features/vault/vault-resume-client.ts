import type { VaultCryptoClient } from "@/features/vault/vault-client";
import {
  vaultAutoLockDeadline,
  vaultResumeRecordExpiration,
} from "@/features/vault/vault-preferences";
import {
  clearVaultResumeMarker,
  createVaultResumeMarker,
  readVaultResumeMarker,
  type VaultResumeMarker,
  writeVaultResumeMarker,
} from "@/features/vault/vault-session";

export async function persistVaultResumeSession(
  client: VaultCryptoClient,
  sessionBinding: string,
  autoLockMinutes: number,
  vaultVersion: number,
  storage: Storage,
): Promise<VaultResumeMarker> {
  const expiresAt = vaultAutoLockDeadline(autoLockMinutes);
  const previous = readVaultResumeMarker(storage);
  const marker = createVaultResumeMarker(expiresAt);
  // One persistent record per browser for Never. A fresh login replaces its
  // key and session binding instead of accumulating non-expiring records.
  if (expiresAt === 0 && previous) marker.sessionId = previous.sessionId;
  if (!writeVaultResumeMarker(storage, marker)) {
    throw new Error("This browser cannot persist the vault session.");
  }
  try {
    await client.persistSession(
      marker.sessionId,
      sessionBinding,
      vaultResumeRecordExpiration(expiresAt),
      vaultVersion,
    );
    return marker;
  } catch (error) {
    clearVaultResumeMarker(storage);
    throw error;
  }
}
