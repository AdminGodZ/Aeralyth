import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("repository encrypted-name hydration", () => {
  it("uses the metadata batch projection instead of serial full download plans", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/features/repositories/use-resolved-vault-names.ts",
      ),
      "utf8",
    );

    expect(source).toContain(".resolveMetadata(references");
    expect(source).toContain("vaultRecordVersion");
    expect(source).toContain("vaultRecordHash");
    expect(source).not.toContain("vault.openNode(");
    expect(source).not.toContain("for (const node of nodes)");
  });
});
