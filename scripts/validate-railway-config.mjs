import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(
  await readFile(new URL("../railway.json", import.meta.url), "utf8"),
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

console.log("Railway deployment config contract is valid.");
