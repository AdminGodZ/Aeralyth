/**
 * End-to-end test of the built MCP server against a running Aeralyth API with
 * real S3 storage. It runs only when AERALYTH_MCP_E2E_URL is set (CI sets it
 * in the backend job); everything else skips it.
 *
 *   AERALYTH_MCP_E2E_URL             e.g. http://127.0.0.1:18080
 *   AERALYTH_MCP_E2E_ADMIN_USERNAME  an admin account (default aeralyth)
 *   AERALYTH_MCP_E2E_ADMIN_PASSWORD  its password (default aeralyth)
 *
 * The admin creates a fresh one-password user; that user's vault is set up
 * here, and the MCP server then signs in as that user like a real install.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ONE_PASSWORD_AUTH_VERSION } from "@/features/auth/account-password";
import { getAccountAuthInfo, loginAccount } from "@/features/auth/auth-api";
import { toBase64Url } from "@/features/vault/protocol";
import { setupVault } from "@/features/vault/vault-api";
import { VaultCryptoClient } from "@/features/vault/vault-client";
import { createApiFetch } from "@/mcp/api-fetch";
import { startNodeVaultWorker } from "@/mcp/node-worker-port";

const ORIGIN = process.env.AERALYTH_MCP_E2E_URL;
const ADMIN_USERNAME =
  process.env.AERALYTH_MCP_E2E_ADMIN_USERNAME ?? "aeralyth";
const ADMIN_PASSWORD =
  process.env.AERALYTH_MCP_E2E_ADMIN_PASSWORD ?? "aeralyth";
const ROOT = process.cwd();
const BUILD = path.join(ROOT, ".mcp-build");
// Larger than one 32 MiB single upload, so it takes the multipart path.
const LARGE_FILE_BYTES = 40 * 1024 * 1024 + 12_345;
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type ToolResult = {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
};

class McpClient {
  private nextId = 1;
  private buffered = "";
  private readonly waiting = new Map<number, (message: unknown) => void>();
  readonly stderr: string[] = [];

  constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.buffered += chunk;
      for (;;) {
        const newline = this.buffered.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffered.slice(0, newline);
        this.buffered = this.buffered.slice(newline + 1);
        const message = JSON.parse(line) as { id?: number };
        if (typeof message.id === "number") {
          this.waiting.get(message.id)?.(message);
          this.waiting.delete(message.id);
        }
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.stderr.push(chunk));
  }

  request(
    method: string,
    params?: unknown,
  ): Promise<{ result?: unknown; error?: unknown }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve as (message: unknown) => void);
      this.child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  async call(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolResult> {
    const response = await this.request("tools/call", {
      name,
      arguments: args,
    });
    if (response.error) throw new Error(JSON.stringify(response.error));
    return response.result as ToolResult;
  }

  async text(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<string> {
    const result = await this.call(name, args);
    const text = result.content.map((item) => item.text ?? "").join("\n");
    if (result.isError) throw new Error(`${name} failed: ${text}`);
    return text;
  }

  async failure(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<string> {
    const result = await this.call(name, args);
    const text = result.content.map((item) => item.text ?? "").join("\n");
    if (!result.isError)
      throw new Error(`${name} unexpectedly succeeded: ${text}`);
    return text;
  }
}

async function signIn(
  client: VaultCryptoClient,
  username: string,
  password: string,
) {
  const info = await getAccountAuthInfo(username);
  const credential = await client.deriveAuthCredential(
    username,
    password,
    info.salt,
  );
  const login = await loginAccount({
    username,
    ...(info.authVersion === ONE_PASSWORD_AUTH_VERSION
      ? { credential }
      : { legacyPassword: password }),
    remember: false,
  });
  return { login, credential };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function idIn(listing: string, name: string): string {
  const line = listing.split("\n").find((entry) => entry.startsWith(name));
  const id = line?.match(/id (fil_[A-Za-z0-9_-]+|[0-9a-f-]{36})/)?.[1];
  if (!id) throw new Error(`No id for ${name} in:\n${listing}`);
  return id;
}

describe.skipIf(!ORIGIN)("Aeralyth MCP server end to end", () => {
  const username = `mcp-e2e-${randomBytes(4).toString("hex")}`;
  const password = `mcp-${randomBytes(18).toString("base64url")}`;
  let child: ChildProcess;
  let mcp: McpClient;
  let scratch: string;

  beforeAll(async () => {
    execFileSync(process.execPath, ["scripts/build-mcp.mjs"], { cwd: ROOT });
    scratch = await mkdtemp(path.join(tmpdir(), "aeralyth-mcp-e2e-"));

    // Set up the account the way the admin page and first sign-in do.
    const api = createApiFetch({
      origin: ORIGIN as string,
      userAgent: "aeralyth-mcp-e2e",
    });
    vi.stubGlobal("fetch", api.fetch);
    const client = new VaultCryptoClient(undefined, () =>
      startNodeVaultWorker(
        pathToFileURL(path.join(BUILD, "aeralyth-vault-worker.mjs")),
      ),
    );
    try {
      const admin = await signIn(client, ADMIN_USERNAME, ADMIN_PASSWORD);
      const salt = toBase64Url(new Uint8Array(randomBytes(16)));
      const created = await fetch("/api/admin/users/one-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": admin.login.csrfToken,
        },
        body: JSON.stringify({
          username,
          credential: await client.deriveAuthCredential(
            username,
            password,
            salt,
          ),
          salt,
          role: "user",
        }),
      });
      expect(created.status, await created.text()).toBe(201);

      api.clearCookies();
      const user = await signIn(client, username, password);
      expect(user.login.user.vaultConfigured).toBe(false);
      const setup = await client.setup(password);
      await setupVault(user.login.csrfToken, setup.payload, {
        currentCredential: user.credential,
      });
    } finally {
      await client.close();
      vi.unstubAllGlobals();
    }

    child = spawn(process.execPath, [path.join(BUILD, "aeralyth-mcp.mjs")], {
      env: {
        ...process.env,
        AERALYTH_URL: ORIGIN,
        AERALYTH_USERNAME: username,
        AERALYTH_PASSWORD_COMMAND: `printf '%s\\n' '${password}'`,
        AERALYTH_PASSWORD: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    mcp = new McpClient(child);
    const initialized = await mcp.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "1" },
    });
    expect(initialized.result).toMatchObject({
      serverInfo: { name: "aeralyth" },
    });
  }, 300_000);

  afterAll(async () => {
    child?.stdin?.end();
    child?.kill();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("offers the vault tools", async () => {
    const listed = (await mcp.request("tools/list")).result as {
      tools: Array<{ name: string }>;
    };
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "create_folder",
      "download_file",
      "list_folder",
      "move_to_trash",
      "read_file",
      "rename",
      "restore_from_trash",
      "search",
      "upload",
      "write_file",
    ]);
  });

  it("works through a vault from folders to trash", async () => {
    try {
      expect(await mcp.text("list_folder")).toBe("/: empty.");

      expect(
        await mcp.text("create_folder", { path: "/Projects/Alpha" }),
      ).toMatch(/^Created \/Projects\/Alpha \(id /);
      expect(
        await mcp.text("create_folder", { path: "/Projects/Alpha" }),
      ).toMatch(/^\/Projects\/Alpha already exists/);

      await mcp.text("write_file", {
        path: "/Projects/Alpha/notes.md",
        content: "# First\n",
      });
      expect(
        await mcp.failure("write_file", {
          path: "/Projects/Alpha/notes.md",
          content: "nope",
        }),
      ).toMatch(/already exist.*overwrite/);
      await mcp.text("write_file", {
        path: "/Projects/Alpha/notes.md",
        content: "# Grüße\nSecond version\n",
        overwrite: true,
      });
      const notes = await mcp.text("read_file", {
        path: "/Projects/Alpha/notes.md",
      });
      expect(notes).toContain("# Grüße\nSecond version\n");
      expect(notes).toContain("text/markdown");

      await mcp.text("write_file", {
        path: "/Projects/pixel.png",
        content: PIXEL_PNG,
        encoding: "base64",
      });
      const pixel = await mcp.call("read_file", {
        path: "/Projects/pixel.png",
      });
      expect(pixel.isError).toBeFalsy();
      expect(pixel.content[1]).toEqual({
        type: "image",
        data: PIXEL_PNG,
        mimeType: "image/png",
      });

      const site = path.join(scratch, "site");
      await mkdir(path.join(site, ".hidden"), { recursive: true });
      await mkdir(path.join(site, "assets"), { recursive: true });
      const large = new Uint8Array(randomBytes(LARGE_FILE_BYTES));
      await writeFile(path.join(site, "index.html"), "<h1>Hi</h1>");
      await writeFile(path.join(site, "assets", "large.bin"), large);
      await writeFile(path.join(site, ".gitignore"), "ignored.txt\n");
      await writeFile(path.join(site, "ignored.txt"), "skip me");
      await writeFile(path.join(site, ".hidden", "secret"), "skip me too");
      expect(
        await mcp.text("upload", { source: site, destination: "/Projects" }),
      ).toMatch(/^Uploaded 3 file\(s\), 40 MB, to \/Projects\. Left out 2/);
      const uploaded = await mcp.text("list_folder", {
        path: "/Projects/site",
      });
      expect(uploaded).toContain("assets/");
      expect(uploaded).toContain("index.html");
      expect(uploaded).not.toContain("ignored.txt");

      const found = await mcp.text("search", { query: "LARGE" });
      expect(found).toContain("/Projects/site/assets/large.bin");
      expect(found).toMatch(/^1 match/);

      const downloads = path.join(scratch, "downloads");
      await mkdir(downloads);
      expect(
        await mcp.text("download_file", {
          path: "/Projects/site",
          destination: downloads,
        }),
      ).toMatch(/^Saved 3 file\(s\)/);
      expect(
        sha256(
          await readFile(path.join(downloads, "site", "assets", "large.bin")),
        ),
      ).toBe(sha256(large));
      expect(
        await readFile(path.join(downloads, "site", "index.html"), "utf8"),
      ).toBe("<h1>Hi</h1>");
      expect(
        await mcp.failure("download_file", {
          path: "/Projects/site",
          destination: downloads,
        }),
      ).toMatch(/already exists/);
      expect((await readdir(downloads)).sort()).toEqual(["site"]);

      expect(
        await mcp.text("rename", {
          path: "/Projects/Alpha/notes.md",
          new_name: "readme.md",
        }),
      ).toBe("Renamed “notes.md” to “readme.md” (/Projects/Alpha/readme.md).");
      expect(
        await mcp.text("read_file", { path: "/Projects/Alpha/readme.md" }),
      ).toContain("Second version");
      expect(
        await mcp.failure("read_file", { path: "/Projects/Alpha/notes.md" }),
      ).toMatch(/Nothing named “notes\.md”/);

      expect(
        await mcp.text("move_to_trash", { path: "/Projects/Alpha" }),
      ).toMatch(/^Moved \/Projects\/Alpha to the trash/);
      expect(
        await mcp.text("list_folder", { path: "/Projects" }),
      ).not.toContain("Alpha/");
      const trash = await mcp.text("list_folder", { view: "trash" });
      await mcp.text("restore_from_trash", { id: idIn(trash, "Alpha/") });
      expect(await mcp.text("list_folder", { path: "/Projects" })).toContain(
        "Alpha/",
      );
    } catch (failure) {
      console.error(mcp.stderr.join(""));
      throw failure;
    }
  }, 600_000);
});
