import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("vault file-list bulk actions", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "vault-file-list.tsx"),
    "utf8",
  );

  it("runs recursive file mutations through the shared serialized lane", () => {
    expect(source).toContain("for (const entry of targets)");
    expect(source).toContain(
      "await mutateFileTree(entry.id, mutation, csrfToken)",
    );
    expect(source).not.toContain("Promise.allSettled(");
  });

  it("offers restore and permanent delete for a Trash selection", () => {
    expect(source).toContain("mutation: FileTreeMutation");
    expect(source).toContain('mutateEntries(targets, "restore")');
    expect(source).toContain('mutateEntries(targets, "delete")');
    expect(source).toContain("Delete permanently");
  });
});
