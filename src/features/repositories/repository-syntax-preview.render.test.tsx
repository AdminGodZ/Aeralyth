import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  RepositorySyntaxPreview,
  SOURCE_THEME_COLORS,
} from "@/features/repositories/repository-syntax-preview";

describe("RepositorySyntaxPreview rendering", () => {
  it("shows the source as plain numbered lines before highlighting resolves", () => {
    // Effects do not run on the server, so this is the first paint before
    // the highlighter or grammar has loaded.
    const html = renderToStaticMarkup(
      <RepositorySyntaxPreview
        code={"const a = 1;\n\nif (a < 2) {}"}
        language="typescript"
        wrap={false}
      />,
    );

    expect(html).toContain("font-mono text-[13px] leading-5");
    expect(html).toContain(
      `background-color:${SOURCE_THEME_COLORS["github-dark"].bg}`,
    );
    expect(html).toContain(`color:${SOURCE_THEME_COLORS["github-dark"].fg}`);
    expect(html.match(/<li /gu)).toHaveLength(3);
    expect(html).toContain(">1</span>");
    expect(html).toContain(">3</span>");
    expect(html).toContain("<code");
    expect(html).toContain("const a = 1;");
    expect(html).toContain("if (a &lt; 2) {}");
    expect(html).not.toContain("animate-pulse");
  });
});
