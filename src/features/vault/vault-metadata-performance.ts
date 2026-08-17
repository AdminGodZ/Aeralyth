export const VAULT_METADATA_PERFORMANCE_EVENT =
  "aeralyth:vault-metadata-performance";

export type VaultMetadataStage =
  | "cache_lookup"
  | "batch_request"
  | "folder_listing"
  | "parent_key_resolution"
  | "react_commit"
  | "first_viewport"
  | "worker_batch"
  | "full_page";

type NumericDetail = Record<string, number>;

const MAX_SAMPLES_PER_STAGE = 200;
const samples = new Map<VaultMetadataStage, number[]>();

export function vaultPerformanceNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function markVaultFolderClick(): void {
  if (typeof performance === "undefined" || !performance.mark) return;
  try {
    performance.clearMarks?.("aeralyth:vault:folder_click");
    performance.mark("aeralyth:vault:folder_click");
  } catch {
    // Performance telemetry must never delay or fail folder navigation.
  }
}

export function recordVaultMetadataPerformance(
  stage: VaultMetadataStage,
  startedAt: number,
  detail: NumericDetail,
): number {
  const endedAt = vaultPerformanceNow();
  const duration = Math.max(0, endedAt - startedAt);
  const stageSamples = samples.get(stage) ?? [];
  stageSamples.push(duration);
  if (stageSamples.length > MAX_SAMPLES_PER_STAGE) stageSamples.shift();
  samples.set(stage, stageSamples);

  if (typeof performance !== "undefined" && performance.measure) {
    try {
      const measureName = `aeralyth:vault:${stage}`;
      performance.clearMeasures?.(measureName);
      performance.measure(measureName, {
        start: startedAt,
        end: endedAt,
        detail: { ...detail, duration },
      });
    } catch {
      // Performance telemetry must never delay or fail folder navigation.
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(VAULT_METADATA_PERFORMANCE_EVENT, {
        detail: {
          stage,
          duration,
          ...detail,
          summary: vaultMetadataPerformanceSummary(stage),
        },
      }),
    );
  }
  return duration;
}

export function vaultMetadataPerformanceSummary(stage: VaultMetadataStage): {
  samples: number;
  p50: number;
  p95: number;
  p99: number;
} {
  const ordered = [...(samples.get(stage) ?? [])].sort(
    (left, right) => left - right,
  );
  return {
    samples: ordered.length,
    p50: percentile(ordered, 0.5),
    p95: percentile(ordered, 0.95),
    p99: percentile(ordered, 0.99),
  };
}

function percentile(ordered: number[], quantile: number): number {
  if (ordered.length === 0) return 0;
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * quantile) - 1),
  );
  return ordered[index];
}
