import { describe, expect, it } from "vitest";

import {
  calculateRepositoryLanguages,
  detectLanguage,
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
});
