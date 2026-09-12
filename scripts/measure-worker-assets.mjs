import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselineDirectory = process.argv[2];

function measure(name, bytes) {
  return {
    name,
    rawBytes: bytes.length,
    gzipBytes: zlib.gzipSync(bytes).length,
    zstdBytes:
      typeof zlib.zstdCompressSync === "function"
        ? zlib.zstdCompressSync(bytes).length
        : null,
  };
}

const current = [];
for (const manifest of ["worker-assets.ts", "zip-assets.ts"]) {
  const source = await readFile(
    resolve(root, "src/generated", manifest),
    "utf8",
  );
  for (const [, url] of source.matchAll(/"(\/workers\/[^"/]+)"/gu)) {
    current.push(measure(url, await readFile(resolve(root, `public${url}`))));
  }
}

const baseline = [];
if (baselineDirectory) {
  for (const name of (await readdir(baselineDirectory)).sort()) {
    if (!/\.(?:worker\.js|wasm)(?:\.gz)?$/u.test(name)) continue;
    const bytes = await readFile(resolve(baselineDirectory, name));
    baseline.push(
      measure(
        name.replace(/\.gz$/u, ""),
        name.endsWith(".gz") ? zlib.gunzipSync(bytes) : bytes,
      ),
    );
  }
}

console.log(
  JSON.stringify(
    {
      node: process.version,
      compression:
        "Node zlib defaults; null zstd means unavailable in this runtime",
      current,
      baseline,
    },
    null,
    2,
  ),
);
