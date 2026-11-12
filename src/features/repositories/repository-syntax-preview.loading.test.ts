import { bundledLanguagesInfo } from "shiki/langs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  highlightSource,
  preloadSourceHighlighter,
} from "@/features/repositories/repository-syntax-preview";

const shiki = vi.hoisted(() => ({
  highlighterGate: null as Promise<void> | null,
  highlightersCreated: 0,
}));

vi.mock("shiki/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("shiki/core")>();
  return {
    ...original,
    createHighlighterCore: async (
      ...args: Parameters<typeof original.createHighlighterCore>
    ) => {
      shiki.highlightersCreated += 1;
      await shiki.highlighterGate;
      return original.createHighlighterCore(...args);
    },
  };
});

// The preview looks grammars up in this list, so wrapping each entry's import
// records every grammar fetch and lets a test fail one.
const grammarImports: string[] = [];
const failingGrammars = new Set<string>();
const originalImports = new Map(
  bundledLanguagesInfo.map((info) => [info, info.import]),
);
for (const [info, load] of originalImports) {
  info.import = () => {
    grammarImports.push(info.id);
    return failingGrammars.has(info.id)
      ? Promise.reject(new Error("Failed to fetch grammar chunk"))
      : load();
  };
}

afterAll(() => {
  for (const [info, load] of originalImports) info.import = load;
});

beforeEach(() => {
  grammarImports.length = 0;
  failingGrammars.clear();
});

// The highlighter is shared by the whole module, so the tests run in order:
// the first creates it, and each test uses a grammar no earlier test loaded.
describe("repository syntax highlighter loading", () => {
  it("fetches the grammar while the highlighter is still loading", async () => {
    let release = () => {};
    shiki.highlighterGate = new Promise((resolve) => {
      release = resolve;
    });

    preloadSourceHighlighter("rust");
    await vi.waitFor(() => {
      expect(grammarImports).toEqual(["rust"]);
      expect(shiki.highlightersCreated).toBe(1);
    });

    release();
    const result = await highlightSource("fn main() {}", "rust", "github-dark");
    const colors = new Set(result.tokens[0].map((token) => token.color));
    expect(colors.size).toBeGreaterThan(1);
  });

  it("loads the highlighter and each grammar once across preloads and aliases", async () => {
    preloadSourceHighlighter("ts");
    preloadSourceHighlighter("typescript");
    await Promise.all([
      highlightSource("const a = 1;", "ts", "github-dark"),
      highlightSource("const a = 1;", "typescript", "github-light"),
    ]);
    await highlightSource("let b = 2;", "TS", "github-dark");

    expect(shiki.highlightersCreated).toBe(1);
    expect(grammarImports).toEqual(["typescript"]);
  });

  it("falls back to plain text when the grammar fails to load, then retries", async () => {
    failingGrammars.add("go");
    const source = "func main() {}\nvar x = 1";

    preloadSourceHighlighter("go");
    const plain = await highlightSource(source, "go", "github-dark");
    expect(
      plain.tokens.map((line) => line.map((token) => token.content)),
    ).toEqual([["func main() {}"], ["var x = 1"]]);
    expect(plain.bg).toBeTruthy();

    failingGrammars.clear();
    const highlighted = await highlightSource(source, "go", "github-dark");
    expect(highlighted.tokens[0].length).toBeGreaterThan(1);
    expect(shiki.highlightersCreated).toBe(1);
  });
});
