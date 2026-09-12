// Run only against an explicitly supplied disposable local release API/database.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  verify,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const env = process.env;
assert.equal(
  env.AERALYTH_METADATA_ACCEPTANCE_READY,
  "1",
  "Wait for the final release API handoff.",
);
const base = new URL(env.AERALYTH_METADATA_URL ?? "http://127.0.0.1:58083");
assert.ok(["127.0.0.1", "localhost"].includes(base.hostname));
const database =
  env.AERALYTH_METADATA_DATABASE ?? "aeralyth_audit_release_final";
assert.ok(database.startsWith("aeralyth_audit_"));
const container = env.AERALYTH_METADATA_CONTAINER ?? "aeralyth-audit-20260912";
assert.ok(container.startsWith("aeralyth-audit-"));
const pid = Number(env.AERALYTH_METADATA_PID);
assert.ok(
  Number.isInteger(pid) && pid > 1,
  "Supply the final API process ID for RSS sampling.",
);
const artifact = env.AERALYTH_METADATA_BUILD_ID;
assert.ok(artifact, "Supply the release binary SHA256/build identity.");
const output = new URL("./result.json", import.meta.url);
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const bytes = (value) => `decode('${value.toString("hex")}','hex')`;
const hash = (value) => createHash("sha256").update(value).digest();
const sql = (query) =>
  new Promise((resolveQuery, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        container,
        "psql",
        "-XqAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "aeralyth",
        "-d",
        database,
      ],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.stdin.on("error", (error) => {
      // psql can reject a statement while the remaining fixture is still being
      // written. Its exit output contains the useful SQL error in that case.
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (code) =>
      code === 0
        ? resolveQuery(stdout.trim())
        : reject(new Error(stderr.slice(-3000))),
    );
    child.stdin.end(query);
  });

// Reuse the actual signed mixed-fixture protocol builder without modifying it.
// Padding changes an authenticated CBOR manifest name, not its encryption/signature.
const fixtureSource = await readFile(
  resolve("performance/mixed-fixture.mjs"),
  "utf8",
);
let helperSource = fixtureSource.slice(
  0,
  fixtureSource.indexOf("function sqlClient("),
);
helperSource = helperSource.replace(
  '"./arrival-load.mjs"',
  JSON.stringify(pathToFileURL(resolve("performance/arrival-load.mjs")).href),
);
helperSource = helperSource.replace(
  "  paddedBytes,\n})",
  "  paddedBytes,\n  manifestPadding = 0,\n})",
);
helperSource = helperSource.replace(
  /(`fixture-\$\{id\}`),/,
  '$1 + "x".repeat(manifestPadding),',
);
helperSource += "\nexport { encryptedNode };\n";
const { encryptedNode } = await import(
  `data:text/javascript;base64,${Buffer.from(helperSource).toString("base64")}`
);

