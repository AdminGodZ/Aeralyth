export type TransferStage = "network" | "decrypt" | "sink";
export type TransferOutcome = "completed" | "failed" | "canceled";
export type TransferMetric = {
  outcome: TransferOutcome;
  durationMs: number;
  ciphertextBytes: number;
  plaintextBytes: number;
  stages: Record<TransferStage, { durationMs: number; operations: number }>;
};

const MAX_RECENT_TRANSFERS = 32;
const samples: TransferMetric[] = [];
const listeners = new Set<(sample: TransferMetric) => void>();

// Diagnostics deliberately contain no filenames, node IDs, URLs, or content.
// Stage durations may overlap and are not intended to sum to wall-clock time.
export function createTransferMetrics() {
  const started = performance.now();
  const stages: TransferMetric["stages"] = {
    network: { durationMs: 0, operations: 0 },
    decrypt: { durationMs: 0, operations: 0 },
    sink: { durationMs: 0, operations: 0 },
  };
  let ciphertextBytes = 0;
  let plaintextBytes = 0;
  let finished: TransferMetric | null = null;

  return {
    async measure<T>(stage: TransferStage, task: () => Promise<T>): Promise<T> {
      const before = performance.now();
      try {
        return await task();
      } finally {
        if (!finished) {
          stages[stage].durationMs += Math.max(0, performance.now() - before);
          stages[stage].operations += 1;
        }
      }
    },
    addBytes(ciphertext: number, plaintext = 0): void {
      if (finished) return;
      if (Number.isSafeInteger(ciphertext) && ciphertext > 0) {
        ciphertextBytes += ciphertext;
      }
      if (Number.isSafeInteger(plaintext) && plaintext > 0) {
        plaintextBytes += plaintext;
      }
    },
    finish(outcome: TransferOutcome): TransferMetric {
      if (finished) return cloneSample(finished);
      finished = {
        outcome,
        durationMs: Math.max(0, performance.now() - started),
        ciphertextBytes,
        plaintextBytes,
        stages,
      };
      samples.push(cloneSample(finished));
      if (samples.length > MAX_RECENT_TRANSFERS) samples.shift();
      for (const listener of listeners) {
        try {
          listener(cloneSample(finished));
        } catch {
          // An optional diagnostics consumer must not fail a file transfer.
        }
      }
      return cloneSample(finished);
    },
  };
}

export function recentTransferMetrics(): TransferMetric[] {
  return samples.map(cloneSample);
}

export function subscribeTransferMetrics(
  listener: (sample: TransferMetric) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function cloneSample(sample: TransferMetric): TransferMetric {
  return {
    ...sample,
    stages: {
      network: { ...sample.stages.network },
      decrypt: { ...sample.stages.decrypt },
      sink: { ...sample.stages.sink },
    },
  };
}
