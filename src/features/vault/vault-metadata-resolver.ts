import { estimateMetadataBytes } from "@/features/vault/metadata-size";
import { isVaultNodeId } from "@/features/vault/node-id";
import type {
  VaultDownloadPlan,
  VaultMetadataPlan,
  VaultMetadataReference,
} from "@/features/vault/protocol";
import { toBase64Url } from "@/features/vault/protocol";
import {
  getVaultFolderMetadataReferences,
  getVaultMetadataPlans,
} from "@/features/vault/vault-api";
import {
  type VaultCryptoClient,
  VaultWorkerError,
} from "@/features/vault/vault-client";
import type {
  VaultCachedMetadataResult,
  VaultMetadataOpenResult,
} from "@/features/vault/vault-messages";
import {
  recordVaultMetadataPerformance,
  vaultPerformanceNow,
} from "@/features/vault/vault-metadata-performance";
import { abortReason } from "@/lib/abort";

export type VaultMetadataResolutionOptions = {
  signal?: AbortSignal;
  requireServerValidation?: boolean;
  onCached?(results: VaultCachedMetadataResult[]): void;
  onPriority?(results: VaultMetadataOpenResult[]): void;
};

type ResolverContext = {
  csrfToken: string;
  client: VaultCryptoClient;
  openNode(
    nodeId: string,
    plan?: VaultDownloadPlan,
    signal?: AbortSignal,
  ): Promise<unknown>;
};

type PlanFlight = {
  promise: Promise<{ plans: VaultMetadataPlan[]; requestCount: number }>;
  controller: AbortController;
  consumers: number;
};

const METADATA_DECRYPTION_CONCURRENCY = 4;
const METADATA_PLAN_BATCH_SIZE = 100;
const METADATA_FIRST_VIEWPORT_COUNT = 24;
const METADATA_MEMORY_CACHE_LIMIT = 1_024;
const METADATA_MEMORY_CACHE_BYTES = 16 * 1024 * 1024;
const FOLDER_REFERENCE_CACHE_LIMIT = 200;

export class VaultMetadataResolver {
  private session = 0;
  private readonly metadata = new Map<string, VaultCachedMetadataResult>();
  private readonly plans = new Map<string, VaultMetadataPlan>();
  private readonly planFlights = new Map<string, PlanFlight>();
  private readonly folderFlights = new Map<string, Promise<void>>();
  private readonly prefetchedFolders = new Set<string>();
  private readonly folderReferences = new Map<
    string,
    VaultMetadataReference[]
  >();
  private readonly cacheAccounting = new Map<
    string,
    { bytes: number; touched: number }
  >();
  private cacheBytes = 0;
  private cacheClock = 0;
  private validationFlight = 0;
  private folderRevision = 0;

  invalidateFolders(folderIds: string[]): void {
    this.folderRevision += 1;
    this.folderFlights.clear();
    if (folderIds.length === 0) {
      this.folderReferences.clear();
      this.prefetchedFolders.clear();
      return;
    }
    for (const folderId of folderIds) {
      for (const view of ["files", "shared"] as const) {
        const key = folderReferenceKey(folderId || null, view);
        this.folderReferences.delete(key);
        this.prefetchedFolders.delete(key);
      }
    }
  }

  clear(): void {
    this.session += 1;
    this.folderRevision += 1;
    this.metadata.clear();
    this.plans.clear();
    for (const flight of this.planFlights.values()) flight.controller.abort();
    this.planFlights.clear();
    this.folderFlights.clear();
    this.prefetchedFolders.clear();
    this.folderReferences.clear();
    this.cacheAccounting.clear();
    this.cacheBytes = 0;
    this.cacheClock = 0;
  }

  remember(result: VaultCachedMetadataResult): void {
    this.rememberMetadata(result);
  }

  rememberFolder(
    folderId: string | null,
    view: "files" | "shared",
    references: VaultMetadataReference[],
  ): void {
    const key = folderReferenceKey(folderId, view);
    for (const reference of references) assertVaultMetadataReference(reference);
    const current = this.folderReferences.get(key);
    if (!sameMetadataReferences(current, references)) {
      this.prefetchedFolders.delete(key);
    }
    this.folderReferences.delete(key);
    this.folderReferences.set(
      key,
      references.map((reference) => ({ ...reference })),
    );
    while (this.folderReferences.size > FOLDER_REFERENCE_CACHE_LIMIT) {
      const oldest = this.folderReferences.keys().next().value;
      if (typeof oldest !== "string") break;
      this.folderReferences.delete(oldest);
    }
  }

