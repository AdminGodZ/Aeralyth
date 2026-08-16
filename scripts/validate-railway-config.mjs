import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(
  await readFile(new URL("../railway.json", import.meta.url), "utf8"),
);
const dockerfile = await readFile(
  new URL("../Dockerfile", import.meta.url),
  "utf8",
);

assert.equal(
  config.$schema,
  "https://railway.com/railway.schema.json",
  "railway.json must use Railway's current schema",
);
assert.equal(config.build?.builder, "DOCKERFILE");
assert.equal(config.build?.dockerfilePath, "Dockerfile");
assert.deepEqual(config.deploy?.preDeployCommand, [
  "/app/scripts/migrate-production.sh",
]);
assert.equal(config.deploy?.startCommand, "/app/scripts/start-production.sh");
assert.equal(config.deploy?.healthcheckPath, "/health");
assert.equal(config.deploy?.healthcheckTimeout, 300);
assert.equal(config.deploy?.restartPolicyType, "ON_FAILURE");
assert.equal(config.deploy?.restartPolicyMaxRetries, 5);
assert.equal(config.deploy?.overlapSeconds, 0);
assert.equal(config.deploy?.drainingSeconds, 30);

for (const [name, value] of [
  ["healthcheckTimeout", config.deploy.healthcheckTimeout],
  ["restartPolicyMaxRetries", config.deploy.restartPolicyMaxRetries],
  ["overlapSeconds", config.deploy.overlapSeconds],
  ["drainingSeconds", config.deploy.drainingSeconds],
]) {
  assert.ok(
    Number.isInteger(value) && value >= 0,
    `deploy.${name} must be a non-negative integer`,
  );
}

const cacheMounts = dockerfile.match(/--mount=type=cache,[^\s\\]+/g) ?? [];
assert.ok(cacheMounts.length > 0, "Dockerfile must retain its build caches");

const cacheIds = cacheMounts.map((mount) => {
  const id = mount
    .split(",")
    .find((option) => option.startsWith("id="))
    ?.slice(3);
  assert.ok(id, `Railway requires an explicit id for cache mount: ${mount}`);
  return id;
});

assert.equal(
  new Set(cacheIds).size,
  cacheIds.length,
  "Dockerfile cache mounts must use unique ids",
);

console.log("Railway deployment config contract is valid.");
