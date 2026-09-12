import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const assetPattern =
  /^(?:vault|folder-zip|upload-checksum|zip-codec|zip-module)\.([a-f0-9]{64})\.(?:worker\.js|wasm)$/u;

function verifyAsset(fileName, bytes) {
  const match = assetPattern.exec(fileName);
  if (!match || createHash("sha256").update(bytes).digest("hex") !== match[1]) {
    throw new Error(
      `Worker asset does not match its immutable name: ${fileName}`,
    );
  }
}

async function writeImmutable(path, bytes) {
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!(await readFile(path)).equals(bytes)) {
      throw new Error(`Refusing to replace an immutable worker asset: ${path}`);
    }
  }
}

export async function publishWorkerAsset(root, fileName, bytes) {
  verifyAsset(fileName, bytes);
  const archiveDirectory = resolve(root, "deployment/worker-assets");
  const publicDirectory = resolve(root, "public/workers");
  await mkdir(archiveDirectory, { recursive: true });
  await mkdir(publicDirectory, { recursive: true });
  // Check in this deterministic, compressed release artifact. Fresh Docker builds
  // restore it, so compatibility does not depend on a builder or CDN cache.
  const archivedPath = resolve(archiveDirectory, `${fileName}.gz`);
  try {
    const retained = await decompress(await readFile(archivedPath));
    if (!retained.equals(bytes)) {
      throw new Error(`Archived worker contents changed: ${fileName}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeImmutable(archivedPath, await compress(bytes, { level: 9 }));
  }
  await writeImmutable(resolve(publicDirectory, fileName), bytes);
}

export async function restoreWorkerAssets(root) {
  const archiveDirectory = resolve(root, "deployment/worker-assets");
  const publicDirectory = resolve(root, "public/workers");
  await mkdir(archiveDirectory, { recursive: true });
  await mkdir(publicDirectory, { recursive: true });
  for (const archived of (await readdir(archiveDirectory)).sort()) {
    if (!archived.endsWith(".gz")) continue;
    const fileName = archived.slice(0, -3);
    const bytes = await decompress(
      await readFile(resolve(archiveDirectory, archived)),
    );
    verifyAsset(fileName, bytes);
    await writeImmutable(resolve(publicDirectory, fileName), bytes);
  }
}