  async resolve(
    references: VaultMetadataReference[],
    context: ResolverContext,
    options: VaultMetadataResolutionOptions = {},
  ): Promise<VaultMetadataOpenResult[]> {
    const session = this.session;
    const unique = new Map<string, VaultMetadataReference>();
    for (const reference of references) {
      assertVaultMetadataReference(reference);
      unique.set(
        revisionKey(reference.nodeId, reference.recordHash),
        reference,
      );
    }
    const orderedReferences = [...unique.values()];
    const fullPageStartedAt = vaultPerformanceNow();
    const cacheLookupStartedAt = fullPageStartedAt;
    const resolved = new Map<string, VaultMetadataOpenResult>();
    const persistentCandidates: VaultMetadataReference[] = [];
    for (const reference of orderedReferences) {
      const key = revisionKey(reference.nodeId, reference.recordHash);
      const cached = options.requireServerValidation
        ? undefined
        : this.getMetadata(key);
      if (
        cached &&
        toBase64Url(cached.manifest.generationId) === reference.generationId
      ) {
        resolved.set(key, cached);
      } else {
        persistentCandidates.push(reference);
      }
    }

    const persistentHits =
      persistentCandidates.length === 0 || options.requireServerValidation
        ? []
        : await context.client.getCachedMetadata(
            persistentCandidates,
            options.signal,
          );
    this.assertSession(session);
    for (const cached of persistentHits) {
      this.remember(cached);
      resolved.set(revisionKey(cached.nodeId, cached.recordHash), cached);
    }
    const cachedResults = orderedReferences.flatMap((reference) => {
      const result = resolved.get(
        revisionKey(reference.nodeId, reference.recordHash),
      );
      return result?.status === "ready" ? [result] : [];
    });
    if (cachedResults.length > 0) options.onCached?.(cachedResults);

    const misses = orderedReferences.filter(
      (reference) =>
        !resolved.has(revisionKey(reference.nodeId, reference.recordHash)),
    );
    recordVaultMetadataPerformance("cache_lookup", cacheLookupStartedAt, {
      nodeCount: orderedReferences.length,
      cacheHits: cachedResults.length,
      cacheMisses: misses.length,
    });
    if (misses.length === 0) {
      recordVaultMetadataPerformance("first_viewport", fullPageStartedAt, {
        nodeCount: orderedReferences.length,
        cacheHits: cachedResults.length,
        cacheMisses: 0,
      });
      recordVaultMetadataPerformance("full_page", fullPageStartedAt, {
        nodeCount: orderedReferences.length,
        cacheHits: cachedResults.length,
        cacheMisses: 0,
      });
      return orderedReferences.map(
        (reference) =>
          resolved.get(
            revisionKey(reference.nodeId, reference.recordHash),
          ) as VaultMetadataOpenResult,
      );
    }

    const batchRequestStartedAt = vaultPerformanceNow();
    const cachedPlans = options.requireServerValidation
      ? []
      : misses.flatMap((reference) => {
          const plan = this.getPlan(
            revisionKey(reference.nodeId, reference.recordHash),
          );
          return plan && metadataPlanMatchesReference(plan, reference)
            ? [plan]
            : [];
        });
    const uncachedReferences = misses.filter((reference) => {
      if (options.requireServerValidation) return true;
      const plan = this.getPlan(
        revisionKey(reference.nodeId, reference.recordHash),
      );
      return !plan || !metadataPlanMatchesReference(plan, reference);
    });
    let fetched = { plans: [] as VaultMetadataPlan[], requestCount: 0 };
    if (uncachedReferences.length > 0) {
      const lease = this.loadPlans(
        context.csrfToken,
        uncachedReferences,
        session,
        options.requireServerValidation === true,
      );
      try {
        fetched = await waitForOperation(lease.promise, options.signal);
      } finally {
        lease.release();
      }
    }
    const fetchedPlans = fetched.plans;
    this.assertSession(session);
    recordVaultMetadataPerformance("batch_request", batchRequestStartedAt, {
      nodeCount: uncachedReferences.length,
      planCacheHits: cachedPlans.length,
      networkRequests: fetched.requestCount,
    });

    const expectedByNode = new Map(
      misses.map((reference) => [reference.nodeId, reference]),
    );
    const compatiblePlans = [...fetchedPlans, ...cachedPlans].filter((plan) => {
      const expected = expectedByNode.get(plan.nodeId);
      return !expected || metadataPlanMatchesReference(plan, expected);
    });
    const plans = [
      ...new Map(
        compatiblePlans.map((plan) => [
          revisionKey(plan.nodeId, plan.recordHash),
          plan,
        ]),
      ).values(),
    ];
    const planByRevision = new Map(
      plans.map((plan) => [revisionKey(plan.nodeId, plan.recordHash), plan]),
    );
    const targetKeys = new Set(
      misses.map((reference) =>
        revisionKey(reference.nodeId, reference.recordHash),
      ),
    );
    let priorityCount = 0;
    let visiblePlans = 0;
    for (const plan of plans) {
      priorityCount += 1;
      if (targetKeys.has(revisionKey(plan.nodeId, plan.recordHash))) {
        visiblePlans += 1;
      }
      if (visiblePlans >= METADATA_FIRST_VIEWPORT_COUNT) break;
    }

    const workerStartedAt = vaultPerformanceNow();
    let firstViewportRecorded = false;
    let opened = await context.client.openMetadataPlans(plans, {
      concurrency: METADATA_DECRYPTION_CONCURRENCY,
      priorityCount,
      signal: options.signal,
      onPriority: (results) => {
        if (session !== this.session || options.signal?.aborted) return;
        const visible = results.filter((result) =>
          targetKeys.has(revisionKey(result.nodeId, result.recordHash)),
        );
        for (const result of results) {
          if (result.status === "ready") this.remember(result);
        }
        if (visible.length === 0) return;
        if (!firstViewportRecorded) {
          firstViewportRecorded = true;
          recordVaultMetadataPerformance("first_viewport", fullPageStartedAt, {
            nodeCount: orderedReferences.length,
            readyCount: visible.filter((result) => result.status === "ready")
              .length,
            cacheHits: cachedResults.length,
            cacheMisses: misses.length,
          });
        }
        options.onPriority?.(visible);
      },
    });
    this.assertSession(session);

    const parentFailures = opened.filter(
      (result) =>
        result.status === "unavailable" &&
        result.code === "PARENT_KEY_REQUIRED" &&
        targetKeys.has(revisionKey(result.nodeId, result.recordHash)),
    );
    if (parentFailures.length > 0) {
      const parentIds = new Set(
        parentFailures
          .map(getRequiredMetadataParentId)
          .filter((parentId): parentId is string => parentId !== null),
      );
      const parentResolutionStartedAt = vaultPerformanceNow();
      await Promise.all(
        [...parentIds].map((parentId) =>
          context.openNode(parentId, undefined, options.signal),
        ),
      );
      this.assertSession(session);
      recordVaultMetadataPerformance(
        "parent_key_resolution",
        parentResolutionStartedAt,
        { parentCount: parentIds.size },
      );
      const retryPlans = parentFailures.flatMap((failure) => {
        const plan = planByRevision.get(
          revisionKey(failure.nodeId, failure.recordHash),
        );
        return plan ? [plan] : [];
      });
      if (retryPlans.length > 0) {
        const retryResults = await context.client.openMetadataPlans(
          retryPlans,
          {
            concurrency: METADATA_DECRYPTION_CONCURRENCY,
            priorityCount: retryPlans.length,
            signal: options.signal,
          },
        );
        this.assertSession(session);
        const retryByRevision = new Map(
          retryResults.map((result) => [
            revisionKey(result.nodeId, result.recordHash),
            result,
          ]),
        );
        opened = opened.map(
          (result) =>
            retryByRevision.get(
              revisionKey(result.nodeId, result.recordHash),
            ) ?? result,
        );
      }
    }

    for (const result of opened) {
      if (result.status === "ready") this.remember(result);
      if (targetKeys.has(revisionKey(result.nodeId, result.recordHash))) {
        resolved.set(revisionKey(result.nodeId, result.recordHash), result);
      }
    }
    for (const reference of misses) {
      const key = revisionKey(reference.nodeId, reference.recordHash);
      if (!resolved.has(key)) {
        resolved.set(key, {
          status: "unavailable",
          nodeId: reference.nodeId,
          recordHash: reference.recordHash,
          error: "Encrypted metadata is unavailable for this revision.",
        });
      }
    }
    recordVaultMetadataPerformance("worker_batch", workerStartedAt, {
      nodeCount: plans.length,
      concurrency: METADATA_DECRYPTION_CONCURRENCY,
    });
    if (!firstViewportRecorded) {
      recordVaultMetadataPerformance("first_viewport", fullPageStartedAt, {
        nodeCount: orderedReferences.length,
        readyCount: [...resolved.values()].filter(
          (result) => result.status === "ready",
        ).length,
        cacheHits: cachedResults.length,
        cacheMisses: misses.length,
      });
    }
    recordVaultMetadataPerformance("full_page", fullPageStartedAt, {
      nodeCount: orderedReferences.length,
      cacheHits: cachedResults.length,
      cacheMisses: misses.length,
    });
    return orderedReferences.map(
      (reference) =>
        resolved.get(
          revisionKey(reference.nodeId, reference.recordHash),
        ) as VaultMetadataOpenResult,
    );
  }

