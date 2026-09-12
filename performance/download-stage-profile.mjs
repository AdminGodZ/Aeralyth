import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const runBrowser = promisify(execFile);
const root = process.cwd();
const output = path.join(root, "performance/results/download-stage-2026-09-12");
const scratch = await mkdtemp(
  path.join(os.tmpdir(), "aeralyth-download-profile-"),
);
const baselineRef =
  process.env.AERALYTH_DOWNLOAD_BASELINE_REF ??
  "fe9556cf9f011297e16500f18cdf04b991b35635";
const baselineRevision = execFileSync(
  "git",
  ["rev-parse", `${baselineRef}^{commit}`],
  { encoding: "utf8" },
).trim();
const baseline = execFileSync(
  "git",
  ["show", `${baselineRevision}:src/features/vault/encrypted-download.ts`],
  { encoding: "utf8" },
);
const sourceFiles = [
  "src/features/vault/encrypted-download.ts",
  "src/features/vault/resumable-download.ts",
  "src/features/vault/buffered-bytes.ts",
  "performance/download-stage-profile.ts",
  "performance/download-stage-profile.mjs",
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (file) => [
      file,
      createHash("sha256")
        .update(await readFile(path.join(root, file)))
        .digest("hex"),
    ]),
  ),
);
await mkdir(output, { recursive: true });
await writeFile(path.join(scratch, "serial.ts"), baseline);
const entry = `import { downloadEncryptedFile as current } from ${JSON.stringify(path.join(root, "src/features/vault/encrypted-download.ts"))};\nimport { downloadEncryptedFile as serial } from "./serial.ts";\nimport { runDownloadProfiles } from ${JSON.stringify(path.join(root, "performance/download-stage-profile.ts"))};\nexport const run = () => runDownloadProfiles(current, serial);\n`;
await writeFile(path.join(scratch, "entry.ts"), entry);
await build({
  entryPoints: [path.join(scratch, "entry.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: path.join(scratch, "profile.mjs"),
  alias: { "@": path.join(root, "src") },
});
const metadata = {
  startedAt: new Date().toISOString(),
  baselineRef,
  baselineRevision,
  baselineSourceSha256: createHash("sha256").update(baseline).digest("hex"),
  sourceHashes,
  host: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpu: os.cpus()[0]?.model,
  },
  command: [process.execPath, ...process.argv.slice(1)],
  browserAvailability: {},
};
for (const [browser, executable] of Object.entries({
  firefox: path.join(
    os.homedir(),
    "Library/Caches/ms-playwright/firefox-1543/firefox/Nightly.app/Contents/MacOS/firefox",
  ),
  webkit: path.join(
    os.homedir(),
    "Library/Caches/ms-playwright/webkit-2359/pw_run.sh",
  ),
  safari: "/Applications/Safari.app",
})) {
  metadata.browserAvailability[browser] = await access(executable).then(
    () => "installed",
    () => "not installed",
  );
}
const module = await import(
  pathToFileURL(path.join(scratch, "profile.mjs")).href
);
if (!process.argv.includes("--browser-only")) {
  const nodeResult = await module.run();
  await writeFile(
    path.join(output, "node.json"),
    `${JSON.stringify({ ...nodeResult, provenance: metadata }, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({ runtime: "node", summaries: nodeResult.summaries }),
  );
}
const bundle = await readFile(path.join(scratch, "profile.mjs"));
let browserResolve;
const browserResult = new Promise((resolve) => {
  browserResolve = resolve;
});
const server = createServer(async (request, response) => {
  if (request.url === "/profile.mjs") {
    response.setHeader("Content-Type", "application/javascript");
    response.end(bundle);
    return;
  }
  if (request.url === "/result" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const result = JSON.parse(body);
    response.end("ok");
    browserResolve(result);
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(
    '<!doctype html><title>Aeralyth isolated download scheduling profile</title><h1>Download scheduling profile</h1><pre id="result">Running isolated fixtures...</pre><script type="module">import { run } from "/profile.mjs"; try { const result=await run(); document.querySelector("#result").textContent=JSON.stringify(result.summaries,null,2); await fetch("/result",{method:"POST",body:JSON.stringify(result)});window.profileDone=true; } catch(error) { await fetch("/result",{method:"POST",body:JSON.stringify({error:String(error),stack:error.stack})});document.querySelector("#result").textContent=String(error);window.profileDone=true; }</script>',
  );
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
const session = `aeralyth-download-profile-${process.pid}`;
try {
  await runBrowser(
    "agent-browser",
    ["--session", session, "open", `http://127.0.0.1:${port}`],
    { timeout: 30_000 },
  );
  let timer;
  const result = await Promise.race([
    browserResult,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Browser profile timed out")),
        90_000,
      );
    }),
  ]);
  clearTimeout(timer);
  if (result.error) throw new Error(result.stack || result.error);
  await writeFile(
    path.join(output, "chromium.json"),
    `${JSON.stringify({ ...result, provenance: metadata }, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({ runtime: "chromium", summaries: result.summaries }),
  );
  metadata.browserAvailability.chromium = result.runtime;
  metadata.browserAvailability.safariAutomation = await trySafariProfile(
    `http://127.0.0.1:${port}`,
  );
} finally {
  await runBrowser("agent-browser", ["--session", session, "close"], {
    timeout: 30_000,
  });
  await new Promise((resolve) => server.close(resolve));
  metadata.completedAt = new Date().toISOString();
  await writeFile(
    path.join(output, "provenance.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  await rm(scratch, { recursive: true, force: true });
}

async function trySafariProfile(url) {
  if (process.platform !== "darwin") return { status: "not applicable" };
  const portSocket = createServer();
  await new Promise((resolve, reject) => {
    portSocket.once("error", reject);
    portSocket.listen(0, "127.0.0.1", resolve);
  });
  const driverPort = portSocket.address().port;
  await new Promise((resolve) => portSocket.close(resolve));
  const driver = spawn(
    "/usr/bin/safaridriver",
    ["--port", String(driverPort)],
    { stdio: "ignore" },
  );
  const endpoint = `http://127.0.0.1:${driverPort}`;
  let sessionId;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await fetch(`${endpoint}/status`, { signal: AbortSignal.timeout(500) });
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!ready)
      return {
        status: "unavailable",
        reason: "Safari WebDriver did not become ready.",
      };
    const created = await fetch(`${endpoint}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capabilities: { alwaysMatch: { browserName: "safari" } },
      }),
      signal: AbortSignal.timeout(10_000),
    }).then((response) => response.json());
    sessionId = created.value?.sessionId;
    if (!sessionId)
      return {
        status: "unavailable",
        reason: created.value?.message ?? JSON.stringify(created),
      };
    const safariResult = new Promise((resolve) => {
      browserResolve = resolve;
    });
    const navigation = await fetch(`${endpoint}/session/${sessionId}/url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!navigation.ok)
      throw new Error(`Safari navigation failed: ${await navigation.text()}`);
    let timeout;
    const result = await Promise.race([
      safariResult,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Safari profile timed out")),
          45_000,
        );
      }),
    ]);
    clearTimeout(timeout);
    if (result.error) throw new Error(result.stack || result.error);
    await writeFile(
      path.join(output, "safari.json"),
      `${JSON.stringify({ ...result, provenance: metadata }, null, 2)}\n`,
    );
    console.log(
      JSON.stringify({ runtime: "safari", summaries: result.summaries }),
    );
    return { status: "passed", runtime: result.runtime };
  } catch (error) {
    if (sessionId) {
      metadata.browserAvailability.safariAutomation = {
        status: "failed",
        reason: String(error),
      };
      throw error;
    }
    return { status: "unavailable", reason: String(error) };
  } finally {
    if (sessionId)
      await fetch(`${endpoint}/session/${sessionId}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(2_000),
      }).catch(() => undefined);
    driver.kill("SIGTERM");
  }
}
