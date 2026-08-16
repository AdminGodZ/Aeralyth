import { describe, expect, it } from "vitest";

import { isVaultNodeId } from "@/features/vault/node-id";

describe("isVaultNodeId", () => {
  it.each([
    "fil_test",
    "fil_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-",
    "0cd06ddb-e797-4e7d-baf3-caa3a7880544",
  ])("accepts supported node ID %s", (nodeId) => {
    expect(isVaultNodeId(nodeId)).toBe(true);
  });

  it.each([
    "fil_abc",
    "0CD06DDB-E797-4E7D-BAF3-CAA3A7880544",
    "0cd06ddbe7974e7dbaf3caa3a7880544",
    "0cd06ddb-e797-0e7d-baf3-caa3a7880544",
    "0cd06ddb-e797-4e7d-7af3-caa3a7880544",
  ])("rejects unsupported node ID %s", (nodeId) => {
    expect(isVaultNodeId(nodeId)).toBe(false);
  });
});
