import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  calculateRepositoryLanguages,
  detectLanguage,
  GENERATED_FILE_PATTERN,
  LANGUAGE_FILENAMES,
  LANGUAGE_IGNORED_DIRECTORIES,
  LOCK_FILE_PATTERN,
} from "@/features/repositories/repository-languages";

describe("repository language statistics", () => {
  it("detects common source languages and special filenames", () => {
    expect(detectLanguage("page.astro")?.name).toBe("Astro");
    expect(detectLanguage("component.tsx")?.name).toBe("TypeScript");
    expect(detectLanguage("Dockerfile")?.name).toBe("Dockerfile");
    expect(detectLanguage("package.json")).toBeNull();
  });

  it("calculates byte-weighted percentages", () => {
    const languages = calculateRepositoryLanguages([
      { name: "page.astro", path: "src/page.astro", sizeBytes: 300 },
      { name: "client.ts", path: "src/client.ts", sizeBytes: 100 },
    ]);

    expect(languages).toHaveLength(2);
    expect(languages[0]).toMatchObject({
      bytes: 300,
      name: "Astro",
      percentage: 75,
    });
    expect(languages[1]).toMatchObject({
      bytes: 100,
      name: "TypeScript",
      percentage: 25,
    });
  });

  it("ignores generated, vendored, lock, and data files", () => {
    expect(
      calculateRepositoryLanguages([
        { name: "app.min.js", path: "public/app.min.js", sizeBytes: 500 },
        { name: "index.js", path: "dist/index.js", sizeBytes: 500 },
        {
          name: "package-lock.json",
          path: "package-lock.json",
          sizeBytes: 500,
        },
        { name: "config.json", path: "config.json", sizeBytes: 500 },
      ]),
    ).toEqual([]);
  });

  it("merges server byte groups with client-resolved files", () => {
    const languages = calculateRepositoryLanguages(
      [{ name: "secret.ts", path: "src/secret.ts", sizeBytes: 100 }],
      [
        { kind: "extension", key: "ts", files: 2, bytes: 200 },
        { kind: "extension", key: "astro", files: 1, bytes: 100 },
        { kind: "filename", key: "dockerfile", files: 1, bytes: 100 },
        { kind: "extension", key: "json", files: 4, bytes: 900 },
        { kind: "extension", key: "constructor", files: 1, bytes: 900 },
        { kind: "filename", key: "readme", files: 1, bytes: 900 },
      ],
    );

    expect(languages.map(({ name, bytes }) => [name, bytes])).toEqual([
      ["TypeScript", 300],
      ["Astro", 100],
      ["Dockerfile", 100],
    ]);
    expect(languages[0].percentage).toBe(60);
    expect(detectLanguage("prototype.constructor")).toBeNull();
  });

  it("keeps the server-side readable-name rules in sync", () => {
    const source = readFileSync(
      resolve(
        import.meta.dirname,
        "../../../backend/src/routes/repositories.rs",
      ),
      "utf8",
    );
    const rustList = (name: string) => {
      const body = source.match(
        new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\];`, "u"),
      )?.[1];
      return [...(body ?? "").matchAll(/"([^"]*)"/gu)].map((match) => match[1]);
    };

    expect(rustList("LANGUAGE_IGNORED_DIRECTORIES")).toEqual([
      ...LANGUAGE_IGNORED_DIRECTORIES,
    ]);
    expect(rustList("LANGUAGE_FILENAMES").sort()).toEqual(
      [...LANGUAGE_FILENAMES].sort(),
    );
    for (const pattern of [GENERATED_FILE_PATTERN, LOCK_FILE_PATTERN]) {
      expect(pattern.flags).toContain("i");
      expect(source).toContain(
        `!~* '${pattern.source.replaceAll("(?:", "(")}'`,
      );
    }
  });
});