  prefetchFolder(
    folderId: string,
    view: "files" | "shared",
    context: ResolverContext,
  ): Promise<void> {
    if (!isVaultNodeId(folderId)) return Promise.resolve();
    const key = `${view}:${folderId}`;
    if (this.prefetchedFolders.has(key)) return Promise.resolve();
    const existing = this.folderFlights.get(key);
    if (existing) return existing;
    const session = this.session;
    const folderRevision = this.folderRevision;
    const operation = (async () => {
      try {
        const listingStartedAt = vaultPerformanceNow();
        const cachedReferences = this.folderReferences.get(key);
        const references =
          cachedReferences ??
          (await getVaultFolderMetadataReferences(folderId, view));
        this.assertSession(session);
        if (folderRevision !== this.folderRevision) return;
        recordVaultMetadataPerformance("folder_listing", listingStartedAt, {
          nodeCount: references.length,
          cacheHits: cachedReferences ? references.length : 0,
          cacheMisses: cachedReferences ? 0 : references.length,
          networkRequests: cachedReferences ? 0 : 1,
        });
        if (!cachedReferences) this.rememberFolder(folderId, view, references);
        if (references.length > 0) {
          await this.resolve(references, context, {
            requireServerValidation: view === "shared",
          });
        }
        this.assertSession(session);
        if (folderRevision !== this.folderRevision) return;
        this.prefetchedFolders.add(key);
      } catch {
        // Prefetch is opportunistic; navigation performs the authoritative load.
      }
    })();
    this.folderFlights.set(key, operation);
    const clearFlight = () => {
      if (this.folderFlights.get(key) === operation) {
        this.folderFlights.delete(key);
      }
    };
    void operation.then(clearFlight, clearFlight);
    return operation;
  }

