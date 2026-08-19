import { describe, expect, it } from "vitest";

import { filterGitIgnoredSelections } from "@/features/dashboard/gitignore-filter";

function selection(relativePath: string, content = "") {
  const name = relativePath.replaceAll("\\", "/").split("/").at(-1) ?? "file";
  return {
    file: new File([content], name),
    relativePath,
  };
}

async function filteredPaths(
  selections: ReturnType<typeof selection>[],
): Promise<string[]> {
  const filtered = await filterGitIgnoredSelections(selections);
  return filtered.map(({ relativePath }) => relativePath);
}

describe("gitignore upload filtering", () => {
  it("removes ignored dependency, build, and log files", async () => {
    const paths = await filteredPaths([
      selection(
        "demo/.gitignore",
        "node_modules/\n.next/\n*.log\n!important.log\n",
      ),
      selection("demo/package.json"),
      selection("demo/src/index.ts"),
      selection("demo/node_modules/library/index.js"),
      selection("demo/.next/server/app.js"),
      selection("demo/debug.log"),
      selection("demo/important.log"),
    ]);

    expect(paths).toEqual([
      "demo/.gitignore",
      "demo/package.json",
      "demo/src/index.ts",
      "demo/important.log",
    ]);
  });

  it("applies nested rules without letting ignored directories re-include files", async () => {
    const ignoredGitignore = selection(
      "workspace/packages/blocked/.gitignore",
      "!keep.ts\n",
    );
    Object.defineProperty(ignoredGitignore.file, "text", {
      value: () => Promise.reject(new Error("ignored rules must not be read")),
    });
    const paths = await filteredPaths([
      selection("workspace/.gitignore", "*.generated.ts\npackages/blocked/\n"),
      selection(
        "workspace/packages/app/.gitignore",
        "!keep.generated.ts\ncache/\n",
      ),
      selection("workspace/packages/app/keep.generated.ts"),
      selection("workspace/packages/app/drop.generated.ts"),
      selection("workspace/packages/app/cache/data.json"),
      ignoredGitignore,
      selection("workspace/packages/blocked/keep.ts"),
    ]);

    expect(paths).toEqual([
      "workspace/.gitignore",
      "workspace/packages/app/.gitignore",
      "workspace/packages/app/keep.generated.ts",
    ]);
  });

  it("normalizes Windows-style folder paths", async () => {
    const paths = await filteredPaths([
      selection("demo\\.gitignore", "dist/\n"),
      selection("demo\\src\\index.ts"),
      selection("demo\\dist\\bundle.js"),
    ]);

    expect(paths).toEqual(["demo\\.gitignore", "demo\\src\\index.ts"]);
  });

  it("excludes hidden directories from defaults while keeping dotfiles", async () => {
    const files = [
      selection("demo/package.json"),
      selection("demo/src/app.ts"),
      selection("demo/.git/config"),
      selection("demo/.git/objects/pack/project.pack"),
      selection("demo/packages/tool/.cache/index.json"),
      selection("demo/.github/workflows/ci.yml"),
      selection("demo/.gitignore"),
      selection("demo/.gitmodules"),
      selection("demo/.nvmrc"),
    ];

    await expect(filteredPaths(files)).resolves.toEqual([
      "demo/package.json",
      "demo/src/app.ts",
      "demo/.gitignore",
      "demo/.gitmodules",
      "demo/.nvmrc",
    ]);
  });

  it("excludes hidden directories even when no gitignore exists", async () => {
    const paths = await filteredPaths([
      selection("demo/package.json"),
      selection("demo/.git/HEAD"),
      selection("demo/src/.cache/data.json"),
    ]);

    expect(paths).toEqual(["demo/package.json"]);
  });

  it("does not read .gitignore files inside hidden directories", async () => {
    const hiddenGitignore = selection("demo/.git/.gitignore", "*");
    Object.defineProperty(hiddenGitignore.file, "text", {
      value: () => Promise.reject(new Error("hidden rules must not be read")),
    });

    const paths = await filteredPaths([
      selection("demo/package.json"),
      hiddenGitignore,
      selection("demo/.git/HEAD"),
    ]);

    expect(paths).toEqual(["demo/package.json"]);
  });
});
