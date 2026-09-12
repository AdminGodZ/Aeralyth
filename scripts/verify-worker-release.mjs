import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { restoreWorkerAssets } from "./worker-asset-store.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Restoring also verifies every archived file against its SHA-256 URL.
await restoreWorkerAssets(root);
const manifests = [
  "src/generated/worker-assets.ts",
  "src/generated/zip-assets.ts",
];
const required = [...manifests];
for (const name of await readdir(resolve(root, "deployment/worker-assets"))) {
  if (name.endsWith(".gz")) required.push(`deployment/worker-assets/${name}`);
}
for (const manifest of manifests) {
  const source = await readFile(resolve(root, manifest), "utf8");
  for (const match of source.matchAll(/"\/workers\/([^"/]+)"/gu)) {
    if (!required.includes(`deployment/worker-assets/${match[1]}.gz`)) {
      required.push(`deployment/worker-assets/${match[1]}.gz`);
    }
    // Missing archives must fail even when the public build output is present.
    await readFile(resolve(root, "deployment/worker-assets", `${match[1]}.gz`));
  }
}
if (process.argv.includes("--content-only")) {
  console.log("Worker archive hashes and current release coverage verified.");
  process.exit(0);
}
for (const path of required) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", path], {
      cwd: root,
      stdio: "pipe",
    });
  } catch {
    throw new Error(
      `Commit the generated release asset before deployment: ${path}`,
    );
  }
}
const changes = execFileSync(
  "git",
  ["status", "--porcelain", "--", ...required],
  {
    cwd: root,
    encoding: "utf8",
  },
);
if (changes.trim()) {
  throw new Error(
    `Worker release assets differ from the committed release. Run npm run worker:build and commit the generated manifests and deployment/worker-assets together.\n${changes}`,
  );
}
console.log(
  "Committed worker assets cover the current release and retained versions.",
);
