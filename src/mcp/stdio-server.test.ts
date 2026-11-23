import { describe, expect, it } from "vitest";

import {
  StdioMcpServer,
  type ToolDefinition,
  validate,
} from "@/mcp/stdio-server";

function harness(tools: ToolDefinition[]) {
  const lines: unknown[] = [];
  const logs: string[] = [];
  const server = new StdioMcpServer({
    name: "test",
    title: "Test",
    version: "1.0.0",
    instructions: "Use carefully.",
    tools,
    write: (line) => {
      expect(line.endsWith("\n")).toBe(true);
      lines.push(JSON.parse(line));
    },
    log: (message) => logs.push(message),
  });
  return { server, lines, logs };
}

const echo: ToolDefinition = {
  name: "echo",
  title: "Echo",
  description: "Echoes its input.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", maxLength: 5 },
      times: { type: "integer", minimum: 1 },
    },
    required: ["text"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  handler: async (args) => ({
    content: [{ type: "text", text: String(args.text) }],
  }),
};

describe("StdioMcpServer", () => {
  it("negotiates a supported protocol version and falls back to the newest", async () => {
    const { server, lines } = harness([echo]);
    await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      }),
    );
    await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "1999-01-01" },
      }),
    );
    expect(lines).toMatchObject([
      {
        id: 1,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "test", version: "1.0.0" },
          instructions: "Use carefully.",
        },
      },
      { id: 2, result: { protocolVersion: "2025-06-18" } },
    ]);
  });

  it("lists tools with their schemas and annotations", async () => {
    const { server, lines } = harness([echo]);
    await server.handleLine('{"jsonrpc":"2.0","id":"a","method":"tools/list"}');
    expect(lines[0]).toMatchObject({
      id: "a",
      result: {
        tools: [
          {
            name: "echo",
            title: "Echo",
            inputSchema: { type: "object", required: ["text"] },
            annotations: { title: "Echo", readOnlyHint: true },
          },
        ],
      },
    });
  });

  it("calls a tool and reports bad arguments as a tool error", async () => {
    const { server, lines } = harness([echo]);
    await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hi" } },
      }),
    );
    await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "too long" } },
      }),
    );
    expect(lines).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "hi" }] },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            {
              type: "text",
              text: "arguments.text must have at most 5 characters.",
            },
          ],
          isError: true,
        },
      },
    ]);
  });

  it("turns a failing tool into a tool error and an unknown tool into a protocol error", async () => {
    const { server, lines } = harness([
      {
        ...echo,
        name: "fails",
        handler: async () => {
          throw new Error("The vault is locked.");
        },
      },
    ]);
    await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "fails", arguments: { text: "x" } },
      }),
    );
    await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "missing", arguments: {} },
      }),
    );
    expect(lines).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: "The vault is locked." }],
          isError: true,
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32602, message: "Unknown tool: missing" },
      },
    ]);
  });

  it("answers parse errors, unknown methods and pings, and ignores notifications", async () => {
    const { server, lines } = harness([echo]);
    await server.handleLine("{not json");
    await server.handleLine(
      '{"jsonrpc":"2.0","id":7,"method":"resources/list"}',
    );
    await server.handleLine('{"jsonrpc":"2.0","id":8,"method":"ping"}');
    await server.handleLine(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    );
    expect(lines).toEqual([
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
      {
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32601, message: "Method not found: resources/list" },
      },
      { jsonrpc: "2.0", id: 8, result: {} },
    ]);
  });

  it("splits input into lines across chunks and answers batches together", async () => {
    const { server, lines } = harness([echo]);
    server.receive('{"jsonrpc":"2.0","id":1,"meth');
    server.receive('od":"ping"}\n[{"jsonrpc":"2.0","id":2,"method":"ping"},');
    server.receive('{"jsonrpc":"2.0","method":"notifications/x"}]\n');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lines).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      [{ jsonrpc: "2.0", id: 2, result: {} }],
    ]);
  });

  it("aborts a running tool when the client cancels it and sends progress when asked", async () => {
    let sawAbort = false;
    const { server, lines } = harness([
      {
        ...echo,
        name: "slow",
        handler: (_args, { signal, progress }) =>
          new Promise((_, reject) => {
            progress(1, 4, "Started");
            signal.addEventListener("abort", () => {
              sawAbort = true;
              reject(signal.reason);
            });
          }),
      },
    ]);
    const call = server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "slow",
          arguments: { text: "x" },
          _meta: { progressToken: "p1" },
        },
      }),
    );
    await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 9, reason: "user" },
      }),
    );
    await call;
    expect(sawAbort).toBe(true);
    expect(lines[0]).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: "p1",
        progress: 1,
        total: 4,
        message: "Started",
      },
    });
    expect(lines[1]).toMatchObject({ id: 9, result: { isError: true } });
  });
});

describe("validate", () => {
  it("checks types, ranges, enums and required properties", () => {
    const schema = {
      type: "object" as const,
      properties: {
        view: { type: "string" as const, enum: ["files", "trash"] },
        limit: { type: "integer" as const, minimum: 1, maximum: 10 },
        flag: { type: "boolean" as const },
      },
      required: ["view"],
      additionalProperties: false,
    };
    expect(validate({ view: "files", limit: 3, flag: true }, schema, "a")).toBe(
      null,
    );
    expect(validate({}, schema, "a")).toBe("a.view is required.");
    expect(validate({ view: "nope" }, schema, "a")).toBe(
      "a.view must be one of: files, trash.",
    );
    expect(validate({ view: "files", limit: 1.5 }, schema, "a")).toBe(
      "a.limit must be a whole number.",
    );
    expect(validate({ view: "files", limit: 11 }, schema, "a")).toBe(
      "a.limit must be at most 10.",
    );
    expect(validate({ view: "files", flag: "yes" }, schema, "a")).toBe(
      "a.flag must be true or false.",
    );
    expect(validate([], schema, "a")).toBe("a must be an object.");
  });
});
