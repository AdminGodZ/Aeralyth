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

    const startup = read("scripts/start-production.sh");
    expect(startup).toContain("/app/bin/aeralyth-api");
    expect(startup).toContain("node /app/frontend/server.js");
    expect(startup).toContain("caddy run");
    expect(startup).toContain("wait -n");
  });

  it("routes API traffic directly to Actix and everything else to Next", () => {
    const caddyfile = read("deployment/Caddyfile");
    const apiMatcher = caddyfile.indexOf("@api path /api/* /health /metrics");
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

  it("blocks activation unless migrations and health checks succeed", () => {
    const config = JSON.parse(read("railway.json")) as {
      build: { builder: string; dockerfilePath: string };
      deploy: {
        preDeployCommand: string[];
        healthcheckPath: string;
        restartPolicyType: string;
        overlapSeconds: string;
      };
    };
    expect(config.build).toEqual({
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
    });
    expect(config.deploy.preDeployCommand).toEqual([
      "/app/scripts/migrate-production.sh",
    ]);
    expect(config.deploy.healthcheckPath).toBe("/health");
    expect(config.deploy.restartPolicyType).toBe("ON_FAILURE");
    expect(config.deploy.overlapSeconds).toBe("0");
  });

  it("gates every master deployment on the complete GitHub workflow", () => {
    const workflow = read(".github/workflows/performance.yml");
    expect(workflow).toContain("push:\n    branches:\n      - master");
    expect(workflow).not.toMatch(/^\s+paths(?:-ignore)?:/m);
    expect(workflow).toContain("Frontend quality and production build");
    expect(workflow).toContain("Backend, migrations, and latency regressions");
    expect(workflow).toContain("Railway production image smoke test");
    expect(workflow).toContain("npm run db:test:production-preflight-fresh");
    expect(workflow).toContain("-e AERALYTH_ENV=production");
    expect(workflow).toContain("-e AERALYTH_ENV=Production");
    expect(workflow).toContain("quay.io/minio/minio@sha256:");
    expect(workflow).toContain("-e AERALYTH_STORAGE_BACKEND=s3");
    expect(workflow).toContain("-e AERALYTH_E2EE_MODE=migrate");
    expect(workflow).toContain("-e AERALYTH_COOKIE_SECURE=true");
    expect(workflow).toContain('--publish "18081:' + "$" + '{public_port}"');
    expect(workflow).toContain("smoke_port 8080 8081");
    expect(workflow).toContain("smoke_port 8081 18080");
  });

  it("refuses a fresh production database with the local seed password", () => {
    const migrations = read("scripts/migrate-production.sh");
    const preflight = read("database/production/preflight.sql");
    expect(migrations).toContain("[0-9][0-9][0-9]_*.sql");
    expect(migrations).toContain("database/production/preflight.sql");
    expect(migrations).toContain("[Pp][Rr][Oo][Dd][Uu][Cc][Tt][Ii][Oo][Nn]");
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
    const cors = JSON.parse(read("docs/railway-s3-cors.production.json")) as {
      CORSRules: Array<{ AllowedOrigins: string[] }>;
    };
    expect(cors.CORSRules).toHaveLength(1);
    expect(cors.CORSRules[0]?.AllowedOrigins).toEqual([
      "https://cloud.admingod.ch",
    ]);

    const runbook = read("docs/production-railway.md");
    const domainStep = runbook.indexOf("7. Attach `cloud.admingod.ch`");
    const corsStep = runbook.indexOf(
      "8. Apply the production bucket CORS policy",
    );
    expect(domainStep).toBeGreaterThan(-1);
    expect(corsStep).toBeGreaterThan(domainStep);
  });
});
