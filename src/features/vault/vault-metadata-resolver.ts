import { detectedCryptoConcurrency } from "@/features/vault/bounded-async";
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

export type VaultMetadataResolutionOptions = {
  signal?: AbortSignal;
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

const METADATA_DECRYPTION_CONCURRENCY = detectedCryptoConcurrency(30);
const METADATA_FIRST_VIEWPORT_COUNT = 24;
const METADATA_MEMORY_CACHE_LIMIT = 1_000;
const FOLDER_REFERENCE_CACHE_LIMIT = 200;

export class VaultMetadataResolver {
  private session = 0;
  private readonly metadata = new Map<string, VaultCachedMetadataResult>();
  private readonly plans = new Map<string, VaultMetadataPlan>();
  private readonly planFlights = new Map<
    string,
    Promise<{ plans: VaultMetadataPlan[] }>
  >();
  private readonly folderFlights = new Map<string, Promise<void>>();
  private readonly prefetchedFolders = new Set<string>();
  private readonly folderReferences = new Map<
    string,
    VaultMetadataReference[]
  >();

  clear(): void {
    this.session += 1;
    this.metadata.clear();
    this.plans.clear();
    this.planFlights.clear();
    this.folderFlights.clear();
    this.prefetchedFolders.clear();
    this.folderReferences.clear();
  }

  remember(result: VaultCachedMetadataResult): void {
    rememberRevision(this.metadata, result);
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
      const cached = this.metadata.get(key);
      if (
        cached &&
        toBase64Url(cached.manifest.generationId) === reference.generationId
      ) {
        this.metadata.delete(key);
        this.metadata.set(key, cached);
        resolved.set(key, cached);
      } else {
        persistentCandidates.push(reference);
      }
    }

    const persistentHits =
      persistentCandidates.length === 0
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
    const cachedPlans = misses.flatMap((reference) => {
      const plan = this.plans.get(
        revisionKey(reference.nodeId, reference.recordHash),
      );
      return plan && metadataPlanMatchesReference(plan, reference)
        ? [plan]
        : [];
    });
    const uncachedReferences = misses.filter((reference) => {
      const plan = this.plans.get(
        revisionKey(reference.nodeId, reference.recordHash),
      );
      return !plan || !metadataPlanMatchesReference(plan, reference);
    });
    const fetchedPlans =
      uncachedReferences.length === 0
        ? []
        : (
            await waitForOperation(
              this.loadPlans(context.csrfToken, uncachedReferences, session),
              options.signal,
            )
          ).plans;
    this.assertSession(session);
    recordVaultMetadataPerformance("batch_request", batchRequestStartedAt, {
      nodeCount: uncachedReferences.length,
      planCacheHits: cachedPlans.length,
      networkRequests: uncachedReferences.length > 0 ? 1 : 0,
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
    const operation = (async () => {
      try {
        const listingStartedAt = vaultPerformanceNow();
        const cachedReferences = this.folderReferences.get(key);
        const references =
          cachedReferences ??
          (await getVaultFolderMetadataReferences(folderId, view));
        this.assertSession(session);
        recordVaultMetadataPerformance("folder_listing", listingStartedAt, {
          nodeCount: references.length,
          cacheHits: cachedReferences ? references.length : 0,
          cacheMisses: cachedReferences ? 0 : references.length,
          networkRequests: cachedReferences ? 0 : 1,
        });
        if (!cachedReferences) this.rememberFolder(folderId, view, references);
        if (references.length > 0) {
          await this.resolve(references, context);
        }
        this.assertSession(session);
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
  ): Promise<{ plans: VaultMetadataPlan[] }> {
    const requestKey = references
      .map((reference) => revisionKey(reference.nodeId, reference.recordHash))
      .sort()
      .join("|");
    const existing = this.planFlights.get(requestKey);
    if (existing) return existing;
    const request = getVaultMetadataPlans(
      csrfToken,
      references.map((reference) => reference.nodeId),
    ).then((response) => {
      if (session === this.session) {
        for (const plan of response.plans) rememberRevision(this.plans, plan);
      }
      return response;
    });
    this.planFlights.set(requestKey, request);
    const clearFlight = () => {
      if (this.planFlights.get(requestKey) === request) {
        this.planFlights.delete(requestKey);
      }
    };
    void request.then(clearFlight, clearFlight);
    return request;
  }

  private assertSession(session: number): void {
    if (session !== this.session) {
      throw new VaultWorkerError(
        "The vault was locked during this operation.",
        "VAULT_LOCKED",
      );
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

function rememberRevision<Value extends { nodeId: string; recordHash: string }>(
  cache: Map<string, Value>,
  value: Value,
): void {
  const key = revisionKey(value.nodeId, value.recordHash);
  for (const existingKey of cache.keys()) {
    if (existingKey !== key && existingKey.startsWith(`${value.nodeId}:`)) {
      cache.delete(existingKey);
    }
  }
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > METADATA_MEMORY_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== "string") break;
    cache.delete(oldest);
  }
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

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("The operation was aborted.", "AbortError")
  );
}
