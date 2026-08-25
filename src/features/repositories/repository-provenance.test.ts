import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("repository provenance", () => {
  it("does not describe every repository as an import", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "repository-detail.tsx"),
      "utf8",
    );

    expect(source).toContain(
      "Created {formatRepositoryDate(data.repository.createdAt)}",
    );
    expect(source).toContain("updated this repository");
    expect(source).not.toContain(
      "Imported {formatRepositoryDate(data.repository.createdAt)}",
    );
    expect(source).not.toContain("imported this project folder");
    expect(source).not.toContain("created this repository");
  });
});
