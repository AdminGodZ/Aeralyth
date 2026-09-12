import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselineDirectory = process.argv[2] ? resolve(process.argv[2]) : null;
const baselines = new Map();
if (baselineDirectory) {
  for (const file of (await readdir(baselineDirectory)).sort()) {
    if (
      !/^(?:vault|folder-zip|upload-checksum)\.[a-f0-9]{64}\.worker\.js(?:\.gz)?$/u.test(
        file,
      )
    )
      continue;
    const name = file.replace(/\.gz$/u, "");
    const prefix = name.split(".")[0];
    if (
      [...baselines.keys()].some((existing) =>
        existing.startsWith(`${prefix}.`),
      )
    ) {
      throw new Error(
        `Baseline directory must have exactly one version of ${prefix}.`,
      );
    }
    const bytes = await readFile(resolve(baselineDirectory, file));
    baselines.set(name, file.endsWith(".gz") ? gunzipSync(bytes) : bytes);
  }
}

// Only the test page is bundled. /workers requests serve the production bytes.
const built = await build({
  entryPoints: [
    resolve(root, "scripts/test-fixtures/production-worker-browser-checks.mjs"),
  ],
  bundle: true,
  platform: "browser",
  format: "esm",
  tsconfig: resolve(root, "tsconfig.json"),
  write: false,
});
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  try {
    response.setHeader("Cache-Control", "no-store");
    if (pathname === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'",
      });
      response.end(
        '<!doctype html><meta charset="utf-8"><title>Production worker verification</title><body>Running worker checks<script type="module" src="/entry.js"></script>',
      );
    } else if (pathname === "/entry.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(built.outputFiles[0].contents);
    } else if (pathname === "/baseline.json") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          [...baselines.keys()].map((name) => `/baseline/${name}`),
        ),
      );
    } else if (
      pathname.startsWith("/baseline/") &&
      baselines.has(pathname.slice(10))
    ) {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(baselines.get(pathname.slice(10)));
    } else if (/^\/workers\/[a-z0-9.-]+$/u.test(pathname)) {
      const bytes = await readFile(resolve(root, `public${pathname}`));
      response.writeHead(200, {
        "Content-Type": pathname.endsWith(".wasm")
          ? "application/wasm"
          : "text/javascript",
      });
      response.end(bytes);
    } else {
      response.writeHead(404).end();
    }
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 500).end(String(error));
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(
    `Open http://127.0.0.1:${address.port} in an isolated browser session. Results appear on the page and in window.workerResults. Stop this fixture with Ctrl-C.`,
  );
});
