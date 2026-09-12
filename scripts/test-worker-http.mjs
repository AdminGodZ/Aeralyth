import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const origin = process.argv[2];
if (!origin)
  throw new Error(
    "Usage: node scripts/test-worker-http.mjs http://localhost:8080",
  );
const retained = (await readdir(resolve(root, "deployment/worker-assets")))
  .filter((name) => name.endsWith(".gz"))
  .sort();
for (const archived of retained) {
  const name = archived.slice(0, -3);
  const expectedHash = name.split(".")[1];
  for (const encoding of ["identity", "gzip"]) {
    const response = await fetch(new URL(`/workers/${name}`, origin), {
      headers: { "Accept-Encoding": encoding },
      cache: "no-store",
    });
    assert.equal(response.status, 200, `Missing retained worker ${name}`);
    assert.equal(
      response.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    assert.equal(
      response.headers.get("cdn-cache-control"),
      "public, max-age=31536000, immutable",
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expectedHash,
    );
    if (encoding === "gzip" && bytes.length > 1024) {
      assert.equal(response.headers.get("content-encoding"), "gzip");
    }
  }
}
const missing = await fetch(
  new URL(`/workers/vault.${"0".repeat(64)}.worker.js`, origin),
);
assert.equal(missing.status, 404);
assert.equal(missing.headers.get("cache-control"), "no-store");
assert.equal(missing.headers.get("cdn-cache-control"), null);
console.log(
  `Verified ${retained.length} current/retained assets over HTTP with exact hashes, gzip, immutable success caching, and uncached missing-asset recovery.`,
);
