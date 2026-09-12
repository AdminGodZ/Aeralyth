import type { downloadEncryptedFile } from "@/features/vault/encrypted-download";
import {
  VAULT_CRYPTO_CHUNK_BYTES,
  type VaultDownloadPlan,
  type VaultManifest,
} from "@/features/vault/protocol";
import type { VaultCryptoClient } from "@/features/vault/vault-client";

type Download = typeof downloadEncryptedFile;
type Profile = {
  name: string;
  networkMs: number;
  cryptoMs: number;
  sinkMs: number;
};
const profiles: Profile[] = [
  { name: "network", networkMs: 60, cryptoMs: 2, sinkMs: 2 },
  { name: "crypto", networkMs: 2, cryptoMs: 60, sinkMs: 2 },
  { name: "sink", networkMs: 2, cryptoMs: 2, sinkMs: 60 },
  { name: "balanced", networkMs: 30, cryptoMs: 30, sinkMs: 30 },
];
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const digest = async (bytes: ArrayBuffer) =>
  hex(await crypto.subtle.digest("SHA-256", bytes));
const ivFor = (index: number) => {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, index);
  return iv;
};

export async function runDownloadProfiles(
  current: Download,
  serial: Download,
  repetitions = 3,
) {
  const originalFetch = globalThis.fetch;
  const browser = globalThis as typeof globalThis & {
    showSaveFilePicker?: unknown;
  };
  const originalPicker = browser.showSaveFilePicker;
  const chunkCount = 4;
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const ciphertext: ArrayBuffer[] = [];
  const expected: string[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const plain = new Uint8Array(VAULT_CRYPTO_CHUNK_BYTES).fill(index + 1);
    expected.push(await digest(plain.buffer));
    ciphertext.push(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: ivFor(index) },
        key,
        plain,
      ),
    );
    plain.fill(0);
  }
  const chunkBytes = VAULT_CRYPTO_CHUNK_BYTES + 16;
  const manifest = {
    name: "synthetic-profile.bin",
    mimeType: "application/octet-stream",
    entryType: "file",
    plaintextBytes: chunkCount * VAULT_CRYPTO_CHUNK_BYTES,
    paddedBytes: chunkCount * VAULT_CRYPTO_CHUNK_BYTES,
    lastModified: 0,
    parentId: null,
    chunkCount,
    generationId: new Uint8Array(16),
    createdAt: 0,
  } satisfies VaultManifest;
  const plan = {
    nodeId: "synthetic-profile",
    entryType: "file",
    generationNumber: 1,
    generationId: "fixture",
    ciphertextLength: chunkCount * chunkBytes,
    cryptoChunkBytes: VAULT_CRYPTO_CHUNK_BYTES,
    chunkCount,
    ciphertextMerkleRoot:
      "adapter-validates-each-aead-tag-and-complete-output-digests",
    downloadUrl: "https://synthetic.invalid/ciphertext",
  } as VaultDownloadPlan;
  const runs: Array<{
    profile: string;
    implementation: "current" | "serial";
    repetition: number;
    durationMs: number;
    maxActiveDecryptions: number;
    maxPendingPlain: number;
    maxQueuedCipher: number;
    maxModeledStageBytes: number;
    ciphertextBytes: number;
    plaintextBytes: number;
    outputSha256: string[];
    finalized: boolean;
    closed: boolean;
  }> = [];
  let cancellation: unknown;
  try {
    for (const profile of profiles) {
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        // Alternate execution order so warmup and load do not always favor one implementation.
        const implementations =
          repetition % 2
            ? ([
                ["current", current],
                ["serial", serial],
              ] as const)
            : ([
                ["serial", serial],
                ["current", current],
              ] as const);
        for (const [implementation, download] of implementations) {
          let produced = 0;
          let decrypted = 0;
          let finalized = false;
          let closed = false;
          let queuedCipher = 0;
          let activeCipher = 0;
          let pendingPlain = 0;
          let activeDecryptions = 0;
          let maxActiveDecryptions = 0;
          let maxPendingPlain = 0;
          let maxQueuedCipher = 0;
          let maxModeledStageBytes = 0;
          const written: string[] = [];
          const sample = () => {
            maxPendingPlain = Math.max(maxPendingPlain, pendingPlain);
            maxQueuedCipher = Math.max(maxQueuedCipher, queuedCipher);
            maxModeledStageBytes = Math.max(
              maxModeledStageBytes,
              (queuedCipher + activeCipher) * chunkBytes +
                pendingPlain * VAULT_CRYPTO_CHUNK_BYTES,
            );
          };
          globalThis.fetch = async () =>
            new Response(
              new ReadableStream<Uint8Array>(
                {
                  async pull(controller) {
                    if (produced === chunkCount) {
                      controller.close();
                      return;
                    }
                    await pause(profile.networkMs);
                    const body = ciphertext[produced]?.slice(0);
                    if (!body) throw new Error("Missing fixture chunk");
                    produced += 1;
                    queuedCipher += 1;
                    sample();
                    controller.enqueue(new Uint8Array(body));
                  },
                },
                { highWaterMark: 0 },
              ),
            );
          browser.showSaveFilePicker = async () => ({
            createWritable: async () => ({
              async write(plaintext: ArrayBuffer) {
                await pause(profile.sinkMs);
                written.push(await digest(plaintext));
                pendingPlain -= 1;
              },
              async close() {
                closed = true;
              },
              async abort() {
                throw new Error("Unexpected profile abort");
              },
            }),
          });
          const client = {
            async startDecryption() {
              return { sessionId: "synthetic", manifest };
            },
            async decryptChunk(
              _session: string,
              index: number,
              body: ArrayBuffer,
            ) {
              if (index !== decrypted)
                throw new Error("Out-of-order crypto session");
              queuedCipher -= 1;
              activeCipher += 1;
              activeDecryptions += 1;
              maxActiveDecryptions = Math.max(
                maxActiveDecryptions,
                activeDecryptions,
              );
              sample();
              await pause(profile.cryptoMs);
              const plaintext = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: ivFor(index) },
                key,
                body,
              );
              activeCipher -= 1;
              activeDecryptions -= 1;
              pendingPlain += 1;
              decrypted += 1;
              sample();
              return { plaintext, plaintextBytes: plaintext.byteLength };
            },
            async finalizeDecryption() {
              if (
                decrypted !== chunkCount ||
                written.join() !== expected.join()
              )
                throw new Error("Final output digest mismatch");
              finalized = true;
            },
            async abortDecryption() {},
          } as unknown as VaultCryptoClient;
          const started = performance.now();
          await download({ plan, manifest, client });
          const durationMs = performance.now() - started;
          if (
            !closed ||
            !finalized ||
            maxActiveDecryptions !== 1 ||
            maxQueuedCipher > 1 ||
            maxModeledStageBytes >
              (implementation === "serial"
                ? chunkBytes + VAULT_CRYPTO_CHUNK_BYTES
                : 2 * chunkBytes + 2 * VAULT_CRYPTO_CHUNK_BYTES) ||
            maxPendingPlain > (implementation === "serial" ? 1 : 2)
          )
            throw new Error("Pipeline acceptance failed");
          runs.push({
            profile: profile.name,
            implementation,
            repetition,
            durationMs,
            maxActiveDecryptions,
            maxPendingPlain,
            maxQueuedCipher,
            maxModeledStageBytes,
            ciphertextBytes: produced * chunkBytes,
            plaintextBytes: chunkCount * VAULT_CRYPTO_CHUNK_BYTES,
            outputSha256: written,
            finalized,
            closed,
          });
        }
      }
    }
    cancellation = await runCancellation(
      current,
      plan,
      manifest,
      ciphertext,
      key,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPicker === undefined) delete browser.showSaveFilePicker;
    else browser.showSaveFilePicker = originalPicker;
  }
  const median = (values: number[]) =>
    values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  return {
    runtime:
      typeof navigator === "undefined" ? "Node WebCrypto" : navigator.userAgent,
    fixture: {
      chunkCount,
      plaintextBytes: chunkCount * VAULT_CRYPTO_CHUNK_BYTES,
      chunkBytes,
      profiles,
      repetitions,
    },
    summaries: profiles.map(({ name }) => {
      const selected = runs.filter((run) => run.profile === name);
      const serialMs = median(
        selected
          .filter((run) => run.implementation === "serial")
          .map((run) => run.durationMs),
      );
      const currentMs = median(
        selected
          .filter((run) => run.implementation === "current")
          .map((run) => run.durationMs),
      );
      return {
        profile: name,
        serialMedianMs: serialMs,
        currentMedianMs: currentMs,
        improvementPercent: (100 * (serialMs - currentMs)) / serialMs,
      };
    }),
    runs,
    cancellation,
    limitations: [
      "Synthetic network and sink delays; no external provider or physical disk is used.",
      "The actual current and HEAD download functions are executed. The injected crypto client uses real AES-GCM authentication and validates all complete output SHA-256 digests; it does not exercise the vault bootstrap/signature or worker-message protocol.",
      "Modeled stage bytes count logical queued/active ciphertext and pending plaintext chunks. They exclude ExactStreamReader transient input/output copies, the fixed encrypted fixture, crypto/browser internals, RSS, and garbage collector residency; this is not measured heap or total allocation.",
      "Cancellation, resume, malformed-range, ETag, generation and final-integrity failures are covered by the separate encrypted-download/resumable-download functional suites.",
    ],
  };
}

