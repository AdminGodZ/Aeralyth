/**
 * Aeralyth MCP server: lets MCP clients (Claude Code, Claude Desktop, …) work
 * with an Aeralyth vault. It is a full vault client running on this machine:
 * it signs in, unlocks the vault in a worker thread and encrypts and decrypts
 * locally, so the server still only ever sees ciphertext.
 *
 * Configuration (environment):
 *   AERALYTH_URL               https://your-aeralyth.example
 *   AERALYTH_USERNAME          account name
 *   AERALYTH_PASSWORD_COMMAND  command that prints the password (preferred), or
 *   AERALYTH_PASSWORD          the password itself
 */
import { execFile } from "node:child_process";

import { createApiFetch } from "@/mcp/api-fetch";
import { startNodeVaultWorker } from "@/mcp/node-worker-port";
import { AeralythSession, messageOf } from "@/mcp/session";
import { StdioMcpServer } from "@/mcp/stdio-server";
import { createTools } from "@/mcp/tools";

const VERSION = "0.1.0";
const PASSWORD_COMMAND_TIMEOUT_MS = 60_000;

function log(message: string): void {
  process.stderr.write(`[aeralyth-mcp] ${message}\n`);
}

// stdout carries the protocol; anything the vault modules print goes to stderr.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in the MCP server's environment.`);
  return value;
}

function passwordSource(): () => Promise<string> {
  const command = process.env.AERALYTH_PASSWORD_COMMAND?.trim();
  if (command) {
    return () =>
      new Promise((resolve, reject) => {
        execFile(
          "/bin/sh",
          ["-c", command],
          { timeout: PASSWORD_COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 },
          (error, stdout) => {
            if (error) {
              reject(
                new Error(
                  `AERALYTH_PASSWORD_COMMAND failed (${error.code ?? error.message}).`,
                ),
              );
              return;
            }
            const password = stdout.replace(/\r?\n$/, "");
            if (!password) {
              reject(new Error("AERALYTH_PASSWORD_COMMAND printed nothing."));
              return;
            }
            resolve(password);
          },
        );
      });
  }
  const password = process.env.AERALYTH_PASSWORD;
  if (password) return async () => password;
  throw new Error(
    "Set AERALYTH_PASSWORD_COMMAND (preferred) or AERALYTH_PASSWORD in the MCP server's environment.",
  );
}

async function main(): Promise<void> {
  const origin = requiredEnv("AERALYTH_URL");
  const username = requiredEnv("AERALYTH_USERNAME");
  const password = passwordSource();
  const workerUrl = new URL("./aeralyth-vault-worker.mjs", import.meta.url);

  let session: AeralythSession | null = null;
  const api = createApiFetch({
    origin,
    userAgent: `aeralyth-mcp/${VERSION}`,
    onApiResponse: (status, path) => session?.noteApiResponse(status, path),
  });
  globalThis.fetch = api.fetch;

  session = new AeralythSession({
    username,
    password,
    startWorker: () => startNodeVaultWorker(workerUrl),
    log,
  });
  const activeSession = session;

  const server = new StdioMcpServer({
    name: "aeralyth",
    title: "Aeralyth",
    version: VERSION,
    instructions:
      "Aeralyth is the user's end-to-end encrypted cloud drive. Paths are absolute vault paths such as /Documents/report.pdf; / is the top level. List or search before acting on items you have not seen. Ids (fil_…) from listings identify items exactly when names repeat. move_to_trash is reversible with restore_from_trash; nothing here deletes permanently.",
    tools: createTools(activeSession),
    write: (line) => process.stdout.write(line),
    log,
  });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => server.receive(chunk));
  const shutdown = () => {
    server.abortAll("The MCP client disconnected.");
    void activeSession.close().finally(() => process.exit(0));
  };
  process.stdin.on("end", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Sign in and unlock ahead of the first tool call; Argon2id takes a moment.
  activeSession.connect().catch((failure: unknown) => {
    log(`Sign-in will be retried on the next tool call: ${messageOf(failure)}`);
  });
}

main().catch((failure: unknown) => {
  log(messageOf(failure));
  process.exit(1);
});
