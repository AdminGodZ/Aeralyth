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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectLocalSelections,
  guessMimeType,
  localNameFor,
  writeStreamAtomically,
} from "@/mcp/local-files";
import { decodeText, joinVaultPath, splitVaultPath } from "@/mcp/operations";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aeralyth-mcp-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

describe("vault paths", () => {
  it("splits absolute paths and treats / as the root", () => {
    expect(splitVaultPath("/")).toEqual([]);
    expect(splitVaultPath("")).toEqual([]);
    expect(splitVaultPath("/Documents//Reports/")).toEqual([
      "Documents",
      "Reports",
    ]);
    expect(joinVaultPath("/", "a")).toBe("/a");
    expect(joinVaultPath("/a", "b")).toBe("/a/b");
    expect(joinVaultPath(null, "b")).toBeNull();
  });

  it("composes decomposed names and refuses relative segments", () => {
    expect(splitVaultPath("/Café")).toEqual(["Café"]);
    expect(() => splitVaultPath("/a/../b")).toThrow(/not supported/);
    expect(() => splitVaultPath("./a")).toThrow(/not supported/);
  });
});

describe("decodeText", () => {
  it("decodes UTF-8 and holds back a character cut in half", () => {
    const bytes = new TextEncoder().encode("grüß");
    expect(decodeText(bytes)).toBe("grüß");
    expect(decodeText(bytes.subarray(0, bytes.length - 1))).toBe("grü");
  });

  it("treats NUL bytes and mostly invalid UTF-8 as binary", () => {
    expect(decodeText(new Uint8Array([0x25, 0x50, 0x00, 0x01]))).toBeNull();
    expect(decodeText(new Uint8Array(200).fill(0xff))).toBeNull();
  });
});

describe("local files", () => {
  it("names and types files safely", () => {
    expect(localNameFor("a/b\\c")).toBe("a_b_c");
    expect(localNameFor("..")).toBe("_");
    expect(localNameFor("  ")).toBe("_");
    expect(guessMimeType("Report.PDF")).toBe("application/pdf");
    expect(guessMimeType("unknown.xyz")).toBe("");
  });

  it("collects a folder below its own name and skips .git", async () => {
    const root = path.join(directory, "project");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "hello");
    await writeFile(path.join(root, "src", "main.ts"), "export {}");
    await writeFile(path.join(root, ".git", "HEAD"), "ref");

    const { selections, isDirectory } = await collectLocalSelections(root, {
      maxFiles: 10,
    });

    expect(isDirectory).toBe(true);
    expect(selections.map((item) => item.relativePath).sort()).toEqual([
      "project/README.md",
      "project/src/main.ts",
    ]);
    const readme = selections.find((item) =>
      item.relativePath.endsWith("README.md"),
    );
    expect(readme?.file.type).toBe("text/markdown");
    expect(await readme?.file.text()).toBe("hello");
  });

  it("refuses folders with more files than allowed", async () => {
    await writeFile(path.join(directory, "a"), "1");
    await writeFile(path.join(directory, "b"), "2");
    await expect(
      collectLocalSelections(directory, { maxFiles: 1 }),
    ).rejects.toThrow(/more than 1 files/);
  });

  it("writes downloads atomically and keeps existing files unless told", async () => {
    const target = path.join(directory, "nested", "out.txt");
    await writeStreamAtomically(target, streamOf("one ", "two"), {
      overwrite: false,
    });
    expect(await readFile(target, "utf8")).toBe("one two");

    await expect(
      writeStreamAtomically(target, streamOf("three"), { overwrite: false }),
    ).rejects.toThrow(/already exists/);
    await writeStreamAtomically(target, streamOf("three"), { overwrite: true });
    expect(await readFile(target, "utf8")).toBe("three");

    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("network lost"));
      },
    });
    await expect(
      writeStreamAtomically(target, failing, { overwrite: true }),
    ).rejects.toThrow(/network lost/);
    expect(await readFile(target, "utf8")).toBe("three");
    expect(await readdir(path.dirname(target))).toEqual(["out.txt"]);
  });
});
