// Bundles the Aeralyth MCP server and its vault worker thread into
// .mcp-build/, two self-contained ES modules that need only Node.js 22+.
import { chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, ".mcp-build");

await build({
  absWorkingDir: root,
  entryPoints: {
    "aeralyth-mcp": "src/mcp/server.ts",
    "aeralyth-vault-worker": "src/mcp/node-vault-worker.ts",
  },
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // CommonJS dependencies bundled into an ES module still call require().
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __aeralythCreateRequire } from 'node:module';",
      "const require = __aeralythCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  legalComments: "eof",
  sourcemap: "linked",
  logLevel: "warning",
});

await chmod(path.join(outdir, "aeralyth-mcp.mjs"), 0o755);
console.log(`Built ${path.relative(root, outdir)}/aeralyth-mcp.mjs`);
