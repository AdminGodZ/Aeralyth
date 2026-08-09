import { describe, expect, it } from "vitest";

import {
  detectProjectFolder,
  getSelectionRootName,
} from "@/features/repositories/project-detection";

describe("project folder detection", () => {
  it("detects a JavaScript project from its root manifest", () => {
    expect(
      detectProjectFolder([
        "admin-search/package.json",
        "admin-search/src/app.tsx",
        "admin-search/README.md",
      ]),
    ).toMatchObject({
      detected: true,
      confidence: "high",
      projectType: "JavaScript or TypeScript",
      signals: ["package.json", "README", "src directory"],
    });
  });

  it("detects Rust projects with Windows-style relative paths", () => {
    expect(
      detectProjectFolder(["aeralyth\\Cargo.toml", "aeralyth\\src\\main.rs"]),
    ).toMatchObject({
      detected: true,
      confidence: "high",
      projectType: "Rust",
    });
  });

  it("treats multiple project-like support signals as medium confidence", () => {
    expect(
      detectProjectFolder([
        "landing-page/README.md",
        "landing-page/src/index.js",
      ]),
    ).toMatchObject({ detected: true, confidence: "medium" });
  });

  it("does not flag an ordinary media folder", () => {
    expect(
      detectProjectFolder([
        "summer-trip/README.txt",
        "summer-trip/photos/beach.jpg",
      ]),
    ).toMatchObject({ detected: false, confidence: "none" });
  });

  it("returns the selected folder name", () => {
    expect(
      getSelectionRootName(["aeralyth/package.json", "aeralyth/src/app.tsx"]),
    ).toBe("aeralyth");
  });
});
