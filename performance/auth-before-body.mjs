import net from "node:net";
import { performance } from "node:perf_hooks";

const healthUrlValue =
  process.env.AERALYTH_PERF_URL ?? "http://127.0.0.1:8080/health";
if (!URL.canParse(healthUrlValue)) {
  throw new Error("AERALYTH_PERF_URL must be a valid absolute URL");
}
const healthUrl = new URL(healthUrlValue);
const host = healthUrl.hostname;
const port = Number(
  healthUrl.port || (healthUrl.protocol === "https:" ? 443 : 80),
);
const concurrency = Number(process.env.AERALYTH_AUTH_BODY_CONCURRENCY ?? 32);
const timeoutMs = Number(process.env.AERALYTH_AUTH_BODY_TIMEOUT_MS ?? 1_000);
const maxHealthP95Ms = Number(process.env.AERALYTH_PERF_MAX_P95_MS ?? 500);
const declaredBytes = 8 * 1024 * 1024;
const requestHeaders =
  "POST /api/files/uploads HTTP/1.1\r\n" +
  `Host: ${host}\r\n` +
  "Content-Type: application/json\r\n" +
  `Content-Length: ${declaredBytes}\r\n` +
  "Connection: close\r\n\r\n";

if (healthUrl.protocol !== "http:") {
  throw new Error(
    "auth-before-body regression check requires a local HTTP API URL",
  );
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

function unauthenticatedLargeBodyProbe() {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `server waited for an unauthenticated ${declaredBytes}-byte body`,
        ),
      );
    }, timeoutMs);
    let response = "";

    socket.once("connect", () => {
      socket.write(requestHeaders);
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      const lineEnd = response.indexOf("\r\n");
      if (lineEnd === -1) {
        return;
      }
      clearTimeout(timer);
      socket.destroy();
      const statusLine = response.slice(0, lineEnd);
      if (!statusLine.includes(" 401 ")) {
        reject(new Error(`unexpected response: ${statusLine}`));
        return;
      }
      resolve(performance.now() - started);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function healthProbe() {
  const started = performance.now();
  const response = await fetch(healthUrl);
  if (!response.ok) {
    throw new Error(`health request failed with ${response.status}`);
  }
  await response.arrayBuffer();
  return performance.now() - started;
}

const unauthenticated = Array.from(
  { length: concurrency },
  unauthenticatedLargeBodyProbe,
);
const health = Array.from({ length: concurrency }, healthProbe);
const [rejectionLatency, healthLatency] = await Promise.all([
  Promise.all(unauthenticated),
  Promise.all(health),
]);
const rejectionP95 = percentile(rejectionLatency, 0.95);
const healthP95 = percentile(healthLatency, 0.95);

if (healthP95 > maxHealthP95Ms) {
  throw new Error(
    `health p95 ${healthP95.toFixed(2)}ms exceeded ${maxHealthP95Ms}ms during unauthenticated body flood`,
  );
}

console.log(
  JSON.stringify({
    concurrency,
    declaredBytes,
    bytesActuallySentPerRequest: Buffer.byteLength(requestHeaders),
    rejectionP95Ms: Number(rejectionP95.toFixed(2)),
    healthP95Ms: Number(healthP95.toFixed(2)),
  }),
);
