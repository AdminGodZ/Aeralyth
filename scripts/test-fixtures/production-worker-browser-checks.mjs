import {
  BlobReader,
  TextWriter,
  ZipReader,
} from "@zip.js/zip.js/lib/zip-core.js";
import { decodeBootstrap } from "../../src/features/vault/cbor.ts";
import * as assets from "../../src/generated/worker-assets.ts";

const result = {
  workers: { ...assets },
  checks: [],
  startup: [],
  errors: [],
  userAgent: navigator.userAgent,
  hardwareConcurrency: navigator.hardwareConcurrency,
};
window.workerResults = result;
function assert(value, label) {
  if (!value) throw new Error(label);
  result.checks.push(label);
}
function exchange(worker, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Worker request timed out: ${message.type}`)),
      20000,
    );
    worker.onerror = (error) => {
      clearTimeout(timeout);
      reject(new Error(error.message));
    };
    worker.onmessage = ({ data }) => {
      if (data.type === "progress" || data.progress) return;
      clearTimeout(timeout);
      if (data.ok === false || data.type === "error")
        reject(new Error(data.error ?? data.message));
      else resolve(data.result ?? data);
    };
    worker.postMessage(message);
  });
}
const b64 = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
async function run() {
  let worker = new Worker(assets.UPLOAD_CHECKSUM_WORKER_URL, {
    type: "module",
  });
  try {
    const response = await exchange(worker, {
      type: "hash",
      id: 1,
      blob: new Blob(["abc"]),
    });
    assert(
      response.checksumSha256 ===
        "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
      "Chromium checksum matches SHA-256 known vector",
    );
  } finally {
    worker.terminate();
  }
  worker = new Worker(assets.FOLDER_ZIP_WORKER_URL, { type: "module" });
  try {
    const text = "Real browser ZIP roundtrip ".repeat(16384);
    const response = await exchange(worker, {
      type: "compress",
      sources: [
        {
          path: "content.txt",
          file: new File([text], "content.txt", { type: "text/plain" }),
        },
      ],
    });
    assert(response.type === "complete", "Chromium ZIP worker completed");
    const reader = new ZipReader(new BlobReader(response.archive), {
      useWebWorkers: false,
    });
    try {
      const entries = await reader.getEntries();
      const entry = entries[0];
      assert(
        (await entry.getData(new TextWriter())) === text,
        "Chromium ZIP content roundtrip",
      );
    } finally {
      await reader.close();
    }
  } finally {
    worker.terminate();
  }
  worker = new Worker(assets.VAULT_WORKER_URL, { type: "module" });
  let id = 0;
  const request = (payload) => exchange(worker, { ...payload, id: ++id });
  try {
    assert(
      (await request({ type: "preflight" })).supported,
      "Chromium vault Argon2 preflight",
    );
    const setup = (
      await request({
        type: "setup",
        password: "test-production-workers-password",
      })
    ).result;
    const plaintext = new TextEncoder().encode(
      "Real browser signed AES-GCM vault roundtrip.",
    );
    const start = (
      await request({
        type: "startEncryption",
        input: {
          parentId: null,
          entryType: "file",
          name: "roundtrip.txt",
          mimeType: "text/plain",
          plaintextBytes: plaintext.byteLength,
          lastModified: 0,
        },
      })
    ).result;
    const chunk = (
      await request({
        type: "encryptChunk",
        sessionId: start.sessionId,
        chunkIndex: 0,
        plaintext: plaintext.buffer,
      })
    ).result;
    const complete = (
      await request({ type: "finalizeEncryption", sessionId: start.sessionId })
    ).result;
    const { record } = complete;
    const bootstrap = decodeBootstrap(record.bootstrapCbor);
    const head = new Uint8Array(
      record.bootstrapCbor.length + record.bootstrapSignature.length,
    );
    head.set(record.bootstrapCbor);
    head.set(record.bootstrapSignature, record.bootstrapCbor.length);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", head));
    const plan = {
      ...complete,
      entryType: "file",
      cryptoChunkBytes: 4 * 1024 * 1024,
      ciphertextMerkleRoot: b64(bootstrap.ciphertextMerkleRoot),
      bootstrapCbor: b64(record.bootstrapCbor),
      bootstrapSignature: b64(record.bootstrapSignature),
      encryptedManifest: b64(record.encryptedManifest),
      wrappers: record.wrappers.map(b64),
      signerKeyVersion: setup.payload.identity.keyVersion,
      signerEd25519PublicKey: setup.payload.identity.ed25519PublicKey,
      recordHash: b64(hash),
      share: null,
      downloadUrl: null,
    };
    const decrypt = (await request({ type: "startDecryption", plan })).result;
    const decrypted = (
      await request({
        type: "decryptChunk",
        sessionId: decrypt.sessionId,
        chunkIndex: 0,
        ciphertext: chunk.ciphertext,
      })
    ).result;
    assert(
      new TextDecoder().decode(decrypted.plaintext) ===
        new TextDecoder().decode(plaintext),
      "Chromium vault AES-GCM and signature roundtrip",
    );
    await request({ type: "finalizeDecryption", sessionId: decrypt.sessionId });
    await request({ type: "lock" });
  } finally {
    worker.terminate();
  }
  const baseline = await (await fetch("/baseline.json")).json();
  for (const [key, currentUrl] of Object.entries(assets)) {
    const previous = baseline.find(
      (url) =>
        url.split("/").at(-1).split(".")[0] ===
        currentUrl.split("/").at(-1).split(".")[0],
    );
    for (let trial = 0; trial < 7; trial++) {
      for (const [label, url] of [
        ["current", currentUrl],
        ["baseline", previous],
      ]) {
        if (!url) continue;
        const start = performance.now();
        worker = new Worker(url, { type: "module" });
        try {
          if (key === "VAULT_WORKER_URL")
            await exchange(worker, { type: "lock", id: 1 });
          else if (key === "UPLOAD_CHECKSUM_WORKER_URL")
            await exchange(worker, {
              type: "hash",
              id: 1,
              blob: new Blob([]),
            });
          else
            await exchange(worker, {
              type: "compress",
              sources: [],
            });
          const elapsed = performance.now() - start;
          result.startup.push({ key, label, trial, ms: elapsed });
        } finally {
          worker.terminate();
        }
      }
    }
  }
  result.done = true;
  document.body.textContent = JSON.stringify(result, null, 2);
}
run().catch((error) => {
  result.errors.push(error.stack);
  result.done = true;
  document.body.textContent = JSON.stringify(result, null, 2);
});
