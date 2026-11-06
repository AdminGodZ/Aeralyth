import { describe, expect, it } from "vitest";

import {
  countHighlightedLines,
  highlightSource,
  MAX_HIGHLIGHTED_CHARACTERS,
  MAX_HIGHLIGHTED_LINES,
  splitSourceLines,
} from "@/features/repositories/repository-syntax-preview";

describe("repository syntax preview bounds", () => {
  it("splits lines the way shiki numbers them", () => {
    expect(splitSourceLines("a\r\nb\nc\n")).toEqual(["a", "b", "c", ""]);
    expect(splitSourceLines("")).toEqual([""]);
  });

  it("highlights every line of a small file", () => {
    expect(countHighlightedLines(["const a = 1;", "", "a;"])).toBe(3);
  });

  it("stops at the line limit", () => {
    const lines = Array.from({ length: MAX_HIGHLIGHTED_LINES + 50 }, () => "x");
    expect(countHighlightedLines(lines)).toBe(MAX_HIGHLIGHTED_LINES);
  });

  it("stops before the line that crosses the character limit", () => {
    const line = "y".repeat(999);
    const lines = Array.from({ length: 500 }, () => line);
    expect(countHighlightedLines(lines)).toBe(
      MAX_HIGHLIGHTED_CHARACTERS / (line.length + 1),
    );
    expect(
      countHighlightedLines(["z".repeat(MAX_HIGHLIGHTED_CHARACTERS)]),
    ).toBe(0);
  });
});

describe("repository syntax highlighting", () => {
  it("tokenizes a known language and its aliases with the JavaScript engine", async () => {
    const result = await highlightSource(
      "const answer: number = 42;",
      "ts",
      "github-dark",
    );
    expect(result.tokens).toHaveLength(1);
    const colors = new Set(result.tokens[0].map((token) => token.color));
    expect(colors.size).toBeGreaterThan(1);
    expect(result.bg).toBeTruthy();
  });

  it("tokenizes either theme from the shared highlighter", async () => {
    const source = "export function run() {\n  return 1;\n}";
    const dark = await highlightSource(source, "javascript", "github-dark");
    const light = await highlightSource(source, "javascript", "github-light");
    expect(light.tokens).toHaveLength(3);
    expect(light.bg).not.toBe(dark.bg);
  });

  it("keeps the full text of lines too long to tokenize", async () => {
    const line = `const value = "${"v".repeat(20_000)}";`;
    const result = await highlightSource(line, "javascript", "github-dark");
    expect(result.tokens[0].map((token) => token.content).join("")).toBe(line);
  });

  it("falls back to plain text for unknown languages", async () => {
    const result = await highlightSource(
      "a\nb",
      "not-a-language",
      "github-dark",
    );
    expect(
      result.tokens.map((line) => line.map((token) => token.content)),
    ).toEqual([["a"], ["b"]]);
  });
});
