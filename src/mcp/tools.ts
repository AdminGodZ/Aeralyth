import { type Target, VaultOperations } from "@/mcp/operations";
import type { AeralythSession, FolderListing, VaultEntry } from "@/mcp/session";
import type {
  JsonSchema,
  ToolDefinition,
  ToolResult,
} from "@/mcp/stdio-server";

const DEFAULT_READ_BYTES = 256 * 1024;
const MAX_READ_BYTES = 10 * 1024 * 1024;
const MAX_WRITE_CHARACTERS = 20 * 1024 * 1024;

const pathProperty: JsonSchema = {
  type: "string",
  description:
    "Absolute vault path such as /Documents/report.pdf. Use / for the top level.",
  maxLength: 4096,
};
const idProperty: JsonSchema = {
  type: "string",
  description:
    "Item id from an earlier listing (fil_…). Use it instead of path when names repeat.",
  maxLength: 128,
};

function targetOf(args: Record<string, unknown>): Target {
  return {
    ...(typeof args.path === "string" ? { path: args.path } : {}),
    ...(typeof args.id === "string" ? { id: args.id } : {}),
  };
}

function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

export function createTools(session: AeralythSession): ToolDefinition[] {
  const operations = new VaultOperations(session);

  return [
    {
      name: "list_folder",
      title: "List folder",
      description:
        "List the files and folders in an Aeralyth folder, with decrypted names, sizes, dates and ids. Leave out path and id for the top level. view=shared lists what other people shared with you, view=trash lists the trash, view=recent the latest changes.",
      inputSchema: {
        type: "object",
        properties: {
          path: pathProperty,
          id: idProperty,
          view: {
            type: "string",
            enum: ["files", "shared", "trash", "recent", "favorites"],
            description: "Which listing to read. Defaults to files.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 5000,
            description: "Most entries to return (default 500).",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: (args, { signal }) =>
        session.run(
          async (connection) => {
            const listing = await operations.list(connection, targetOf(args), {
              view: (args.view as "files") ?? "files",
              maxEntries: (args.limit as number) ?? 500,
              signal,
            });
            return text(
              formatListing(listing, (args.view as string) ?? "files"),
            );
          },
          { repeatable: true },
        ),
    },
    {
      name: "search",
      title: "Search by name",
      description:
        "Find files and folders whose names contain the query (case-insensitive), searching a folder and everything below it. Names are end-to-end encrypted, so this walks folders and decrypts names locally; narrow it with path for large vaults.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500 },
          path: {
            ...pathProperty,
            description: "Folder to search in (default /).",
          },
          id: idProperty,
          type: { type: "string", enum: ["file", "folder"] },
          max_results: { type: "integer", minimum: 1, maximum: 500 },
          max_folders: {
            type: "integer",
            minimum: 1,
            maximum: 5000,
            description: "Most folders to open before stopping (default 300).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: (args, { signal, progress }) =>
        session.run(
          async (connection) => {
            const result = await operations.search(connection, targetOf(args), {
              query: args.query as string,
              type: args.type as "file" | "folder" | undefined,
              maxResults: (args.max_results as number) ?? 50,
              maxFolders: (args.max_folders as number) ?? 300,
              signal,
              progress,
            });
            const lines = result.matches.map((entry) =>
              formatEntry(entry, entry.path ?? entry.name),
            );
            const footer = result.complete
              ? `Searched ${result.foldersSearched} folder(s).`
              : `Stopped after ${result.foldersSearched} folder(s); raise max_folders or narrow path to search further.`;
            return text(
              [
                `${result.matches.length} match(es) for “${args.query as string}”.`,
                ...lines,
                footer,
              ].join("\n"),
            );
          },
          { repeatable: true },
        ),
    },
    {
      name: "read_file",
      title: "Read file",
      description:
        "Decrypt a file and return its contents: text as text, PNG/JPEG/GIF/WebP as an image. Other binary files are described instead; use download_file for those. Long files are cut at max_bytes.",
      inputSchema: {
        type: "object",
        properties: {
          path: pathProperty,
          id: idProperty,
          max_bytes: {
            type: "integer",
            minimum: 1,
            maximum: MAX_READ_BYTES,
            description: `Most bytes to read (default ${DEFAULT_READ_BYTES}).`,
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: (args, { signal }) =>
        session.run(
          async (connection) => {
            const maxBytes = (args.max_bytes as number) ?? DEFAULT_READ_BYTES;
            const file = await operations.readFile(connection, targetOf(args), {
              maxBytes,
              signal,
            });
            const label = `${file.path ?? file.name} (${formatBytes(file.size)}, ${
              file.mimeType ?? "unknown type"
            }, id ${file.id})`;
            if (file.kind === "image") {
              if (!file.base64) {
                return text(
                  `${label} is an image larger than max_bytes (${formatBytes(maxBytes)}). Raise max_bytes or use download_file.`,
                );
              }
              return {
                content: [
                  { type: "text", text: label },
                  {
                    type: "image",
                    data: file.base64,
                    mimeType: file.mimeType ?? "image/png",
                  },
                ],
              };
            }
            if (file.kind === "binary") {
              return text(
                `${label} is a binary file. Use download_file to save it locally.`,
              );
            }
            const note = file.truncated
              ? `\n\n[Cut after ${formatBytes(maxBytes)} of ${formatBytes(file.size)}. Raise max_bytes to read more.]`
              : "";
            return text(`${label}\n\n${file.text}${note}`);
          },
          { repeatable: true },
        ),
    },
    {
      name: "download_file",
      title: "Download to this computer",
      description:
        "Decrypt a file, or a folder with everything in it, and save it on this computer. If destination is an existing folder the item is saved inside it under its own name; otherwise destination is the new file or folder path.",
      inputSchema: {
        type: "object",
        properties: {
          path: pathProperty,
          id: idProperty,
          destination: {
            type: "string",
            minLength: 1,
            maxLength: 4096,
            description: "Local path; ~ means the home folder.",
          },
          overwrite: {
            type: "boolean",
            description:
              "Replace local files that already exist (default false).",
          },
        },
        required: ["destination"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      handler: (args, { signal, progress }) =>
        session.run(
          async (connection) => {
            const result = await operations.download(
              connection,
              targetOf(args),
              {
                destination: args.destination as string,
                overwrite: args.overwrite === true,
                signal,
                progress,
              },
            );
            return text(
              `Saved ${result.files} file(s), ${formatBytes(result.bytes)}, to ${result.localPath}.`,
            );
          },
          { repeatable: true },
        ),
    },
    {
      name: "upload",
      title: "Upload from this computer",
      description:
        "Encrypt a local file or folder and upload it into a vault folder (created if missing). Folder uploads follow .gitignore files and leave out hidden folders and .git, like the browser does, unless include_ignored is true. Existing files are only replaced when overwrite is true.",
      inputSchema: {
        type: "object",
        properties: {
          source: {
            type: "string",
            minLength: 1,
            maxLength: 4096,
            description: "Local file or folder path; ~ means the home folder.",
          },
          destination: {
            ...pathProperty,
            description:
              "Vault folder to upload into, e.g. /Projects. Default /.",
          },
          destination_id: {
            ...idProperty,
            description: "Vault folder id instead of destination.",
          },
          name: {
            type: "string",
            maxLength: 180,
            description:
              "Name to give the uploaded file or folder in the vault.",
          },
          overwrite: {
            type: "boolean",
            description:
              "Replace existing files with a new version (default false).",
          },
          include_ignored: {
            type: "boolean",
            description: "Also upload git-ignored files and hidden folders.",
          },
        },
        required: ["source"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      handler: (args, { signal, progress }) =>
        session.run(
          async (connection) => {
            const result = await operations.upload(connection, {
              source: args.source as string,
              destination:
                typeof args.destination_id === "string"
                  ? { id: args.destination_id }
                  : { path: (args.destination as string) ?? "/" },
              name: args.name as string | undefined,
              overwrite: args.overwrite === true,
              includeIgnored: args.include_ignored === true,
              signal,
              progress,
            });
            const skipped =
              result.skipped > 0
                ? ` Left out ${result.skipped} ignored or hidden file(s).`
                : "";
            return text(
              `Uploaded ${result.files} file(s), ${formatBytes(result.bytes)}, to ${
                result.destinationPath ?? "the folder"
              }.${skipped}`,
            );
          },
          { repeatable: false },
        ),
    },
    {
      name: "write_file",
      title: "Write file",
      description:
        "Create a file in the vault from the given content, creating missing folders on the way. An existing file is only replaced (as a new version) when overwrite is true.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            ...pathProperty,
            description: "Full vault path of the file, e.g. /Notes/plan.md.",
          },
          content: { type: "string", maxLength: MAX_WRITE_CHARACTERS },
          encoding: {
            type: "string",
            enum: ["utf8", "base64"],
            description: "How content is encoded (default utf8).",
          },
          mime_type: { type: "string", maxLength: 255 },
          overwrite: { type: "boolean" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      handler: (args, { signal }) =>
        session.run(
          async (connection) => {
            const result = await operations.writeFile(connection, {
              vaultPath: args.path as string,
              content: args.content as string,
              encoding: (args.encoding as "utf8" | "base64") ?? "utf8",
              mimeType: args.mime_type as string | undefined,
              overwrite: args.overwrite === true,
              signal,
            });
            return text(
              `Wrote ${formatBytes(result.bytes)} to ${result.path}.`,
            );
          },
          { repeatable: false },
        ),
    },
    {
      name: "create_folder",
      title: "Create folder",
      description:
        "Create a folder, including any missing parent folders. Folders that already exist are left as they are.",
      inputSchema: {
        type: "object",
        properties: { path: pathProperty },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: (args, { signal }) =>
        session.run(
          async (connection) => {
            const folder = await operations.ensureFolder(
              connection,
              { path: args.path as string },
              signal,
            );
            return text(
              folder.created > 0
                ? `Created ${folder.path} (id ${folder.id}).`
                : `${folder.path} already exists (id ${folder.id}).`,
            );
          },
          { repeatable: true },
        ),
    },
    {
      name: "rename",
      title: "Rename",
      description:
        "Rename a file or folder in place. It stays in the same folder.",
      inputSchema: {
        type: "object",
        properties: {
          path: pathProperty,
          id: idProperty,
          new_name: { type: "string", minLength: 1, maxLength: 180 },
        },
        required: ["new_name"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      handler: (args, { signal }) =>
        session.run(
          async (connection) => {
            const result = await operations.rename(
              connection,
              targetOf(args),
              args.new_name as string,
              signal,
            );
            return text(
              `Renamed “${result.from}” to “${result.to}”${
                result.path ? ` (${result.path})` : ""
              }.`,
            );
          },
          { repeatable: false },
        ),
    },
    {
      name: "move_to_trash",
      title: "Move to trash",
      description:
        "Move a file or folder (with everything in it) to the trash. It can be restored with restore_from_trash until the trash retention period ends.",
      inputSchema: {
        type: "object",
        properties: { path: pathProperty, id: idProperty },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: (args, { signal }) =>
        session.run(
          async (connection) => {
            const target = targetOf(args);
            if (!target.path && !target.id) {
              throw new Error(
                "Name the item to move to the trash with path or id.",
              );
            }
            const node = await operations.moveToTrash(
              connection,
              target,
              signal,
            );
            return text(
              `Moved ${node.path ?? node.name} to the trash (id ${node.id}; restore_from_trash brings it back).`,
            );
          },
          { repeatable: false },
        ),
    },
    {
      name: "restore_from_trash",
      title: "Restore from trash",
      description:
        "Restore an item from the trash to where it was. Find its id with list_folder view=trash.",
      inputSchema: {
        type: "object",
        properties: {
          id: { ...idProperty, description: "Id of the trashed item." },
        },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: (args, { signal }) =>
        session.run(
          async (connection) => {
            await operations.restore(connection, args.id as string, signal);
            return text(`Restored ${args.id as string} from the trash.`);
          },
          { repeatable: false },
        ),
    },
  ];
}

function formatListing(listing: FolderListing, view: string): string {
  const heading =
    view === "files"
      ? `${listing.path ?? "Folder"}${listing.folderId ? ` (id ${listing.folderId})` : ""}`
      : `${view[0].toUpperCase()}${view.slice(1)}`;
  if (listing.entries.length === 0) return `${heading}: empty.`;
  const lines = listing.entries.map((entry) => formatEntry(entry, entry.name));
  return [
    `${heading}: ${listing.entries.length} item(s)${listing.truncated ? ", more not shown (raise limit)" : ""}.`,
    ...lines,
  ].join("\n");
}

function formatEntry(entry: VaultEntry, label: string): string {
  const details = [
    entry.type === "folder" ? "folder" : formatBytes(entry.size),
    `modified ${entry.updatedAt.slice(0, 16).replace("T", " ")}`,
    `id ${entry.id}`,
  ];
  if (entry.state === "trashed") details.push("in trash");
  if (entry.shared) details.push("shared");
  if (entry.owner) details.push(`owner ${entry.owner}`);
  if (entry.unreadable) details.push(`name unreadable: ${entry.unreadable}`);
  return `${entry.type === "folder" ? `${label}/` : label}  (${details.join(", ")})`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "size unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
