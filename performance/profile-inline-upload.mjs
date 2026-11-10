import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isolatedOrigin } from "./arrival-load.mjs";
import {
  bytes,
  encryptedNode,
  hash,
  quote,
  sqlClient,
} from "./mixed-fixture.mjs";

// Publishes the same small encrypted files through the client-driven flow
// (init, storage PUT, publish) and through inline batches against a real API,
// PostgreSQL and S3 provider, verifies every stored object, and reports files
// per second. Network latency is modelled explicitly because a loopback stack
// has none: each API request waits AERALYTH_PERF_API_RTT_MS, and each browser
// storage request waits AERALYTH_PERF_STORAGE_RTT_MS (twice for a PUT, whose
// CORS preflight is a round trip of its own).
//
// Never point this at a deployed database: AERALYTH_PERF_ISOLATED=1 is required.
const env = process.env;
const origin = new URL(
  isolatedOrigin(
    env.AERALYTH_PERF_ORIGIN ??
      env.AERALYTH_PERF_URL ??
      "http://127.0.0.1:8080/health",
    env,
  ),
).origin;
const allowedProviders = new Set(
  (env.AERALYTH_PERF_PROVIDER_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean),
);
const integer = (name, fallback, minimum, maximum) => {
  const value = Number(env[name] ?? fallback);
  assert.ok(
    Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${name} must be an integer between ${minimum} and ${maximum}`,
  );
  return value;
};
const fileCount = integer("AERALYTH_PERF_INLINE_FILES", 240, 8, 20_000);
const fileBytes = integer(
  "AERALYTH_PERF_INLINE_FILE_BYTES",
  16_384,
  1,
  1 << 20,
);
const batchFiles = integer("AERALYTH_PERF_INLINE_BATCH_FILES", 32, 1, 64);
const batchRequests = integer("AERALYTH_PERF_INLINE_REQUESTS", 3, 1, 3);
const directFiles = integer("AERALYTH_PERF_DIRECT_CONCURRENCY", 3, 1, 3);
const apiRttMs = integer("AERALYTH_PERF_API_RTT_MS", 0, 0, 2_000);
const storageRttMs = integer("AERALYTH_PERF_STORAGE_RTT_MS", 0, 0, 2_000);
const timeoutMs = integer("AERALYTH_PERF_TIMEOUT_MS", 30_000, 1_000, 300_000);
const publicationType = "application/vnd.aeralyth.vault-publication";

const sql = sqlClient(env, timeoutMs);
const prefix = `in${randomBytes(10).toString("hex")}`;
const owner = `${prefix}owner`;
const csrf = randomBytes(32).toString("hex");
const token = randomBytes(32).toString("hex");
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32);
const rootKey = randomBytes(32);
const folder = encryptedNode({
  id: `fil_${prefix}folder`,
  parent: null,
  parentKey: rootKey,
  folder: true,
  privateKey: keys.privateKey,
  paddedBytes: 0,
});
const newFile = (parent = folder) =>
  encryptedNode({
    id: `fil_${prefix}${randomBytes(8).toString("hex")}`,
    parent: parent?.id ?? null,
    parentKey: parent?.nodeKey ?? rootKey,
    folder: false,
    privateKey: keys.privateKey,
    paddedBytes: fileBytes,
  });

async function api(path, { method = "GET", body, headers = {} } = {}) {
  if (apiRttMs) await delay(apiRttMs);
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      Cookie: `aeralyth_session=${token}`,
      "X-CSRF-Token": csrf,
      ...headers,
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(
      `${method} ${path.split("?")[0]} returned HTTP ${response.status}: ${detail}`,
    );
  }
  return response;
}

const json = async (path, body) =>
  (
    await api(
      path,
      body === undefined
        ? {}
        : {
            method: "POST",
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
          },
    )
  ).json();

function providerUrl(value) {
  const url = new URL(value);
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      allowedProviders.has(url.host),
    "provider URL must be loopback or listed in AERALYTH_PERF_PROVIDER_HOSTS",
  );
  return url;
}

async function uploadDirect(node) {
  const checksum = hash(node.ciphertext).toString("base64");
  const upload = await json("/api/vault/uploads", {
    nodeId: node.id,
    parentId: node.parent,
    entryType: "file",
    generationNumber: 1,
    generationId: node.generation.toString("base64url"),
    ciphertextLength: node.ciphertext.length,
    chunkCount: 1,
    checksumSha256: checksum,
  });
  assert.equal(upload.mode, "single");
  // The preflight and the PUT are separate browser round trips.
  if (storageRttMs) await delay(storageRttMs * 2);
  const put = await fetch(providerUrl(upload.contentUrl.url), {
    method: "PUT",
    body: node.ciphertext,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-amz-checksum-sha256": checksum,
    },
  });
  await put.body?.cancel();
  assert.ok(put.ok, `provider PUT returned HTTP ${put.status}`);
  const published = await (
    await api(`/api/vault/uploads/${upload.uploadId}/publish`, {
      method: "POST",
      body: node.publication,
      headers: { "Content-Type": publicationType },
    })
  ).json();
  assert.equal(published.nodeId, node.id);
}

const u32 = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
};
const sized = (value) => Buffer.concat([u32(value.length), value]);

function inlineBatch(nodes, mutate = (_node, record) => record) {
  return Buffer.concat([
    Buffer.from([0x41, 0x56, 0x4c, 0x54, 1, 6, 0, 0]),
    u32(nodes.length),
    ...nodes.flatMap((node) => [
      node.parent ? sized(Buffer.from(node.parent)) : u32(0xffff_ffff),
      u32(1),
      // The node publication without its eight-byte header and part count.
      mutate(node, node.publication.subarray(12)),
      sized(node.ciphertext),
    ]),
  ]);
}

async function publishInline(nodes, mutate) {
  const response = await api("/api/vault/uploads/inline", {
    method: "POST",
    body: inlineBatch(nodes, mutate),
    headers: { "Content-Type": publicationType },
  });
  const { results } = await response.json();
  assert.equal(results.length, nodes.length, "inline results lost an item");
  return results;
}

async function uploadInline(nodes) {
  let pending = nodes;
  for (let attempt = 0; pending.length > 0; attempt++) {
    assert.ok(attempt < 6, "inline uploads did not converge");
    if (attempt) await delay(100 * attempt);
    const results = await publishInline(pending);
    const retry = [];
    for (const [index, result] of results.entries()) {
      if (result.published) {
        assert.equal(result.published.nodeId, pending[index].id);
      } else if ([429, 503].includes(result.failed.status)) {
        retry.push(pending[index]);
      } else {
        throw new Error(
          `inline upload failed with ${result.failed.status}: ${result.failed.message}`,
        );
      }
    }
    pending = retry;
  }
}

async function pool(items, concurrency, run) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) await run(items[next++]);
    }),
  );
}

async function verifyStored(nodes) {
  await pool(nodes, 8, async (node) => {
    const plan = await json(`/api/vault/nodes/${node.id}/download-plan`);
    const stored = await fetch(providerUrl(plan.downloadUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    assert.ok(stored.ok, `provider GET returned HTTP ${stored.status}`);
    node.verify(Buffer.from(await stored.arrayBuffer()));
    node.verifyMetadata(plan, keys.publicKey);
  });
}

const ledger = async () =>
  JSON.parse(
    await sql(`SELECT json_build_object(
      'unfinished', (SELECT count(*) FROM vault_uploads WHERE owner_id = ${quote(owner)} AND status NOT IN ('published', 'aborted')),
      'published', (SELECT count(*) FROM vault_uploads WHERE owner_id = ${quote(owner)} AND status = 'published'),
      'files', (SELECT count(*) FROM files WHERE owner_id = ${quote(owner)} AND entry_type = 'file'),
      'pendingUploads', (SELECT pending_uploads FROM user_storage_usage WHERE owner_id = ${quote(owner)}),
      'reservedBytes', (SELECT reserved_bytes FROM user_storage_usage WHERE owner_id = ${quote(owner)}),
      'usedBytes', (SELECT used_bytes FROM user_storage_usage WHERE owner_id = ${quote(owner)})
    );`),
  );

async function measure(name, nodes, run) {
  const started = performance.now();
  await run(nodes);
  const seconds = (performance.now() - started) / 1000;
  await verifyStored(nodes);
  return {
    name,
    files: nodes.length,
    seconds: Number(seconds.toFixed(3)),
    filesPerSecond: Number((nodes.length / seconds).toFixed(1)),
  };
}

let seeded = false;
try {
  seeded = true;
  await sql(`BEGIN;
    INSERT INTO users (id, username, password_hash, role) VALUES (${quote(owner)}, ${quote(owner)}, 'fixture-only-no-login', 'user');
    INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at) VALUES (${quote(owner)}, ${quote(owner)}, ${bytes(hash(token))}, ${quote(csrf)}, now() + interval '12 hours');
    INSERT INTO user_vaults (user_id, kdf_algorithm, kdf_salt, kdf_operations, kdf_memory_bytes, kdf_output_bytes, password_wrapper_id, password_root_ciphertext, recovery_salt, recovery_wrapper_id, recovery_root_ciphertext, identity_record_id, identity_private_ciphertext)
    VALUES (${quote(owner)}, 'argon2id13', ${bytes(randomBytes(16))}, 3, 268435456, 32, ${bytes(randomBytes(16))}, ${bytes(randomBytes(48))}, ${bytes(randomBytes(16))}, ${bytes(randomBytes(16))}, ${bytes(randomBytes(48))}, ${bytes(randomBytes(16))}, ${bytes(randomBytes(96))});
    INSERT INTO vault_identity_keys (user_id, key_version, x25519_public_key, ed25519_public_key, fingerprint_sha256)
    VALUES (${quote(owner)}, 1, ${bytes(randomBytes(32))}, ${bytes(publicKey)}, ${bytes(hash(Buffer.from(owner), publicKey))});
    INSERT INTO files (id, owner_id, original_name, storage_name, entry_type, parent_id, size_bytes, e2ee_state, current_generation_number, current_generation_id)
    VALUES (${quote(folder.id)}, ${quote(owner)}, 'Encrypted fixture', ${quote(`${prefix}/seed/${folder.id}`)}, 'folder', NULL, 0, 'encrypted', 1, ${bytes(folder.generation)});
    INSERT INTO vault_node_records (node_id, owner_id, record_version, record_hash, bootstrap_cbor, bootstrap_signature, encrypted_manifest, manifest_hash, signer_key_version)
    VALUES (${quote(folder.id)}, ${quote(owner)}, 1, ${bytes(folder.recordHash)}, ${bytes(folder.bootstrap)}, ${bytes(folder.signature)}, ${bytes(folder.encryptedManifest)}, ${bytes(hash(folder.encryptedManifest))}, 1);
    INSERT INTO vault_node_heads (node_id, owner_id, record_version, record_hash) VALUES (${quote(folder.id)}, ${quote(owner)}, 1, ${bytes(folder.recordHash)});
    INSERT INTO vault_wrappers (wrapper_id, owner_id, node_id, parent_node_id, wrapper_kind, record_version, canonical_cbor, wrapper_hash)
    VALUES (${bytes(folder.wrapperId)}, ${quote(owner)}, ${quote(folder.id)}, NULL, 'account_root', 1, ${bytes(folder.wrapper)}, ${bytes(hash(folder.wrapper))});
    COMMIT;`);
  const configured = await json("/api/vault");
  assert.equal(configured.configured, true, "fixture vault is not configured");

  // Correctness before speed: retries, isolation of bad items, and bookkeeping.
  const first = [newFile(), newFile(null), newFile()];
  const initial = await publishInline(first);
  assert.ok(
    initial.every((result) => result.published),
    `inline publication failed: ${JSON.stringify(initial)}`,
  );
  const repeated = await publishInline(first);
  assert.deepEqual(
    repeated.map((result) => result.published?.recordHash),
    initial.map((result) => result.published.recordHash),
    "repeating a batch must return the published records",
  );
  const forged = newFile();
  const sound = newFile();
  const mixed = await publishInline([forged, sound], (node, record) => {
    if (node !== forged) return record;
    const tampered = Buffer.from(record);
    // Flip one signature bit: the item fails alone.
    tampered[4 + node.bootstrap.length + 4] ^= 1;
    return tampered;
  });
  assert.equal(mixed[0].failed?.status, 400, JSON.stringify(mixed[0]));
  assert.ok(mixed[1].published, JSON.stringify(mixed[1]));
  const orphan = encryptedNode({
    id: `fil_${prefix}${randomBytes(8).toString("hex")}`,
    parent: `fil_${prefix}missing`,
    parentKey: rootKey,
    folder: false,
    privateKey: keys.privateKey,
    paddedBytes: fileBytes,
  });
  const [rejected] = await publishInline([orphan]);
  assert.equal(rejected.failed?.status, 400, JSON.stringify(rejected));
  await verifyStored([...first, sound]);
  const settled = await ledger();
  assert.equal(settled.unfinished, 0, "a failed item kept its upload open");
  assert.equal(settled.published, 4, "a repeated batch published twice");
  assert.equal(settled.files, 4);
  assert.equal(settled.pendingUploads, 0);
  assert.equal(settled.reservedBytes, 0);

  // The owner's other uploads hold most pending slots: inline files wait for
  // one to turn over instead of failing or going back to the client.
  const held = [];
  for (let index = 0; index < 16; index++) {
    const node = newFile();
    held.push(
      await json("/api/vault/uploads", {
        nodeId: node.id,
        parentId: node.parent,
        entryType: "file",
        generationNumber: 1,
        generationId: node.generation.toString("base64url"),
        ciphertextLength: node.ciphertext.length,
        chunkCount: 1,
      }),
    );
  }
  const crowded = Array.from({ length: 24 }, () => newFile());
  const crowdedResults = await Promise.all(
    [crowded.slice(0, 8), crowded.slice(8, 16), crowded.slice(16)].map(
      (batch) => publishInline(batch),
    ),
  );
  assert.ok(
    crowdedResults.flat().every((result) => result.published),
    `inline files did not wait for a pending slot: ${JSON.stringify(crowdedResults.flat().find((result) => result.failed))}`,
  );
  await verifyStored(crowded);
  for (const upload of held) {
    await api(`/api/vault/uploads/${upload.uploadId}`, { method: "DELETE" });
  }
  const released = await ledger();
  assert.equal(released.unfinished, 0);
  assert.equal(released.pendingUploads, 0);
  assert.equal(released.reservedBytes, 0);

  const directNodes = Array.from({ length: fileCount }, () => newFile());
  const inlineNodes = Array.from({ length: fileCount }, () => newFile());
  const direct = await measure("client-driven", directNodes, (nodes) =>
    pool(nodes, directFiles, uploadDirect),
  );
  const batches = [];
  for (let start = 0; start < inlineNodes.length; start += batchFiles) {
    batches.push(inlineNodes.slice(start, start + batchFiles));
  }
  const inline = await measure("inline", inlineNodes, () =>
    pool(batches, batchRequests, uploadInline),
  );
  const final = await ledger();
  assert.equal(final.unfinished, 0);
  assert.equal(final.files, 4 + crowded.length + fileCount * 2);
  assert.equal(final.pendingUploads, 0);
  assert.equal(final.reservedBytes, 0);

  console.log(
    JSON.stringify(
      {
        origin,
        fileBytes,
        modelledRttMs: { api: apiRttMs, storage: storageRttMs },
        direct,
        inline,
        speedup: Number(
          (inline.filesPerSecond / direct.filesPerSecond).toFixed(2),
        ),
        ledger: final,
      },
      null,
      2,
    ),
  );
} finally {
  if (seeded) {
    await sql(`BEGIN;
      INSERT INTO storage_deletion_jobs (object_key, available_at)
      SELECT object_key, now() FROM vault_uploads WHERE owner_id = ${quote(owner)} AND object_key IS NOT NULL
      ON CONFLICT (object_key) DO UPDATE SET available_at = LEAST(storage_deletion_jobs.available_at, EXCLUDED.available_at);
      DELETE FROM users WHERE id = ${quote(owner)};
      DELETE FROM realtime_outbox WHERE user_id = ${quote(owner)};
      DELETE FROM realtime_events WHERE user_id = ${quote(owner)};
      COMMIT;`);
  }
}