const prefix = `md${randomBytes(8).toString("hex")}`;
const owner = `${prefix}owner`;
const token = randomBytes(32).toString("hex");
const csrf = randomBytes(32).toString("hex");
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32);
const rootKey = randomBytes(32);
const nodes = [];
const largest = [];
const leaves = [];
for (let index = 0; index < 9; index++) {
  const args = {
    id: `fil_${prefix}max${index}`,
    parent: null,
    parentKey: rootKey,
    folder: true,
    privateKey: keys.privateKey,
    paddedBytes: 0,
  };
  let padding = 1_048_000;
  let node = encryptedNode({ ...args, manifestPadding: padding });
  padding += 1_048_576 - node.encryptedManifest.length;
  node = encryptedNode({ ...args, manifestPadding: padding });
  assert.equal(node.encryptedManifest.length, 1_048_576);
  assert.ok(verify(null, node.bootstrap, keys.publicKey, node.signature));
  nodes.push(node);
  largest.push(node.id);
}
for (let chain = 0; chain < 6; chain++) {
  let parent = null;
  let parentKey = rootKey;
  for (let depth = 0; depth < 100; depth++) {
    const node = encryptedNode({
      id: `fil_${prefix}c${chain}d${depth}`,
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
  leaves.push(parent);
}
if (env.AERALYTH_METADATA_PREPARE_ONLY === "1") {
  await writeFile(
    new URL("./fixture-proof.json", import.meta.url),
    `${JSON.stringify({ preparedAt: new Date().toISOString(), fixtureSourceSha256: hash(fixtureSource).toString("hex"), maximumManifestLengths: nodes.slice(0, 9).map((node) => node.encryptedManifest.length), signedMaximumRecordsVerified: true, requestedDeepLeaves: leaves.length, expandedDeepNodes: 600, totalNodes: nodes.length, databaseTouched: false, apiMeasured: false }, null, 2)}\n`,
  );
  process.exit(0);
}

function rss() {
  const value =
    Number(
      execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 2000,
      }).trim(),
    ) * 1024;
  assert.ok(
    Number.isFinite(value) && value > 0,
    "API RSS sample is unavailable",
  );
  return value;
}
const queryKinds = {
  payload:
    "query LIKE '%FROM requested%' AND query LIKE '%records.bootstrap_cbor%'",
  identity:
    "query LIKE '%AS requested(id, ordinal)%' AND query LIKE '%heads.record_hash%'",
  sizes:
    "query LIKE '%AS requested(id)%' AND query LIKE '%octet_length(records.bootstrap_cbor)%'",
  wrappers: "query LIKE '%AS wrapper_cbors%'",
};
const metricColumns = {
  calls: "calls",
  returnedRows: "rows",
  executionMs: "total_exec_time",
  sharedBlockHits: "shared_blks_hit",
  sharedBlockReads: "shared_blks_read",
  temporaryBlockReads: "temp_blks_read",
  temporaryBlockWrites: "temp_blks_written",
};
async function queryStats() {
  const cases = Object.entries(queryKinds)
    .map(([kind, condition]) => `WHEN ${condition} THEN '${kind}'`)
    .join(" ");
  const fields = Object.entries(metricColumns)
    .map(([metric, column]) => `'${metric}',${column}`)
    .join(",");
  const rows = JSON.parse(
    await sql(
      `SELECT COALESCE(json_agg(json_build_object('kind',CASE ${cases} END,'queryId',queryid::text,${fields})),'[]'::json) FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND (${Object.values(
        queryKinds,
      )
        .map((condition) => `(${condition})`)
        .join(" OR ")}) AND query NOT LIKE '%pg_stat_statements%';`,
    ),
  );
  const statistics = Object.fromEntries(
    Object.keys(queryKinds).map((kind) => [
      kind,
      {
        queryIds: [],
        ...Object.fromEntries(
          Object.keys(metricColumns).map((metric) => [metric, 0]),
        ),
      },
    ]),
  );
  for (const row of rows) {
    statistics[row.kind].queryIds.push(row.queryId);
    for (const metric of Object.keys(metricColumns))
      statistics[row.kind][metric] += row[metric];
  }
  return statistics;
}
const result = {
  recordedAt: new Date().toISOString(),
  artifact,
  database,
  api: base.origin,
  fixtureOwner: owner,
  fixtureSourceSha256: hash(fixtureSource).toString("hex"),
  fixture: {
    maximumManifestCiphertextBytes: 1_048_576,
    maximumRecords: largest.length,
    disjointChains: 6,
    nodesPerChain: 100,
    totalRecords: nodes.length,
    signedBootstrapVerified: true,
  },
  observations: [],
  limitations: [
    "RSS is sampled every 10 ms using ps and can miss shorter peaks.",
    "Synchronous ps sampling adds client-side observation overhead to reported request latency.",
    "Process RSS includes any other work on the same API. Run during an exclusive metadata measurement window.",
    "pg_stat_statements deltas include other matching requests on this database. Returned rows are not internal scanned-row counts; buffer counters are recorded separately.",
    "responseBytes is the body delivered by fetch, excluding HTTP headers and transport/compression overhead. Decoded record bytes are not PostgreSQL protocol wire bytes.",
    "Maximum ciphertext records use authenticated large CBOR names to exercise the server byte cap; this is a protocol storage boundary fixture, not a normal filename UI case.",
    "HTTP latency includes authentication, SQL, decoding and encoding. Encode-only CPU and allocator volume are not measured.",
    "The snapshot-conflict check changes the stored head hash directly; it verifies continuation fencing, not the publication endpoint.",
  ],
};
let seeded = false;
try {
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  seeded = true;
  await sql(`BEGIN;
    INSERT INTO users(id,username,password_hash,role) VALUES(${quote(owner)},${quote(owner)},'fixture-only-no-login','user');
    INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES(${quote(owner)},${quote(owner)},${bytes(hash(token))},${quote(csrf)},now()+interval '1 hour');
    INSERT INTO user_vaults(user_id,kdf_algorithm,kdf_salt,kdf_operations,kdf_memory_bytes,kdf_output_bytes,password_wrapper_id,password_root_ciphertext,recovery_salt,recovery_wrapper_id,recovery_root_ciphertext,identity_record_id,identity_private_ciphertext)
    VALUES(${quote(owner)},'argon2id13',${bytes(randomBytes(16))},3,268435456,32,${bytes(randomBytes(16))},${bytes(randomBytes(48))},${bytes(randomBytes(16))},${bytes(randomBytes(16))},${bytes(randomBytes(48))},${bytes(randomBytes(16))},${bytes(randomBytes(96))});
    INSERT INTO vault_identity_keys(user_id,key_version,x25519_public_key,ed25519_public_key,fingerprint_sha256) VALUES(${quote(owner)},1,${bytes(randomBytes(32))},${bytes(publicKey)},${bytes(hash(publicKey))});
    ${nodes
      .map(
        (node) => `
      INSERT INTO files(id,owner_id,original_name,storage_name,entry_type,parent_id,size_bytes,e2ee_state,current_generation_number,current_generation_id) VALUES(${quote(node.id)},${quote(owner)},${quote(node.id)},${quote(node.id)},'folder',${node.parent ? quote(node.parent) : "NULL"},0,'encrypted',1,${bytes(node.generation)});
      INSERT INTO vault_node_records(node_id,owner_id,record_version,record_hash,bootstrap_cbor,bootstrap_signature,encrypted_manifest,manifest_hash,signer_key_version) VALUES(${quote(node.id)},${quote(owner)},1,${bytes(node.recordHash)},${bytes(node.bootstrap)},${bytes(node.signature)},${bytes(node.encryptedManifest)},${bytes(hash(node.encryptedManifest))},1);
      INSERT INTO vault_node_heads(node_id,owner_id,record_version,record_hash) VALUES(${quote(node.id)},${quote(owner)},1,${bytes(node.recordHash)});
      INSERT INTO vault_wrappers(wrapper_id,owner_id,node_id,parent_node_id,wrapper_kind,record_version,canonical_cbor,wrapper_hash) VALUES(${bytes(node.wrapperId)},${quote(owner)},${quote(node.id)},${node.parent ? quote(node.parent) : "NULL"},${quote(node.parent ? "parent_node" : "account_root")},1,${bytes(node.wrapper)},${bytes(hash(node.wrapper))});`,
      )
      .join("\n")}
    COMMIT;`);
  async function measure(name, body) {
    const statsBefore = await queryStats();
    const beforeRss = rss();
    let peakRss = beforeRss;
    let samplingFailure;
    const timer = setInterval(() => {
      try {
        peakRss = Math.max(peakRss, rss());
      } catch (error) {
        samplingFailure = error;
        clearInterval(timer);
      }
    }, 10);
    const start = performance.now();
    let response;
    let buffer;
    try {
      response = await fetch(new URL("/api/vault/nodes/metadata-plans", base), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `aeralyth_session=${token}`,
          "X-CSRF-Token": csrf,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      buffer = Buffer.from(await response.arrayBuffer());
    } finally {
      clearInterval(timer);
    }
    if (samplingFailure) throw samplingFailure;
    const latencyMs = performance.now() - start;
    const afterRss = rss();
    peakRss = Math.max(peakRss, afterRss);
    const statsAfter = await queryStats();
    const sqlWork = Object.fromEntries(
      Object.keys(queryKinds).map((kind) => [
        kind,
        {
          queryIds: statsAfter[kind].queryIds,
          ...Object.fromEntries(
            Object.keys(metricColumns).map((metric) => [
              metric,
              statsAfter[kind][metric] - statsBefore[kind][metric],
            ]),
          ),
        },
      ]),
    );
    const value = response.ok ? JSON.parse(buffer) : null;
    result.observations.push({
      name,
      status: response.status,
      latencyMs,
      responseBytes: buffer.length,
      beforeRss,
      peakRss,
      afterRss,
      peakGrowthBytes: peakRss - beforeRss,
      selectedPlans: value?.plans?.length ?? 0,
      manifestPayloadBytes:
        value?.plans?.reduce(
          (sum, plan) =>
            sum + Buffer.from(plan.encryptedManifest, "base64url").length,
          0,
        ) ?? 0,
      decodedRecordBytes:
        value?.plans?.reduce(
          (sum, plan) =>
            sum +
            [
              plan.bootstrapCbor,
              plan.bootstrapSignature,
              plan.encryptedManifest,
              ...plan.wrappers,
            ].reduce(
              (bytes, item) => bytes + Buffer.from(item, "base64url").length,
              0,
            ),
          0,
        ) ?? 0,
      payloadQueryCalls: sqlWork.payload.calls,
      payloadRows: sqlWork.payload.returnedRows,
      payloadSqlMs: sqlWork.payload.executionMs,
      sqlWork,
      continuation: value?.continuation ?? null,
      error: response.ok ? undefined : buffer.toString("utf8"),
    });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    return { response, value };
  }
  const overflow = await measure("deep-disjoint-overflow", { nodeIds: leaves });
  assert.equal(overflow.response.status, 413);
  assert.equal(result.observations.at(-1).payloadRows, 0);
  assert.equal(result.observations.at(-1).payloadQueryCalls, 0);
  assert.equal(result.observations.at(-1).sqlWork.identity.returnedRows, 513);
  assert.equal(result.observations.at(-1).sqlWork.sizes.calls, 0);
  assert.equal(result.observations.at(-1).sqlWork.wrappers.calls, 0);
  let continuation;
  let snapshot;
  let firstContinuation;
  const returned = [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  for (let page = 0; page < 10; page++) {
    const { response, value } = await measure(
      `maximum-record-page-${page + 1}`,
      { nodeIds: largest, continuation, snapshot },
    );
    assert.equal(response.status, 200);
    assert.ok(result.observations.at(-1).responseBytes <= 8 * 1024 * 1024);
    assert.equal(result.observations.at(-1).payloadQueryCalls, 1);
    assert.equal(result.observations.at(-1).payloadRows, value.plans.length);
    assert.equal(result.observations.at(-1).sqlWork.wrappers.calls, 1);
    assert.equal(
      result.observations.at(-1).sqlWork.wrappers.returnedRows,
      value.plans.length,
    );
    for (const plan of value.plans) {
      assert.equal(
        Buffer.from(plan.encryptedManifest, "base64url").length,
        1_048_576,
      );
      nodesById.get(plan.nodeId)?.verifyMetadata(plan, keys.publicKey);
    }
    returned.push(...value.plans.map((plan) => plan.nodeId));
    snapshot = value.snapshot;
    continuation = value.continuation;
    if (page === 0) firstContinuation = continuation;
    if (continuation == null) break;
  }
  assert.deepEqual(returned, largest);
  assert.equal(
    result.observations.reduce(
      (sum, observation) => sum + observation.payloadRows,
      0,
    ),
    largest.length,
  );
  assert.ok(
    result.observations.filter((observation) =>
      observation.name.startsWith("maximum-record-page"),
    ).length > 1,
  );
  await sql(
    `UPDATE vault_node_heads SET record_hash=sha256(record_hash) WHERE node_id=${quote(largest[0])};`,
  );
  const conflict = await measure("changed-record-snapshot-conflict", {
    nodeIds: largest,
    continuation: firstContinuation,
    snapshot,
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(result.observations.at(-1).payloadQueryCalls, 0);
  assert.equal(result.observations.at(-1).payloadRows, 0);
  assert.equal(result.observations.at(-1).sqlWork.wrappers.calls, 0);
  assert.equal(result.observations.at(-1).sqlWork.wrappers.returnedRows, 0);
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.failure = String(error);
  process.exitCode = 1;
} finally {
  if (seeded) {
    try {
      await sql(
        `BEGIN; DELETE FROM files WHERE owner_id=${quote(owner)}; DELETE FROM users WHERE id=${quote(owner)}; COMMIT;`,
      );
      const remaining = JSON.parse(
        await sql(
          `SELECT json_build_object('users',(SELECT count(*) FROM users WHERE id=${quote(owner)}),'files',(SELECT count(*) FROM files WHERE owner_id=${quote(owner)}),'sessions',(SELECT count(*) FROM sessions WHERE user_id=${quote(owner)}),'vaults',(SELECT count(*) FROM user_vaults WHERE user_id=${quote(owner)}));`,
        ),
      );
      assert.ok(Object.values(remaining).every((count) => count === 0));
      result.cleanupRemainingRows = remaining;
      result.fixtureRemoved = true;
    } catch (error) {
      result.passed = false;
      result.cleanupFailure = String(error);
      process.exitCode = 1;
    }
  }
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}
