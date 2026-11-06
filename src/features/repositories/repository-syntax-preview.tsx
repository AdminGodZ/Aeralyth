"use client";

import { useTheme } from "next-themes";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import type { HighlighterCore } from "shiki/core";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Tokenizing runs on the main thread, so only the head of a large file is
// highlighted. The remainder renders as plain lines with continuous numbers.
export const MAX_HIGHLIGHTED_LINES = 2_000;
export const MAX_HIGHLIGHTED_CHARACTERS = 200_000;
// Single minified lines can stall the tokenizer; shiki leaves longer lines
// unhighlighted.
const MAX_TOKENIZED_LINE_LENGTH = 10_000;
const TAB_COLUMNS = 8;

export type SourceTheme = "github-dark" | "github-light";

type HighlightToken = {
  color?: string;
  content: string;
  fontStyle?: number;
};

export type RawHighlightResult = {
  bg?: string;
  fg?: string;
  tokens: HighlightToken[][];
};

type HighlightResult = {
  bg?: string;
  fg?: string;
  lines: Array<Array<HighlightToken & { id: string }>>;
};

type HighlightCache = {
  code: string;
  language: string;
  byTheme: Partial<Record<SourceTheme, HighlightResult>>;
};

const CODE_SKELETON_WIDTHS = [42, 61, 80, 49, 68, 87, 56, 75, 94];

