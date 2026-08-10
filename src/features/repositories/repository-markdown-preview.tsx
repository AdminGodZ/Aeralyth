"use client";

import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { RepositorySyntaxPreview } from "@/features/repositories/repository-syntax-preview";

const markdownComponents: Components = {
  a({ node: _node, ...props }) {
    return (
      <a
        {...props}
        className="font-medium text-primary underline underline-offset-4"
        rel="noreferrer noopener"
        target="_blank"
      />
    );
  },
  blockquote({ node: _node, ...props }) {
    return (
      <blockquote
        {...props}
        className="my-4 border-l-4 pl-4 text-muted-foreground"
      />
    );
  },
  code({ node: _node, className, children, ...props }) {
    const rawValue = String(children);
    const value = rawValue.replace(/\n$/u, "");
    const language = /language-([^\s]+)/u.exec(className ?? "")?.[1];
    const block =
      Boolean(language) || rawValue.endsWith("\n") || value.includes("\n");
    if (block) {
      return (
        <div className="my-4 overflow-hidden rounded-md border">
          <RepositorySyntaxPreview
            code={value}
            language={language ?? "text"}
            wrap={false}
            compact
          />
        </div>
      );
    }
    return (
      <code
        {...props}
        className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em]"
      >
        {children}
      </code>
    );
  },
  h1({ node: _node, ...props }) {
    return (
      <h1
        {...props}
        className="mb-4 mt-1 border-b pb-2 font-display text-3xl font-semibold"
      />
    );
  },
  h2({ node: _node, ...props }) {
    return (
      <h2
        {...props}
        className="mb-3 mt-8 border-b pb-2 font-display text-2xl font-semibold"
      />
    );
  },
  h3({ node: _node, ...props }) {
    return (
      <h3 {...props} className="mb-2 mt-6 font-display text-xl font-semibold" />
    );
  },
  h4({ node: _node, ...props }) {
    return (
      <h4 {...props} className="mb-2 mt-5 font-display text-lg font-semibold" />
    );
  },
  hr({ node: _node, ...props }) {
    return <hr {...props} className="my-6 border-border" />;
  },
  img({ node: _node, alt, src }) {
    const href = typeof src === "string" ? src : undefined;
    return href ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="my-4 flex min-h-24 items-center justify-center rounded-md border bg-muted/20 px-5 py-8 text-center text-sm text-primary hover:bg-muted/40"
      >
        Open referenced image{alt ? `: ${alt}` : ""}
      </a>
    ) : (
      <span className="text-muted-foreground">Referenced image</span>
    );
  },
  li({ node: _node, ...props }) {
    return <li {...props} className="my-1 pl-1" />;
  },
  ol({ node: _node, ...props }) {
    return <ol {...props} className="my-4 list-decimal space-y-1 pl-7" />;
  },
  p({ node: _node, ...props }) {
    return <p {...props} className="my-4 leading-7" />;
  },
  pre({ node: _node, children }) {
    return <>{children}</>;
  },
  table({ node: _node, ...props }) {
    return (
      <div className="my-5 overflow-x-auto rounded-md border">
        <table {...props} className="w-full border-collapse text-sm" />
      </div>
    );
  },
  td({ node: _node, ...props }) {
    return <td {...props} className="border-t px-3 py-2 align-top" />;
  },
  th({ node: _node, ...props }) {
    return (
      <th
        {...props}
        className="bg-muted/40 px-3 py-2 text-left font-semibold"
      />
    );
  },
  ul({ node: _node, ...props }) {
    return <ul {...props} className="my-4 list-disc space-y-1 pl-7" />;
  },
};

export function RepositoryMarkdownPreview({ markdown }: { markdown: string }) {
  return (
    <article className="mx-auto w-full max-w-5xl px-6 py-7 text-[15px] leading-7 sm:px-9">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {markdown}
      </Markdown>
    </article>
  );
}
