import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Railway production deployment", () => {
  it("builds a non-root standalone image with all three runtime processes", () => {
    const dockerfile = read("Dockerfile");
    expect(read("next.config.ts")).toContain('output: "standalone"');
    expect(dockerfile).toContain("/workspace/.next/standalone");
    expect(dockerfile).toContain("/workspace/.next/static");
    expect(dockerfile).toContain("/workspace/public");
    expect(dockerfile).toContain("postgresql-client");
    expect(dockerfile).toContain("USER aeralyth");

    const cacheMounts = dockerfile.match(/--mount=type=cache,[^\s\\]+/g) ?? [];
    expect(cacheMounts).toHaveLength(4);
    const railwayCachePrefix = "s/be1490eb-fe3f-4375-9927-54973fbfdd67-";
    const cacheIds = cacheMounts.map((mount) => {
      const options = Object.fromEntries(
        mount.split(",").map((option) => option.split("=", 2)),
      );
      expect(options.id).toBe(`${railwayCachePrefix}${options.target}`);
      return options.id;
    });
    expect(new Set(cacheIds).size).toBe(cacheIds.length);

    const startup = read("scripts/start-production.sh");
    expect(startup).toContain("/app/bin/aeralyth-api");
    expect(startup).toContain("node /app/frontend/server.js");
    expect(startup).toContain("caddy run");
    expect(startup).toContain("wait -n");

    const apiStart = startup.indexOf("/app/bin/aeralyth-api &");
    const frontendStart = startup.indexOf("node /app/frontend/server.js &");
    const apiReady = startup.indexOf('wait_for_service "API"');
    const frontendReady = startup.indexOf('wait_for_service "frontend"');
    const proxyStart = startup.indexOf("/usr/bin/caddy run");
    expect(frontendStart).toBeGreaterThan(apiStart);
    expect(apiReady).toBeGreaterThan(frontendStart);
    expect(frontendReady).toBeGreaterThan(apiReady);
    expect(proxyStart).toBeGreaterThan(frontendReady);
  });

  it("routes API traffic directly to Actix and everything else to Next", () => {
    const caddyfile = read("deployment/Caddyfile");
    const apiMatcher = caddyfile.indexOf(
      "@api path /api/* /health /health/* /metrics",
    );
    const apiTarget = caddyfile.indexOf(
      "reverse_proxy 127.0.0.1:{$AERALYTH_API_PORT:8081}",
    );
    const frontendTarget = caddyfile.indexOf(
      "reverse_proxy 127.0.0.1:{$AERALYTH_FRONTEND_PORT:3000}",
    );
    expect(apiMatcher).toBeGreaterThan(-1);
    expect(apiTarget).toBeGreaterThan(apiMatcher);
    expect(frontendTarget).toBeGreaterThan(apiTarget);
    const startup = read("scripts/start-production.sh");
    expect(startup).toContain('public_port="' + "$" + '{PORT:-8080}"');
    expect(startup).toContain(
      '"' + "$" + '{candidate}" != "' + "$" + '{public_port}"',
    );
    expect(startup).toContain(
      'export AERALYTH_API_PORT="' + "$" + '{api_port}"',
    );
    expect(startup).toContain('PORT="' + "$" + '{frontend_port}"');
    expect(read("Dockerfile")).toContain(
      "AERALYTH_API_ORIGIN=http://127.0.0.1:8081",
    );
    expect(caddyfile).toContain(":{$PORT:8080}");
    expect(caddyfile).not.toContain("reverse_proxy 127.0.0.1:8080");
  });

  it("bounds public HTTP lifetimes without imposing a short large-body deadline", () => {
    const caddyfile = read("deployment/Caddyfile");
    expect(caddyfile).toContain("read_header 10s");
    expect(caddyfile).toContain("read_body 10m");
    expect(caddyfile).toContain("write 30m");
    expect(caddyfile).toContain("idle 2m");
    expect(caddyfile).toContain("max_header_size 64KB");
    expect(caddyfile).toContain("grace_period 30s");
  });

  it("compresses text responses but excludes encrypted and object bodies", () => {
    const caddyfile = read("deployment/Caddyfile");
    const encode = caddyfile
      .split("encode zstd gzip {")[1]
      ?.split("handle /workers/*")[0];
    expect(encode).toBeTruthy();
    expect(encode).toContain("minimum_length 1024");
    expect(encode).toContain("application/json*");
    expect(encode).toContain("text/html*");
    expect(encode).toContain("text/css*");
    expect(encode).toContain("text/plain*");
    expect(encode).not.toContain("text/*");
    expect(encode).not.toContain("text/event-stream");
    expect(encode).not.toContain("application/octet-stream");
    expect(encode).not.toContain("application/vnd.aeralyth");
  });

  it("serves content-named browser workers with immutable caching", () => {
    const caddyfile = read("deployment/Caddyfile");
    expect(caddyfile).toContain("handle /workers/*");
    expect(caddyfile).toContain("@existingWorker file");
    expect(caddyfile).toContain("root * /app/frontend/public");
    expect(caddyfile).toContain("file_server");
    expect(caddyfile).toContain(
      'Cache-Control "public, max-age=31536000, immutable"',
    );
    expect(caddyfile).toContain(
      'CDN-Cache-Control "public, max-age=31536000, immutable"',
    );
    expect(caddyfile).toContain('header Cache-Control "no-store"');
    expect(caddyfile).toContain(
      'respond "Worker asset unavailable. Reload the application and retry." 404',
    );
  });

  it("blocks activation unless migrations and health checks succeed", () => {
    const config = JSON.parse(read("railway.json")) as {
      build: { builder: string; dockerfilePath: string };
      deploy: {
        preDeployCommand: string[];
        healthcheckPath: string;
        restartPolicyType: string;
        overlapSeconds: number;
        drainingSeconds: number;
      };
    };
    expect(config.build).toEqual({
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
    });
    expect(config.deploy.preDeployCommand).toEqual([
      "/app/scripts/migrate-production.sh",
    ]);
    expect(config.deploy.healthcheckPath).toBe("/health/ready");
    expect(config.deploy.restartPolicyType).toBe("ON_FAILURE");
    expect(config.deploy.overlapSeconds).toBe(0);
    expect(config.deploy.drainingSeconds).toBe(30);
  });

  it("gates every master deployment on the complete GitHub workflow", () => {
    const workflow = read(".github/workflows/performance.yml");
    expect(workflow).toContain("push:\n    branches:\n      - master");
    expect(workflow).not.toMatch(/^\s+paths(?:-ignore)?:/m);
    expect(workflow).toContain("Frontend quality and production build");
    expect(workflow).toContain("Backend, migrations, and latency regressions");
    expect(workflow).toContain("Railway production image smoke test");
    expect(workflow).toContain("Railway deployment config");
    expect(workflow).toContain("npm run validate:railway");
    expect(workflow).toContain(
      "git diff --exit-code -- src/generated/worker-assets.ts",
    );
    expect(workflow).toContain("python3 database/tests/run_audit_suite.py");
    expect(read("database/tests/run_audit_suite.py")).toContain(
      '"production-preflight-fresh"',
    );
    expect(workflow).toContain("-e AERALYTH_ENV=production");
    expect(workflow).toContain("-e AERALYTH_ENV=Production");
    expect(workflow).toContain(
      "docker build --tag aeralyth-ci-minio --file .github/fixtures/minio.Dockerfile .github/fixtures",
    );
    expect(workflow).toContain("            aeralyth-ci-minio \\");
    expect(workflow).toContain("-e AERALYTH_STORAGE_BACKEND=s3");
    expect(workflow).toContain("-e AERALYTH_E2EE_MODE=migrate");
    expect(workflow).toContain("-e AERALYTH_COOKIE_SECURE=true");
    expect(workflow).toContain('--publish "18081:' + "$" + '{public_port}"');
    expect(workflow).toContain("smoke_port 8080 8081");
    expect(workflow).toContain("smoke_port 8081 18080");
    expect(workflow).toMatch(/verify_worker "\$\{vault_worker_path\}"/u);
    expect(workflow).toMatch(/verify_worker "\$\{zip_worker_path\}"/u);
    expect(workflow).toMatch(/verify_worker "\$\{checksum_worker_path\}"/u);
    expect(workflow).toContain(
      "cache-control: public, max-age=31536000, immutable",
    );
    expect(workflow).toContain(
      "cdn-cache-control: public, max-age=31536000, immutable",
    );
  });

  it("refuses a fresh production database with the local seed password", () => {
    const migrations = read("scripts/migrate-production.sh");
    const preflight = read("database/production/preflight.sql");
    expect(migrations).toContain("[0-9][0-9][0-9]_*.sql");
    expect(migrations).toContain("database/production/preflight.sql");
    expect(migrations).toContain("[Pp][Rr][Oo][Dd][Uu][Cc][Tt][Ii][Oo][Nn]");
    expect(migrations).toContain("client_min_messages=warning");
    expect(preflight).toContain(
      "production requires a restored active administrator account",
    );
    expect(preflight).toContain("role = 'admin'");
    expect(preflight).toContain("production refuses to start");
    expect(read("database/tests/fresh_production_preflight.sh")).toContain(
      "no active administrator",
    );
  });

  it("allows direct S3 requests only from the production frontend", () => {
    const cors = JSON.parse(
      read("deployment/railway-s3-cors.production.json"),
    ) as {
      CORSRules: Array<{ AllowedOrigins: string[] }>;
    };
    expect(cors.CORSRules).toHaveLength(1);
    expect(cors.CORSRules[0]?.AllowedOrigins).toEqual([
      "https://cloud.admingod.ch",
    ]);
  });
});