export function RepositorySyntaxPreview({
  code,
  language,
  wrap,
  compact = false,
}: {
  code: string;
  language: string;
  wrap: boolean;
  compact?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const theme: SourceTheme =
    resolvedTheme === "light" ? "github-light" : "github-dark";
  const lines = useMemo(() => splitSourceLines(code), [code]);
  const highlightedLineCount = useMemo(
    () => countHighlightedLines(lines),
    [lines],
  );
  const lineItems = useMemo(
    () =>
      lines.map((text, index) => {
        const lineNumber = index + 1;
        return {
          id: `source-line-${lineNumber}`,
          lineNumber,
          text,
          // Off-screen lines skip layout and paint; the estimate keeps the
          // scroll extent stable until a line has rendered once.
          style: {
            contentVisibility: "auto",
            containIntrinsicSize: `auto calc(5.25rem + ${sourceColumns(text)}ch) auto 1.25rem`,
          } satisfies CSSProperties,
        };
      }),
    [lines],
  );
  // Each theme is tokenized at most once per file; switching back reuses it.
  const [cache, setCache] = useState<HighlightCache | null>(null);
  const sameSource = cache?.code === code && cache.language === language;
  const current = sameSource ? cache.byTheme[theme] : undefined;
  const highlighted =
    current ?? (sameSource ? Object.values(cache.byTheme)[0] : undefined);

  useEffect(() => {
    if (current) return;
    let canceled = false;
    void (async () => {
      const source = lines.slice(0, highlightedLineCount).join("\n");
      let result: HighlightResult;
      try {
        const raw = await highlightSource(source, language, theme);
        result = normalizeHighlightResult(raw, highlightedLineCount);
      } catch {
        result = { lines: [] };
      }
      if (canceled) return;
      setCache((previous) =>
        previous?.code === code && previous.language === language
          ? { ...previous, byTheme: { ...previous.byTheme, [theme]: result } }
          : { code, language, byTheme: { [theme]: result } },
      );
    })();
    return () => {
      canceled = true;
    };
  }, [code, current, highlightedLineCount, language, lines, theme]);

  if (!highlighted) {
    return (
      <div className={cn("space-y-2 p-4", compact && "p-3")}>
        {CODE_SKELETON_WIDTHS.slice(0, compact ? 4 : 9).map((width) => (
          <Skeleton
            key={`code-skeleton-${width}`}
            className="h-4"
            style={{ width: `${width}%` }}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className="overflow-auto font-mono text-[13px] leading-5"
      style={{ backgroundColor: highlighted.bg, color: highlighted.fg }}
    >
      <ol className={cn("py-3", !wrap && "min-w-max", compact && "py-2")}>
        {lineItems.map((line, index) => {
          const tokens = highlighted.lines[index];
          return (
            <li
              key={line.id}
              className={cn(
                "grid grid-cols-[4rem_minmax(0,1fr)] px-3 hover:bg-white/5",
                wrap && "min-w-0",
              )}
              style={line.style}
            >
              <span
                className="select-none pr-4 text-right text-current opacity-40"
                aria-hidden="true"
              >
                {line.lineNumber}
              </span>
              <code
                className={cn(
                  "block pr-5 whitespace-pre",
                  wrap && "min-w-0 whitespace-pre-wrap break-words",
                )}
              >
                {tokens && tokens.length > 0
                  ? tokens.map((token) => (
                      <span
                        key={token.id}
                        style={{
                          color: token.color,
                          fontStyle:
                            token.fontStyle && (token.fontStyle & 1) !== 0
                              ? "italic"
                              : undefined,
                          fontWeight:
                            token.fontStyle && (token.fontStyle & 2) !== 0
                              ? "bold"
                              : undefined,
                          textDecoration:
                            token.fontStyle && (token.fontStyle & 4) !== 0
                              ? "underline"
                              : undefined,
                        }}
                      >
                        {token.content}
                      </span>
                    ))
                  : line.text || " "}
              </code>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Splits like shiki does, so highlighted and plain lines stay aligned. */
export function splitSourceLines(code: string): string[] {
  return code.split(/\r?\n/u);
}

/** Number of leading lines that fit inside both highlight bounds. */
export function countHighlightedLines(lines: readonly string[]): number {
  const limit = Math.min(lines.length, MAX_HIGHLIGHTED_LINES);
  let characters = 0;
  for (let index = 0; index < limit; index += 1) {
    characters += lines[index].length + 1;
    if (characters > MAX_HIGHLIGHTED_CHARACTERS) return index;
  }
  return limit;
}

function sourceColumns(line: string): number {
  if (!line.includes("\t")) return line.length;
  let columns = 0;
  for (const character of line) {
    columns += character === "\t" ? TAB_COLUMNS - (columns % TAB_COLUMNS) : 1;
  }
  return columns;
}

// The core highlighter with the JavaScript regex engine avoids the oniguruma
// wasm chunk. Themes load with it; each grammar loads once, on first use.
let highlighterPromise: Promise<HighlighterCore> | null = null;
const languageLoads = new Map<string, Promise<string>>();

function loadHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] =
      await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
      ]);
    return createHighlighterCore({
      engine: createJavaScriptRegexEngine({ forgiving: true }),
      themes: [
        import("shiki/themes/github-dark.mjs"),
        import("shiki/themes/github-light.mjs"),
      ],
    });
  })().catch((error: unknown) => {
    highlighterPromise = null;
    throw error;
  });
  return highlighterPromise;
}

async function loadLanguage(
  highlighter: HighlighterCore,
  language: string,
): Promise<string> {
  const requested = language.toLowerCase();
  const { bundledLanguagesInfo } = await import("shiki/langs");
  const info = bundledLanguagesInfo.find(
    (candidate) =>
      candidate.id === requested || candidate.aliases?.includes(requested),
  );
  if (!info) return "text";
  let loading = languageLoads.get(info.id);
  if (!loading) {
    loading = highlighter
      .loadLanguage(info.import)
      .then(() => info.id)
      .catch((error: unknown) => {
        languageLoads.delete(info.id);
        throw error;
      });
    languageLoads.set(info.id, loading);
  }
  return loading;
}

export async function highlightSource(
  code: string,
  language: string,
  theme: SourceTheme,
): Promise<RawHighlightResult> {
  const highlighter = await loadHighlighter();
  const options = {
    theme,
    tokenizeMaxLineLength: MAX_TOKENIZED_LINE_LENGTH,
  };
  try {
    const lang = await loadLanguage(highlighter, language);
    return highlighter.codeToTokens(code, { ...options, lang });
  } catch {
    return highlighter.codeToTokens(code, { ...options, lang: "text" });
  }
}

function normalizeHighlightResult(
  result: RawHighlightResult,
  lineCount: number,
): HighlightResult {
  return {
    bg: result.bg,
    fg: result.fg,
    lines: result.tokens.slice(0, lineCount).map((line, lineIndex) => {
      let column = 0;
      const lineNumber = lineIndex + 1;
      return line.map((token) => {
        const id = `source-token-${lineNumber}-${column}`;
        column += token.content.length;
        return {
          color: token.color,
          content: token.content,
          fontStyle: token.fontStyle,
          id,
        };
      });
    }),
  };
}