  private loadPlans(
    csrfToken: string,
    references: VaultMetadataReference[],
    session: number,
    requireServerValidation: boolean,
  ): {
    promise: Promise<{ plans: VaultMetadataPlan[]; requestCount: number }>;
    release(): void;
  } {
    const revisionSet = references
      .map((reference) => revisionKey(reference.nodeId, reference.recordHash))
      .sort()
      .join("|");
    this.validationFlight += 1;
    const requestKey = requireServerValidation
      ? `validated:${session}:${this.validationFlight}:${revisionSet}`
      : revisionSet;
    const existing = requireServerValidation
      ? undefined
      : this.planFlights.get(requestKey);
    if (existing) {
      existing.consumers += 1;
      return this.planLease(requestKey, existing);
    }
    const controller = new AbortController();
    const request = (async () => {
      const plans: VaultMetadataPlan[] = [];
      let requestCount = 0;
      for (
        let offset = 0;
        offset < references.length;
        offset += METADATA_PLAN_BATCH_SIZE
      ) {
        this.assertSession(session);
        const nodeIds = references
          .slice(offset, offset + METADATA_PLAN_BATCH_SIZE)
          .map((reference) => reference.nodeId);
        let continuation: number | undefined;
        let snapshot: string | undefined;
        do {
          const response = await getVaultMetadataPlans(
            csrfToken,
            nodeIds,
            continuation,
            controller.signal,
            undefined,
            snapshot,
          );
          requestCount += 1;
          plans.push(...response.plans);
          if (
            response.continuation !== undefined &&
            (!Number.isSafeInteger(response.continuation) ||
              response.continuation <= (continuation ?? -1))
          ) {
            throw new Error("The metadata plan continuation is invalid.");
          }
          if (snapshot && response.snapshot !== snapshot) {
            throw new Error(
              "The metadata snapshot changed. Refresh and retry.",
            );
          }
          snapshot = response.snapshot;
          continuation = response.continuation;
        } while (continuation !== undefined);
      }
      if (session === this.session) {
        for (const plan of plans) this.rememberPlan(plan);
      }
      return { plans, requestCount };
    })();
    const flight: PlanFlight = {
      promise: request,
      controller,
      consumers: 1,
    };
    this.planFlights.set(requestKey, flight);
    const clearFlight = () => {
      if (this.planFlights.get(requestKey) === flight) {
        this.planFlights.delete(requestKey);
      }
    };
    void request.then(clearFlight, clearFlight);
    return this.planLease(requestKey, flight);
  }

