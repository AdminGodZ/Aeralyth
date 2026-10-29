import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("vault file-list bulk actions", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "vault-file-list.tsx"),
    "utf8",
  );

  it("sends one batch, then finishes deferred trees through the serialized lane", () => {
    const batch = source.indexOf("await mutateFileTrees(");
    const deferred = source.indexOf("for (const entryId of batch.deferred)");
    const perItem = source.indexOf(
      "await mutateFileTree(entry.id, mutation, csrfToken)",
    );
    expect(batch).toBeGreaterThan(-1);
    expect(deferred).toBeGreaterThan(batch);
    expect(perItem).toBeGreaterThan(deferred);
    expect(source).not.toContain("for (const entry of targets) {");
    expect(source).not.toContain("Promise.allSettled(");
  });

  it("offers restore and permanent delete for a Trash selection", () => {
    expect(source).toContain("mutation: FileTreeMutation");
    expect(source).toContain('mutateEntries(targets, "restore")');
    expect(source).toContain('mutateEntries(targets, "delete")');
    expect(source).toContain("Delete permanently");
  });
});
