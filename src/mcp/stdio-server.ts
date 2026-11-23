/**
 * A Model Context Protocol server over stdio that offers tools only: one
 * JSON-RPC 2.0 message per line in, one per line out, logs on stderr.
 * https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 */

export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export type JsonSchema = {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: readonly (string | number)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
};

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResult = {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type ToolContext = {
  signal: AbortSignal;
  /** Reports progress when the client asked for it; a no-op otherwise. */
  progress(progress: number, total?: number, message?: string): void;
};

export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult>;
};

export type StdioServerOptions = {
  name: string;
  title: string;
  version: string;
  instructions?: string;
  tools: ToolDefinition[];
  write(line: string): void;
  log(message: string): void;
};

type JsonRpcId = string | number;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId | null;
  method: string;
  params?: unknown;
};

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class StdioMcpServer {
  private readonly tools: Map<string, ToolDefinition>;
  private readonly running = new Map<string, AbortController>();
  private buffered = "";

  constructor(private readonly options: StdioServerOptions) {
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  }

  /** Feeds raw stdin text; complete lines are handled as they arrive. */
  receive(chunk: string): void {
    this.buffered += chunk;
    for (;;) {
      const newline = this.buffered.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffered.slice(0, newline).trim();
      this.buffered = this.buffered.slice(newline + 1);
      if (line) void this.handleLine(line);
    }
  }

  /** Aborts every tool call still running, as when stdin closes. */
  abortAll(reason: string): void {
    for (const controller of this.running.values()) {
      controller.abort(new Error(reason));
    }
  }

  async handleLine(line: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.send(errorResponse(null, PARSE_ERROR, "Parse error"));
      return;
    }
    if (Array.isArray(message)) {
      if (message.length === 0) {
        this.send(errorResponse(null, INVALID_REQUEST, "Empty batch"));
        return;
      }
      const responses = (
        await Promise.all(message.map((item) => this.handleMessage(item)))
      ).filter((response) => response !== null);
      if (responses.length > 0) this.send(responses);
      return;
    }
    const response = await this.handleMessage(message);
    if (response) this.send(response);
  }

  private async handleMessage(message: unknown): Promise<unknown | null> {
    if (!isRequest(message)) {
      // Responses to requests this server never sends, or junk.
      if (isObject(message) && ("result" in message || "error" in message)) {
        return null;
      }
      return errorResponse(null, INVALID_REQUEST, "Invalid request");
    }
    const id = message.id;
    const isNotification = id === undefined;
    try {
      const result = await this.dispatch(message);
      return isNotification ? null : { jsonrpc: "2.0", id, result };
    } catch (failure) {
      if (isNotification) {
        this.options.log(
          `Notification ${message.method} failed: ${describe(failure)}`,
        );
        return null;
      }
      if (failure instanceof RpcError) {
        return errorResponse(id ?? null, failure.code, failure.message);
      }
      this.options.log(
        `Request ${message.method} failed: ${describe(failure)}`,
      );
      return errorResponse(id ?? null, INTERNAL_ERROR, "Internal error");
    }
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    switch (request.method) {
      case "initialize":
        return this.initialize(request.params);
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: Array.from(this.tools.values(), (tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            ...(tool.annotations
              ? { annotations: { title: tool.title, ...tool.annotations } }
              : {}),
          })),
        };
      case "tools/call":
        return this.callTool(request);
      case "notifications/cancelled": {
        const params = isObject(request.params) ? request.params : {};
        const requestId = params.requestId;
        if (typeof requestId === "string" || typeof requestId === "number") {
          this.running
            .get(runningKey(requestId))
            ?.abort(new Error("The client canceled this request."));
        }
        return null;
      }
      default:
        if (request.method.startsWith("notifications/")) return null;
        throw new RpcError(
          METHOD_NOT_FOUND,
          `Method not found: ${request.method}`,
        );
    }
  }

  private initialize(params: unknown) {
    const requested = isObject(params) ? params.protocolVersion : undefined;
    const protocolVersion =
      typeof requested === "string" &&
      (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: this.options.name,
        title: this.options.title,
        version: this.options.version,
      },
      ...(this.options.instructions
        ? { instructions: this.options.instructions }
        : {}),
    };
  }

  private async callTool(request: JsonRpcRequest): Promise<ToolResult> {
    const params = isObject(request.params) ? request.params : null;
    const name = params?.name;
    if (typeof name !== "string") {
      throw new RpcError(INVALID_PARAMS, "tools/call needs a tool name.");
    }
    const tool = this.tools.get(name);
    if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
    const args = params?.arguments ?? {};
    const problem = validate(args, tool.inputSchema, "arguments");
    if (problem) return errorResult(problem);

    const controller = new AbortController();
    const key = request.id == null ? null : runningKey(request.id);
    if (key) this.running.set(key, controller);
    const meta = isObject(params?._meta) ? params._meta : null;
    const progressToken =
      typeof meta?.progressToken === "string" ||
      typeof meta?.progressToken === "number"
        ? meta.progressToken
        : null;
    try {
      return await tool.handler(args as Record<string, unknown>, {
        signal: controller.signal,
        progress: (progress, total, message) => {
          if (progressToken === null || controller.signal.aborted) return;
          this.send({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: {
              progressToken,
              progress,
              ...(total === undefined ? {} : { total }),
              ...(message ? { message } : {}),
            },
          });
        },
      });
    } catch (failure) {
      return errorResult(describe(failure));
    } finally {
      if (key && this.running.get(key) === controller) this.running.delete(key);
    }
  }

  private send(message: unknown): void {
    this.options.write(`${JSON.stringify(message)}\n`);
  }
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Returns the first way `value` breaks `schema`, or null when it fits. */
export function validate(
  value: unknown,
  schema: JsonSchema,
  path: string,
): string | null {
  switch (schema.type) {
    case "object": {
      if (!isObject(value)) return `${path} must be an object.`;
      for (const key of schema.required ?? []) {
        if (value[key] === undefined) return `${path}.${key} is required.`;
      }
      for (const [key, item] of Object.entries(value)) {
        const property = schema.properties?.[key];
        if (!property) {
          if (schema.additionalProperties === false) {
            return `${path}.${key} is not a known argument.`;
          }
          continue;
        }
        if (item === undefined) continue;
        const problem = validate(item, property, `${path}.${key}`);
        if (problem) return problem;
      }
      return null;
    }
    case "string":
      if (typeof value !== "string") return `${path} must be a string.`;
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return `${path} must have at least ${schema.minLength} characters.`;
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `${path} must have at most ${schema.maxLength} characters.`;
      }
      break;
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `${path} must be a number.`;
      }
      if (schema.type === "integer" && !Number.isInteger(value)) {
        return `${path} must be a whole number.`;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        return `${path} must be at least ${schema.minimum}.`;
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return `${path} must be at most ${schema.maximum}.`;
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") return `${path} must be true or false.`;
      break;
    case "array": {
      if (!Array.isArray(value)) return `${path} must be a list.`;
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return `${path} must have at least ${schema.minItems} items.`;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `${path} must have at most ${schema.maxItems} items.`;
      }
      if (schema.items) {
        for (const [index, item] of value.entries()) {
          const problem = validate(item, schema.items, `${path}[${index}]`);
          if (problem) return problem;
        }
      }
      return null;
    }
  }
  if (
    schema.enum &&
    !schema.enum.includes(value as string | number) &&
    (typeof value === "string" || typeof value === "number")
  ) {
    return `${path} must be one of: ${schema.enum.join(", ")}.`;
  }
  return null;
}

function runningKey(id: JsonRpcId): string {
  return `${typeof id}:${id}`;
}

function errorResponse(id: JsonRpcId | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return (
    isObject(value) &&
    value.jsonrpc === "2.0" &&
    typeof value.method === "string" &&
    (value.id === undefined ||
      typeof value.id === "string" ||
      typeof value.id === "number")
  );
}

export function describe(failure: unknown): string {
  if (failure instanceof Error && failure.message) return failure.message;
  return typeof failure === "string" && failure ? failure : "The tool failed.";
}