  private planLease(
    requestKey: string,
    flight: PlanFlight,
  ): {
    promise: Promise<{ plans: VaultMetadataPlan[]; requestCount: number }>;
    release(): void;
  } {
    let released = false;
    return {
      promise: flight.promise,
      release: () => {
        if (released) return;
        released = true;
        flight.consumers -= 1;
        if (
          flight.consumers === 0 &&
          this.planFlights.get(requestKey) === flight
        ) {
          flight.controller.abort();
        }
      },
    };
  }

  private assertSession(session: number): void {
    if (session !== this.session) {
      throw new VaultWorkerError(
        "The vault was locked during this operation.",
        "VAULT_LOCKED",
      );
    }
  }

  private getMetadata(key: string): VaultCachedMetadataResult | undefined {
    const value = this.metadata.get(key);
    if (value) this.touchCache("metadata", key);
    return value;
  }

  private getPlan(key: string): VaultMetadataPlan | undefined {
    const value = this.plans.get(key);
    if (value) this.touchCache("plan", key);
    return value;
  }

  private rememberMetadata(value: VaultCachedMetadataResult): void {
    this.rememberCacheValue(
      "metadata",
      this.metadata,
      value,
      estimateMetadataBytes(value),
    );
  }

  private rememberPlan(value: VaultMetadataPlan): void {
    this.rememberCacheValue(
      "plan",
      this.plans,
      value,
      estimateMetadataPlanBytes(value),
    );
  }

  private rememberCacheValue<
    Value extends { nodeId: string; recordHash: string },
  >(
    kind: "metadata" | "plan",
    cache: Map<string, Value>,
    value: Value,
    bytes: number,
  ): void {
    const key = revisionKey(value.nodeId, value.recordHash);
    for (const existingKey of cache.keys()) {
      if (existingKey !== key && existingKey.startsWith(`${value.nodeId}:`)) {
        this.evictCacheValue(kind, existingKey);
      }
    }
    this.evictCacheValue(kind, key);
    cache.set(key, value);
    const accountingKey = cacheAccountingKey(kind, key);
    this.cacheClock += 1;
    this.cacheAccounting.set(accountingKey, {
      bytes,
      touched: this.cacheClock,
    });
    this.cacheBytes += bytes;
    this.trimCaches();
  }

  private touchCache(kind: "metadata" | "plan", key: string): void {
    const accounting = this.cacheAccounting.get(cacheAccountingKey(kind, key));
    if (accounting) accounting.touched = this.cacheClock += 1;
  }

