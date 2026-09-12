import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify as verifySignature,
} from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isolatedOrigin } from "./arrival-load.mjs";

const hash = (...values) => {
  const digest = createHash("sha256");
  for (const value of values) digest.update(value);
  return digest.digest();
};
const bytes = (value) => `decode('${value.toString("hex")}', 'hex')`;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const nullable = (value) => (value === null ? "NULL" : quote(value));
const loopback = (host) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
const integer = (env, name, fallback, minimum, maximum) => {
  const value = Number(env[name] ?? fallback);
  assert.ok(
    Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${name} must be an integer between ${minimum} and ${maximum}`,
  );
  return value;
};

function numberBytes(value, length) {
  const result = Buffer.alloc(length);
  if (length === 8) result.writeBigUInt64BE(BigInt(value));
  else result.writeUIntBE(value, 0, length);
  return result;
}

// The vault protocol uses canonical, definite-length CBOR with numbered keys.
// Keeping this small encoder here lets the production-image gate use Node alone.
function cborHeader(major, value) {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  for (const [tag, length, limit] of [
    [24, 1, 256],
    [25, 2, 65_536],
    [26, 4, 4_294_967_296],
    [27, 8, Number.MAX_SAFE_INTEGER],
  ]) {
    if (value < limit) {
      return Buffer.concat([
        Buffer.from([(major << 5) | tag]),
        numberBytes(value, length),
      ]);
    }
  }
  throw new Error("CBOR fixture integer is out of range");
}

function cbor(value) {
  if (value === null) return Buffer.from([0xf6]);
  if (typeof value === "number") return cborHeader(0, value);
  if (typeof value === "string") {
    const data = Buffer.from(value);
    return Buffer.concat([cborHeader(3, data.length), data]);
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([cborHeader(2, value.length), value]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([cborHeader(4, value.length), ...value.map(cbor)]);
  }
  assert.ok(value instanceof Map, "unsupported fixture CBOR value");
  return Buffer.concat([
    cborHeader(5, value.size),
    ...Array.from(value).flatMap(([key, item]) => [cbor(key), cbor(item)]),
  ]);
}

const numbered = (...values) =>
  cbor(new Map(values.map((value, index) => [index + 1, value])));

function recordAad(purpose, id) {
  const purposeBytes = Buffer.from(purpose);
  const idBytes = Buffer.from(id);
  return Buffer.concat([
    numberBytes(1, 2),
    numberBytes(purposeBytes.length, 2),
    purposeBytes,
    numberBytes(idBytes.length, 2),
    idBytes,
    numberBytes(1, 8),
  ]);
}

function aesEncrypt(key, aad, plaintext) {
  const cipher = createCipheriv("aes-256-gcm", key, Buffer.alloc(12));
  cipher.setAAD(aad);
  return Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

function aesDecrypt(key, aad, ciphertext) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.alloc(12));
  decipher.setAAD(aad);
  decipher.setAuthTag(ciphertext.subarray(-16));
  return Buffer.concat([
    decipher.update(ciphertext.subarray(0, -16)),
    decipher.final(),
  ]);
}

const derive = (key, salt, info) =>
  Buffer.from(hkdfSync("sha256", key, salt, info, 32));

function encryptedNode({
  id,
  parent,
  parentKey,
  folder,
  privateKey,
  paddedBytes,
}) {
  const nodeKey = randomBytes(32);
  const generation = randomBytes(16);
  const wrapperId = randomBytes(16);
  const kind = parent ? 2 : 1;
  const purpose = `node-wrapper-${kind}-${id}`;
  const wrapperText = wrapperId.toString("base64url");
  const wrappingKey = derive(
    parentKey,
    wrapperId,
    `aeralyth/${purpose}/v1/${wrapperText}/1`,
  );
  const wrapper = numbered(
    1,
    wrapperId,
    kind,
    id,
    parent,
    null,
    null,
    null,
    1,
    aesEncrypt(wrappingKey, recordAad(purpose, wrapperText), nodeKey),
    1,
  );
  const plaintext = folder ? Buffer.alloc(0) : Buffer.alloc(paddedBytes, 0x61);
  const contentKey = derive(nodeKey, generation, `aeralyth/content/v1/${id}/1`);
  const chunkAad = Buffer.concat([
    numberBytes(1, 2),
    Buffer.from(id),
    numberBytes(1, 8),
    generation,
    numberBytes(0, 8),
    numberBytes(plaintext.length, 4),
    numberBytes(Buffer.byteLength(id), 2),
  ]);
  const ciphertext = folder
    ? Buffer.alloc(0)
    : aesEncrypt(contentKey, chunkAad, plaintext);
  const merkleRoot = folder
    ? hash(Buffer.alloc(0))
    : hash(Buffer.from([0]), numberBytes(0, 8), ciphertext);
  const now = Date.now();
  const manifest = numbered(
    `fixture-${id}`,
    folder ? null : "application/octet-stream",
    folder ? 2 : 1,
    plaintext.length,
    plaintext.length,
    now,
    parent,
    folder ? 0 : 1,
    generation,
    now,
  );
  const encryptedManifest = aesEncrypt(
    derive(nodeKey, generation, `aeralyth/manifest/v1/${id}/1`),
    recordAad("manifest", id),
    manifest,
  );
  const bootstrap = numbered(
    1,
    1,
    1,
    id,
    1,
    generation,
    Buffer.alloc(12),
    [wrapperId],
    ciphertext.length,
    1,
    1,
    null,
    hash(encryptedManifest),
    [hash(wrapper)],
    merkleRoot,
  );
  const signature = sign(null, bootstrap, privateKey);
  const sized = (value) => Buffer.concat([numberBytes(value.length, 4), value]);
  return {
    id,
    parent,
    folder,
    nodeKey,
    generation,
    wrapperId,
    wrapper,
    bootstrap,
    signature,
    encryptedManifest,
    merkleRoot,
    recordHash: hash(bootstrap, signature),
    ciphertext,
    publication: Buffer.concat([
      Buffer.from([0x41, 0x56, 0x4c, 0x54, 1, 1, 0, 0]),
      numberBytes(0, 4),
      sized(bootstrap),
      sized(signature),
      sized(encryptedManifest),
      numberBytes(1, 4),
      sized(wrapper),
    ]),
    verify(received) {
      assert.deepEqual(hash(received), hash(ciphertext));
      assert.deepEqual(aesDecrypt(contentKey, chunkAad, received), plaintext);
    },
    verifyMetadata(plan, publicKey) {
      const receivedBootstrap = Buffer.from(plan.bootstrapCbor, "base64url");
      const receivedManifest = Buffer.from(plan.encryptedManifest, "base64url");
      assert.deepEqual(
        receivedBootstrap,
        bootstrap,
        "metadata bootstrap changed",
      );
      assert.ok(
        verifySignature(
          null,
          receivedBootstrap,
          publicKey,
          Buffer.from(plan.bootstrapSignature, "base64url"),
        ),
        "metadata signature verification failed",
      );
      assert.deepEqual(
        aesDecrypt(
          derive(nodeKey, generation, `aeralyth/manifest/v1/${id}/1`),
          recordAad("manifest", id),
          receivedManifest,
        ),
        manifest,
        "decrypted metadata changed",
      );
    },
  };
}

function sqlClient(env, timeoutMs) {
  const container =
    env.AERALYTH_PERF_DATABASE_CONTAINER ??
    env.AERALYTH_PERF_POSTGRES_CONTAINER;
  const args = container
    ? ["exec", "-i", container]
    : [
        "compose",
        ...(env.AERALYTH_PERF_COMPOSE_FILE
          ? ["-f", env.AERALYTH_PERF_COMPOSE_FILE]
          : []),
        ...(env.AERALYTH_PERF_COMPOSE_PROJECT
          ? ["-p", env.AERALYTH_PERF_COMPOSE_PROJECT]
          : []),
        "exec",
        "-T",
        "postgres",
      ];
  args.push(
    "psql",
    "-XqAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "aeralyth",
    "-d",
    env.AERALYTH_PERF_DATABASE_NAME ?? "aeralyth",
  );
  return (query, { onStdout } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn("docker", args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: Math.max(timeoutMs, 30_000),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
        onStdout?.(stdout);
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-4096);
      });
      child.on("error", reject);
      child.stdin.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(stdout.trim());
        else
          reject(new Error(`isolated fixture SQL exited ${code}: ${stderr}`));
      });
      child.stdin.end(query);
    });
}

/** A randomized, disposable fixture. Never point this at a deployed database. */
export async function createMixedFixture({
  origin,
  timeoutMs = 10_000,
  env = process.env,
}) {
  const base = new URL(isolatedOrigin(origin, env));
  const allowedProviders = new Set(
    (env.AERALYTH_PERF_PROVIDER_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
  );
  const sql = sqlClient(env, timeoutMs);
  const rows = integer(env, "AERALYTH_PERF_FIXTURE_ROWS", 1000, 100, 20_000);
  const depth = integer(env, "AERALYTH_PERF_FIXTURE_DEPTH", 16, 2, 64);
  const streamCount = integer(env, "AERALYTH_PERF_SSE_STREAMS", 8, 2, 64);
  const uploadBytes = integer(
    env,
    "AERALYTH_PERF_UPLOAD_BYTES",
    65_536,
    4096,
    4_194_304,
  );
  const cleanupTimeout = integer(
    env,
    "AERALYTH_PERF_CLEANUP_TIMEOUT_MS",
    30_000,
    1000,
    300_000,
  );
  const prefix = `mx${randomBytes(10).toString("hex")}`;
  const owner = `${prefix}owner`;
  const recipient = `${prefix}recipient`;
  const csrf = randomBytes(32).toString("hex");
  const ownerToken = randomBytes(32).toString("hex");
  const recipientToken = randomBytes(32).toString("hex");
  const ownerSet = `${quote(owner)}, ${quote(recipient)}`;
  const objectPrefix = `users/${owner}/vault/`;
  const providerJobPrefix = `${prefix}/maintenance/`;
  const jobPredicate = `(starts_with(object_key, ${quote(objectPrefix)}) OR starts_with(object_key, ${quote(providerJobPrefix)}))`;
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const rootKey = randomBytes(32);
  const streams = [];
  const databaseStalls = [];
  let streamFrames = 0;
  let streamErrors = 0;
  let closed = false;
  let seeded = false;
  let browseIndex = 0;
  const browseCursors = new Map();
  let sharedCursor;
  let metadataIndex = 0;
  let published = 0;
  let transferredBytes = 0;
  let maintenanceStarted = 0;
  const nodes = [];
  let parent = null;
  let parentKey = rootKey;
  for (let index = 0; index < depth; index++) {
    const node = encryptedNode({
      id: `fil_${prefix}d${index}`,
      parent,
      parentKey,
      folder: true,
      privateKey: keys.privateKey,
      paddedBytes: 0,
    });
    nodes.push(node);
    parent = node.id;
    parentKey = node.nodeKey;
  }
  const leafFolder = parent;
  for (let index = 0; index < rows; index++) {
    // The deepest shared folder stays wider than one API page while the rest
    // of the tree also has direct children for varying navigation depth.
    const folder =
      nodes[index < Math.floor(rows * 0.7) ? depth - 1 : index % depth];
    nodes.push(
      encryptedNode({
        id: `fil_${prefix}n${index}`,
        parent: folder.id,
        parentKey: folder.nodeKey,
        folder: false,
        privateKey: keys.privateKey,
        paddedBytes: 4096,
      }),
    );
  }
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  async function injectDatabaseStall(milliseconds) {
    assert.ok(
      Number.isInteger(milliseconds) &&
        milliseconds >= 1 &&
        milliseconds <= 10_000,
      "database stall must last 1 through 10000 ms",
    );
    assert.ok(!closed, "fixture is already closed");
    const ready = Promise.withResolvers();
    const application = `${prefix}stall`;
    let pid;
    let released = false;
    const completion = sql(
      `BEGIN;
      SET LOCAL lock_timeout = '5s';
      SET LOCAL statement_timeout = '15s';
      SET LOCAL application_name = ${quote(application)};
      LOCK TABLE files IN ACCESS EXCLUSIVE MODE;
      SELECT 'fixture-stall-ready:' || pg_backend_pid();
      SELECT pg_sleep(${milliseconds / 1000});
      ROLLBACK;`,
      {
        onStdout(output) {
          const match = /fixture-stall-ready:(\d+)/.exec(output);
          if (match) {
            pid = Number(match[1]);
            ready.resolve();
          }
        },
      },
    ).then(() => {
      assert.ok(pid, "database stall ended before acquiring the lock");
    });
    const done = completion.catch((error) => {
      ready.reject(error);
      if (!released) throw error;
    });
    // A caller may observe completion later; do not turn that into an unhandled rejection.
    done.catch(() => {});
    const stall = {
      done,
      async release() {
        if (released) return;
        released = true;
        if (pid)
          await sql(
            `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid = ${pid} AND application_name = ${quote(application)};`,
          );
        await done;
      },
    };
    databaseStalls.push(stall);
    await ready.promise;
    return stall;
  }

  async function request(
    path,
    { token = ownerToken, signal, body, method = "GET", headers = {} } = {},
  ) {
    const response = await fetch(new URL(path, base.origin), {
      method,
      headers: {
        Cookie: `aeralyth_session=${token}`,
        "X-CSRF-Token": csrf,
        ...headers,
      },
      body,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      // Response bodies and signed URLs can contain data unsuitable for telemetry.
      throw new Error(
        `${method} ${path.split("?")[0]} returned HTTP ${response.status}`,
      );
    }
    return response;
  }

  async function json(path, body, signal, token = ownerToken) {
    const response = await request(path, {
      token,
      signal,
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
          }),
    });
    return response.json();
  }

  function providerUrl(value) {
    const url = new URL(value);
    assert.ok(
      ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        (loopback(url.hostname) || allowedProviders.has(url.host)),
      "provider URL must be loopback or listed in AERALYTH_PERF_PROVIDER_HOSTS",
    );
    return url;
  }

  async function openStream(index) {
    const controller = new AbortController();
    const stream = { controller, task: null, lastFrameAt: performance.now() };
    const firstFrame = Promise.withResolvers();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const token = index % 2 === 0 ? ownerToken : recipientToken;
    const task = (async () => {
      try {
        const response = await fetch(new URL("/api/events", base.origin), {
          headers: { Cookie: `aeralyth_session=${token}` },
          signal: controller.signal,
          redirect: "error",
        });
        assert.equal(
          response.status,
          200,
          "SSE must authenticate successfully",
        );
        assert.match(
          response.headers.get("content-type") ?? "",
          /text\/event-stream/,
        );
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let end = buffer.indexOf("\n\n");
          while (end >= 0) {
            const frame = buffer.slice(0, end);
            assert.ok(
              !frame.includes("event: session-expired"),
              "fixture session expired",
            );
            streamFrames++;
            stream.lastFrameAt = performance.now();
            firstFrame.resolve();
            clearTimeout(timeout);
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf("\n\n");
          }
          assert.ok(buffer.length < 1024 * 1024, "unbounded SSE frame");
        }
        if (!closed) throw new Error("SSE ended before workload completion");
      } catch (error) {
        firstFrame.reject(error);
        if (!closed) streamErrors++;
      } finally {
        clearTimeout(timeout);
      }
    })();
    stream.task = task;
    streams.push(stream);
    await firstFrame.promise;
  }

  async function sample() {
    const output = await sql(`SELECT json_build_object(
      'expiredSessionsRemaining', (SELECT count(*) FROM sessions WHERE user_id = ${quote(owner)} AND expires_at <= now()),
      'providerJobsRemaining', (SELECT count(*) FROM storage_deletion_jobs WHERE ${jobPredicate}),
      'providerJobsFailed', (SELECT count(*) FROM storage_deletion_jobs WHERE ${jobPredicate} AND dead_lettered_at IS NOT NULL),
      'oldestProviderJobMs', (SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)) * 1000, 0) FROM storage_deletion_jobs WHERE ${jobPredicate}),
      'expiredUploadsRemaining', (SELECT count(*) FROM vault_uploads WHERE owner_id = ${quote(owner)} AND status NOT IN ('published', 'aborted') AND expires_at <= now())
    );`);
    return {
      ...JSON.parse(output),
      streamFrames,
      streamErrors,
      oldestSseFrameAgeMs: Math.max(
        0,
        ...streams.map((stream) => performance.now() - stream.lastFrameAt),
      ),
      published,
      transferredBytes,
      maintenanceStarted,
      clientRssBytes: process.memoryUsage().rss,
    };
  }

  async function verify() {
    const deadline = performance.now() + cleanupTimeout;
    while (true) {
      const state = await sample();
      assert.equal(state.streamErrors, 0, "a held SSE stream failed");
      assert.ok(
        state.oldestSseFrameAgeMs < 15_000,
        "a held SSE stream stopped delivering checkpoints",
      );
      assert.equal(
        state.providerJobsFailed,
        0,
        "fixture cleanup reached the dead-letter queue",
      );
      assert.ok(state.published > 0, "no encrypted publication completed");
      assert.ok(
        state.maintenanceStarted > 0,
        "no maintenance work was started",
      );
      if (
        state.expiredSessionsRemaining === 0 &&
        state.providerJobsRemaining === 0 &&
        state.expiredUploadsRemaining === 0
      ) {
        return state;
      }
      assert.ok(
        performance.now() < deadline,
        "fixture maintenance did not converge before the verification deadline",
      );
      await delay(250);
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const stream of streams) stream.controller.abort();
    await Promise.all(streams.map((stream) => stream.task));
    await Promise.all(databaseStalls.map((stall) => stall.release()));
    if (!seeded) return;
    // No fixture writer remains. Only keys actually staged or published by this
    // owner enter cleanup; seeded metadata has no provider object to remove.
    await sql(`BEGIN;
      INSERT INTO storage_deletion_jobs (object_key, available_at)
      SELECT object_key, now() FROM vault_uploads WHERE owner_id = ${quote(owner)} AND object_key IS NOT NULL
      ON CONFLICT (object_key) DO UPDATE SET available_at = LEAST(storage_deletion_jobs.available_at, EXCLUDED.available_at);
      DELETE FROM users WHERE id IN (${ownerSet});
      DELETE FROM realtime_outbox WHERE user_id IN (${ownerSet});
      DELETE FROM realtime_events WHERE user_id IN (${ownerSet});
      COMMIT;`);
    const deadline = performance.now() + cleanupTimeout;
    while (true) {
      const pending = Number(
        await sql(
          `SELECT count(*) FROM storage_deletion_jobs WHERE ${jobPredicate};`,
        ),
      );
      if (pending === 0) break;
      assert.ok(
        performance.now() < deadline,
        `${pending} fixture provider cleanup jobs did not converge within ${cleanupTimeout} ms`,
      );
      await delay(250);
    }
  }

  try {
    const accountSql = [owner, recipient]
      .map(
        (id, index) => `
      INSERT INTO users (id, username, password_hash, role) VALUES (${quote(id)}, ${quote(id)}, 'fixture-only-no-login', 'user');
      INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at) VALUES (${quote(id)}, ${quote(id)}, ${bytes(hash(index === 0 ? ownerToken : recipientToken))}, ${quote(csrf)}, now() + interval '12 hours');
      INSERT INTO user_vaults (user_id, kdf_algorithm, kdf_salt, kdf_operations, kdf_memory_bytes, kdf_output_bytes, password_wrapper_id, password_root_ciphertext, recovery_salt, recovery_wrapper_id, recovery_root_ciphertext, identity_record_id, identity_private_ciphertext)
      VALUES (${quote(id)}, 'argon2id13', ${bytes(randomBytes(16))}, 3, 268435456, 32, ${bytes(randomBytes(16))}, ${bytes(randomBytes(48))}, ${bytes(randomBytes(16))}, ${bytes(randomBytes(16))}, ${bytes(randomBytes(48))}, ${bytes(randomBytes(16))}, ${bytes(randomBytes(96))});
      INSERT INTO vault_identity_keys (user_id, key_version, x25519_public_key, ed25519_public_key, fingerprint_sha256)
      VALUES (${quote(id)}, 1, ${bytes(randomBytes(32))}, ${bytes(publicKey)}, ${bytes(hash(Buffer.from(id), publicKey))});
    `,
      )
      .join("\n");
    const nodeSql = nodes
      .map(
        (node) => `
      INSERT INTO files (id, owner_id, original_name, storage_name, entry_type, parent_id, size_bytes, e2ee_state, current_generation_number, current_generation_id)
      VALUES (${quote(node.id)}, ${quote(owner)}, 'Encrypted fixture', ${quote(`${prefix}/seed/${node.id}`)}, ${quote(node.folder ? "folder" : "file")}, ${nullable(node.parent)}, ${node.ciphertext.length}, 'encrypted', 1, ${bytes(node.generation)});
      INSERT INTO vault_node_records (node_id, owner_id, record_version, record_hash, bootstrap_cbor, bootstrap_signature, encrypted_manifest, manifest_hash, signer_key_version)
      VALUES (${quote(node.id)}, ${quote(owner)}, 1, ${bytes(node.recordHash)}, ${bytes(node.bootstrap)}, ${bytes(node.signature)}, ${bytes(node.encryptedManifest)}, ${bytes(hash(node.encryptedManifest))}, 1);
      INSERT INTO vault_node_heads (node_id, owner_id, record_version, record_hash) VALUES (${quote(node.id)}, ${quote(owner)}, 1, ${bytes(node.recordHash)});
      INSERT INTO vault_wrappers (wrapper_id, owner_id, node_id, parent_node_id, wrapper_kind, record_version, canonical_cbor, wrapper_hash)
      VALUES (${bytes(node.wrapperId)}, ${quote(owner)}, ${quote(node.id)}, ${nullable(node.parent)}, ${quote(node.parent ? "parent_node" : "account_root")}, 1, ${bytes(node.wrapper)}, ${bytes(hash(node.wrapper))});
      ${node.folder ? "" : `INSERT INTO vault_object_generations (node_id, owner_id, generation_number, generation_id, object_key, ciphertext_length, chunk_count, ciphertext_merkle_root) VALUES (${quote(node.id)}, ${quote(owner)}, 1, ${bytes(node.generation)}, ${quote(`${prefix}/seed/${node.id}`)}, ${node.ciphertext.length}, 1, ${bytes(node.merkleRoot)});`}
    `,
      )
      .join("\n");
    // Cleanup also runs if psql loses its connection just after COMMIT.
    seeded = true;
    await sql(`BEGIN;
      ${accountSql}
      ${nodeSql}
      INSERT INTO vault_shares (id, owner_id, root_node_id) VALUES (${quote(`${prefix}share`)}, ${quote(owner)}, ${quote(nodes[0].id)});
      INSERT INTO vault_share_epochs (share_id, epoch, status, published_at) VALUES (${quote(`${prefix}share`)}, 1, 'published', now());
      INSERT INTO vault_share_recipients (share_id, recipient_id, recipient_key_version) VALUES (${quote(`${prefix}share`)}, ${quote(recipient)}, 1);
      INSERT INTO sessions (id, user_id, token_hash, expires_at) SELECT ${quote(prefix)} || 'expired' || n, ${quote(owner)}, sha256(convert_to(${quote(prefix)} || n, 'UTF8')), now() - interval '1 minute' FROM generate_series(1, 250) n;
      INSERT INTO storage_deletion_jobs (object_key, available_at) SELECT ${quote(providerJobPrefix)} || n, now() FROM generate_series(1, 32) n;
      COMMIT;`);
    await json("/api/auth/me");
    const configured = await json("/api/vault");
    assert.equal(
      configured.configured,
      true,
      "fixture vault is not configured",
    );
    assert.ok(
      ["migrate", "required"].includes(configured.mode),
      "mixed publication needs enabled vaults and S3",
    );
    for (let index = 0; index < streamCount; index++) await openStream(index);

    return {
      fixture: {
        rows,
        depth,
        streams: streamCount,
        sharedUsers: 1,
        uploadBytes,
        encryptedMetadata: true,
        expiredSessions: 250,
        providerCleanupJobs: 32,
      },
      sample,
      verify,
      injectDatabaseStall,
      close,
      operations: [
        {
          name: "browse",
          weight: 4,
          async run(signal) {
            const folder = nodes[browseIndex++ % depth].id;
            const cursor = browseCursors.get(folder);
            const result = await json(
              `/api/files?folder=${folder}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
              undefined,
              signal,
            );
            assert.ok(
              Array.isArray(result.entries) && result.entries.length > 0,
              "seeded owner folder returned no entries",
            );
            browseCursors.set(folder, result.nextCursor);
          },
        },
        {
          name: "browse-shared",
          weight: 2,
          async run(signal) {
            const result = await json(
              `/api/files?view=shared&folder=${leafFolder}&limit=100${sharedCursor ? `&cursor=${encodeURIComponent(sharedCursor)}` : ""}`,
              undefined,
              signal,
              recipientToken,
            );
            assert.ok(
              Array.isArray(result.entries) && result.entries.length > 0,
              "shared fixture folder returned no entries",
            );
            sharedCursor = result.nextCursor;
          },
        },
        {
          name: "metadata",
          weight: 3,
          async run(signal) {
            const offset = metadataIndex++ % rows;
            const nodeIds = Array.from(
              { length: 25 },
              (_, index) => nodes[depth + ((offset + index) % rows)].id,
            );
            const planned = new Set();
            let continuation;
            let snapshot;
            for (let page = 0; page <= nodeIds.length + depth; page++) {
              const result = await json(
                "/api/vault/nodes/metadata-plans",
                { nodeIds, continuation, snapshot },
                signal,
              );
              assert.ok(
                Array.isArray(result.plans),
                "metadata response has no plans",
              );
              for (const plan of result.plans) {
                const node = nodesById.get(plan.nodeId);
                assert.ok(
                  node,
                  "metadata response returned an unknown fixture node",
                );
                node.verifyMetadata(plan, keys.publicKey);
                planned.add(plan.nodeId);
              }
              if (
                result.continuation === undefined ||
                result.continuation === null
              )
                break;
              assert.ok(
                Number.isInteger(result.continuation) &&
                  result.continuation > (continuation ?? 0),
                "metadata continuation did not advance",
              );
              continuation = result.continuation;
              snapshot = result.snapshot;
            }
            assert.ok(
              nodeIds.every((id) => planned.has(id)),
              "metadata plan omitted requested fixture nodes",
            );
          },
        },
        {
          name: "publication",
          weight: 1,
          async run(signal) {
            const node = encryptedNode({
              id: `fil_${prefix}${randomBytes(8).toString("hex")}`,
              parent: null,
              parentKey: rootKey,
              folder: false,
              privateKey: keys.privateKey,
              paddedBytes: uploadBytes,
            });
            const upload = await json(
              "/api/vault/uploads",
              {
                nodeId: node.id,
                parentId: null,
                entryType: "file",
                generationNumber: 1,
                generationId: node.generation.toString("base64url"),
                ciphertextLength: node.ciphertext.length,
                chunkCount: 1,
              },
              signal,
            );
            assert.equal(
              upload.mode,
              "single",
              "fixture expects a single-part encrypted upload",
            );
            const checksum = hash(node.ciphertext).toString("base64");
            const target = await json(
              `/api/vault/uploads/${upload.uploadId}/content-url`,
              { checksumSha256: checksum },
              signal,
            );
            const put = await fetch(providerUrl(target.url), {
              method: "PUT",
              body: node.ciphertext,
              signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
                : AbortSignal.timeout(timeoutMs),
              redirect: "error",
              headers: {
                "Content-Type": "application/octet-stream",
                "x-amz-checksum-sha256": checksum,
              },
            });
            await put.body?.cancel();
            assert.ok(
              put.ok,
              `provider ciphertext PUT returned HTTP ${put.status}`,
            );
            const publication = await request(
              `/api/vault/uploads/${upload.uploadId}/publish`,
              {
                method: "POST",
                body: node.publication,
                signal,
                headers: {
                  "Content-Type": "application/vnd.aeralyth.vault-publication",
                },
              },
            );
            const result = await publication.json();
            assert.equal(result.nodeId, node.id);
            const download = await json(
              `/api/vault/nodes/${node.id}/download-plan`,
              undefined,
              signal,
            );
            const content = await fetch(
              providerUrl(download.url ?? download.downloadUrl),
              {
                signal: signal
                  ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
                  : AbortSignal.timeout(timeoutMs),
                redirect: "error",
              },
            );
            assert.ok(
              content.ok,
              `provider ciphertext GET returned HTTP ${content.status}`,
            );
            const received = Buffer.from(await content.arrayBuffer());
            node.verify(received);
            published++;
            transferredBytes += node.ciphertext.length + received.length;
          },
        },
        {
          name: "realtime-sync",
          weight: 1,
          async run(signal) {
            const result = await json("/api/events/sync", undefined, signal);
            assert.equal(typeof result.cursor, "string");
            assert.equal(streamErrors, 0, "a held SSE stream failed");
          },
        },
        {
          name: "maintenance",
          weight: 1,
          async run(signal) {
            const upload = await json(
              "/api/vault/uploads",
              {
                nodeId: `fil_${prefix}${randomBytes(8).toString("hex")}`,
                parentId: null,
                entryType: "file",
                generationNumber: 1,
                generationId: randomBytes(16).toString("base64url"),
                ciphertextLength: 4112,
                chunkCount: 1,
              },
              signal,
            );
            const result = await request(
              `/api/vault/uploads/${upload.uploadId}`,
              { method: "DELETE", signal },
            );
            await result.body?.cancel();
            maintenanceStarted++;
          },
        },
      ],
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "mixed fixture setup and cleanup failed",
      );
    }
    throw error;
  }
}
