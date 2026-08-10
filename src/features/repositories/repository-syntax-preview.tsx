"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import type { BundledLanguage } from "shiki";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type HighlightToken = {
  color?: string;
  content: string;
  fontStyle?: number;
};

type RawHighlightResult = {
  bg: string;
  fg: string;
  tokens: HighlightToken[][];
};

type HighlightResult = {
  bg: string;
  fg: string;
  lines: Array<{
    id: string;
    lineNumber: number;
    tokens: Array<HighlightToken & { id: string }>;
  }>;
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
  const [highlighted, setHighlighted] = useState<HighlightResult | null>(null);

  useEffect(() => {
    let canceled = false;
    void (async () => {
      const { codeToTokens } = await import("shiki");
      const theme = resolvedTheme === "light" ? "github-light" : "github-dark";
      let result: RawHighlightResult;
      try {
        result = (await codeToTokens(code, {
          lang: language as BundledLanguage,
          theme,
        })) as RawHighlightResult;
      } catch {
        result = (await codeToTokens(code, {
          lang: "text",
          theme,
        })) as RawHighlightResult;
      }
      if (!canceled) setHighlighted(normalizeHighlightResult(result));
    })();
    return () => {
      canceled = true;
    };
  }, [code, language, resolvedTheme]);

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
      <ol className={cn("min-w-max py-3", compact && "py-2")}>
        {highlighted.lines.map((line) => (
          <li
            key={line.id}
            className={cn(
              "grid grid-cols-[4rem_minmax(0,1fr)] px-3 hover:bg-white/5",
              wrap && "min-w-0",
            )}
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
              {line.tokens.length > 0
                ? line.tokens.map((token) => (
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
                : "\u00a0"}
            </code>
          </li>
        ))}
      </ol>
    </div>
  );
}

function normalizeHighlightResult(result: RawHighlightResult): HighlightResult {
  return {
    bg: result.bg,
    fg: result.fg,
    lines: result.tokens.map((line, lineIndex) => {
      let column = 0;
      const lineNumber = lineIndex + 1;
      return {
        id: `source-line-${lineNumber}`,
        lineNumber,
        tokens: line.map((token) => {
          const id = `source-token-${lineNumber}-${column}`;
          column += token.content.length;
          return { ...token, id };
        }),
      };
    }),
  };
}