  private evictCacheValue(kind: "metadata" | "plan", key: string): void {
    const accountingKey = cacheAccountingKey(kind, key);
    const accounting = this.cacheAccounting.get(accountingKey);
    if (accounting) {
      this.cacheBytes -= accounting.bytes;
      this.cacheAccounting.delete(accountingKey);
    }
    (kind === "metadata" ? this.metadata : this.plans).delete(key);
  }

  private trimCaches(): void {
    while (
      this.cacheAccounting.size > METADATA_MEMORY_CACHE_LIMIT ||
      this.cacheBytes > METADATA_MEMORY_CACHE_BYTES
    ) {
      let oldestKey: string | undefined;
      let oldestTouch = Number.POSITIVE_INFINITY;
      for (const [key, value] of this.cacheAccounting) {
        if (value.touched < oldestTouch) {
          oldestTouch = value.touched;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      const separator = oldestKey.indexOf(":");
      const kind = oldestKey.slice(0, separator) as "metadata" | "plan";
      this.evictCacheValue(kind, oldestKey.slice(separator + 1));
    }
  }
}

function getRequiredMetadataParentId(
  result: VaultMetadataOpenResult,
): string | null {
  if (
    result.status !== "unavailable" ||
    result.code !== "PARENT_KEY_REQUIRED"
  ) {
    return null;
  }
  const separator = result.error.lastIndexOf(":");
  const parentId = separator >= 0 ? result.error.slice(separator + 1) : "";
  return isVaultNodeId(parentId) ? parentId : null;
}

function assertVaultMetadataReference(reference: VaultMetadataReference): void {
  const base64Url = /^[A-Za-z0-9_-]+$/u;
  if (
    !isVaultNodeId(reference.nodeId) ||
    (reference.parentId !== null && !isVaultNodeId(reference.parentId)) ||
    !Number.isSafeInteger(reference.recordVersion) ||
    reference.recordVersion < 1 ||
    reference.recordHash.length !== 43 ||
    !base64Url.test(reference.recordHash) ||
    reference.generationId.length !== 22 ||
    !base64Url.test(reference.generationId)
  ) {
    throw new Error("The server returned an invalid metadata revision.");
  }
}

function revisionKey(nodeId: string, recordHash: string): string {
  return `${nodeId}:${recordHash}`;
}

function folderReferenceKey(
  folderId: string | null,
  view: "files" | "shared",
): string {
  return `${view}:${folderId ?? "root"}`;
}

function metadataPlanMatchesReference(
  plan: VaultMetadataPlan,
  reference: VaultMetadataReference,
): boolean {
  return (
    plan.nodeId === reference.nodeId &&
    plan.recordVersion === reference.recordVersion &&
    plan.recordHash === reference.recordHash &&
    plan.generationId === reference.generationId
  );
}

function sameMetadataReferences(
  left: VaultMetadataReference[] | undefined,
  right: VaultMetadataReference[],
): boolean {
  return (
    left?.length === right.length &&
    right.every((reference, index) => {
      const candidate = left[index];
      return (
        candidate?.nodeId === reference.nodeId &&
        candidate.parentId === reference.parentId &&
        candidate.recordVersion === reference.recordVersion &&
        candidate.recordHash === reference.recordHash &&
        candidate.generationId === reference.generationId
      );
    })
  );
}

function cacheAccountingKey(
  kind: "metadata" | "plan",
  revision: string,
): string {
  return `${kind}:${revision}`;
}

function estimateMetadataPlanBytes(plan: VaultMetadataPlan): number {
  return (
    512 +
    plan.nodeId.length * 2 +
    plan.generationId.length * 2 +
    plan.ciphertextMerkleRoot.length * 2 +
    plan.bootstrapCbor.length * 2 +
    plan.bootstrapSignature.length * 2 +
    plan.encryptedManifest.length * 2 +
    plan.wrappers.reduce((total, wrapper) => total + wrapper.length * 2, 0) +
    plan.signerEd25519PublicKey.length * 2 +
    plan.recordHash.length * 2 +
    (plan.share === null ? 0 : JSON.stringify(plan.share).length * 2)
  );
}

function waitForOperation<Value>(
  operation: Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (failure: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(failure);
      },
    );
  });
}
