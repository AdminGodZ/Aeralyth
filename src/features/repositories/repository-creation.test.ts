import { describe, expect, it } from "vitest";

import {
  getRepositoryNameError,
  normalizeRepositoryName,
} from "@/features/repositories/repository-creation";

describe("repository creation", () => {
  it("normalizes and accepts GitHub-style repository names", () => {
    expect(normalizeRepositoryName("  aeralyth-ui_2.0  ")).toBe(
      "aeralyth-ui_2.0",
    );
    expect(getRepositoryNameError("aeralyth-ui_2.0")).toBeNull();
  });

  it("rejects empty, unsafe, and overlong repository names", () => {
    for (const name of ["", "   ", ".", "..", "has spaces", "owner/repo"]) {
      expect(getRepositoryNameError(name)).not.toBeNull();
    }
    expect(getRepositoryNameError("a".repeat(101))).not.toBeNull();
  });
});