async function runCancellation(
  download: Download,
  plan: VaultDownloadPlan,
  manifest: VaultManifest,
  ciphertext: ArrayBuffer[],
  key: CryptoKey,
) {
  const operation = new AbortController();
  const browser = globalThis as typeof globalThis & {
    showSaveFilePicker?: unknown;
  };
  let produced = 0;
  let decrypted = 0;
  let writes = 0;
  let closed = false;
  let sinkAborted = false;
  let sessionAborted = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (produced > 0) await pause(25);
            if (operation.signal.aborted) return;
            const body = ciphertext[produced++];
            if (!body) {
              controller.close();
              return;
            }
            controller.enqueue(new Uint8Array(body.slice(0)));
          },
        },
        { highWaterMark: 0 },
      ),
    );
  browser.showSaveFilePicker = async () => ({
    createWritable: async () => ({
      async write() {
        writes += 1;
        operation.abort(new Error("profile cancellation"));
        await pause(10);
      },
      async close() {
        closed = true;
      },
      async abort() {
        sinkAborted = true;
      },
    }),
  });
  const client = {
    async startDecryption() {
      return { sessionId: "cancel-fixture", manifest };
    },
    async decryptChunk(_session: string, index: number, body: ArrayBuffer) {
      if (index !== decrypted)
        throw new Error("Unordered cancellation session");
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: ivFor(index) },
        key,
        body,
      );
      decrypted += 1;
      return { plaintext, plaintextBytes: plaintext.byteLength };
    },
    async finalizeDecryption() {
      throw new Error("Canceled transfer reached finalization");
    },
    async abortDecryption() {
      sessionAborted = true;
    },
  } as unknown as VaultCryptoClient;
  let rejected = false;
  const started = performance.now();
  try {
    await download({ plan, manifest, client, signal: operation.signal });
  } catch (error) {
    rejected =
      error instanceof Error && error.message === "profile cancellation";
  }
  if (
    !rejected ||
    closed ||
    !sinkAborted ||
    !sessionAborted ||
    writes !== 1 ||
    decrypted > 2
  )
    throw new Error("Cancellation acceptance failed");
  return {
    rejected,
    closed,
    sinkAborted,
    sessionAborted,
    writes,
    decrypted,
    durationMs: performance.now() - started,
  };
}
