import type { VaultUnlockMaterial } from "@/features/vault/protocol";
import { VaultWorkerError } from "@/features/vault/vault-client";

// Material fetched while the unlock dialog was open is reused only briefly so
// that a password change or recovery on another device is not masked by it.
export const UNLOCK_MATERIAL_PREFETCH_MAX_AGE_MS = 30_000;

type MaterialPrefetch = {
  startedAt: number;
  controller: AbortController;
  material: Promise<VaultUnlockMaterial | null>;
};

/**
 * Boots the vault worker and fetches unlock material while the user types, so
 * that a submit only waits for Argon2id. Nothing started here reports errors:
 * a prewarmed worker that dies or a prefetch that fails is replaced on submit.
 */
export class VaultUnlockPrewarm<Client> {
  private idleClient: Client | null = null;
  private prefetch: MaterialPrefetch | null = null;

  constructor(
    private readonly fetchMaterial: (
      signal?: AbortSignal,
    ) => Promise<VaultUnlockMaterial>,
    private readonly now: () => number = Date.now,
    private readonly maxMaterialAgeMs = UNLOCK_MATERIAL_PREFETCH_MAX_AGE_MS,
  ) {}

  start({
    currentClient,
    createClient,
    material,
  }: {
    currentClient: Client | null;
    createClient(): Client;
    material: boolean;
  }): void {
    if (!currentClient) {
      try {
        this.idleClient = createClient();
      } catch {
        this.idleClient = null;
      }
    }
    if (!material) return;
    if (this.prefetch && this.isFresh(this.prefetch)) return;
    this.clearMaterial();
    const controller = new AbortController();
    this.prefetch = {
      startedAt: this.now(),
      controller,
      material: this.fetchMaterial(controller.signal).catch(() => null),
    };
  }

  /** Marks a worker as used by an operation whose failures must be shown. */
  claimClient(client: Client): Client {
    if (this.idleClient === client) this.idleClient = null;
    return client;
  }

  /** Forgets a failed worker; true when only the prewarm had started it. */
  dropIdleClient(client: Client): boolean {
    if (this.idleClient !== client) return false;
    this.idleClient = null;
    return true;
  }

  async takeMaterial(): Promise<{
    material: VaultUnlockMaterial;
    prefetched: boolean;
  }> {
    const prefetch = this.prefetch;
    this.prefetch = null;
    if (prefetch && this.isFresh(prefetch)) {
      const material = await prefetch.material;
      if (material) return { material, prefetched: true };
    } else {
      prefetch?.controller.abort();
    }
    return { material: await this.fetchMaterial(), prefetched: false };
  }

  /**
   * Runs an unlock operation with the prefetched material. When the worker
   * rejects it, the material is fetched again and the operation is retried
   * once if the server's copy changed in the meantime.
   */
  async withMaterial<Result>(
    operation: (material: VaultUnlockMaterial) => Promise<Result>,
  ): Promise<Result> {
    const { material, prefetched } = await this.takeMaterial();
    try {
      return await operation(material);
    } catch (failure) {
      if (!prefetched || !isMaterialRejection(failure)) throw failure;
      const current = await this.fetchMaterial().catch(() => null);
      if (!current || sameUnlockMaterial(current, material)) throw failure;
      return operation(current);
    }
  }

  clearMaterial(): void {
    this.prefetch?.controller.abort();
    this.prefetch = null;
  }

  private isFresh(prefetch: MaterialPrefetch): boolean {
    return this.now() - prefetch.startedAt <= this.maxMaterialAgeMs;
  }
}

function isMaterialRejection(failure: unknown): boolean {
  return (
    failure instanceof VaultWorkerError &&
    failure.code !== "WORKER_UNAVAILABLE" &&
    failure.code !== "UNSUPPORTED_DEVICE"
  );
}

function sameUnlockMaterial(
  left: VaultUnlockMaterial,
  right: VaultUnlockMaterial,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
