import { describe, expect, it } from "vitest";

import {
  ACCOUNT_AUTH_KDF,
  normalizeAccountUsername,
  ONE_PASSWORD_AUTH_VERSION,
} from "@/features/auth/account-password";

describe("one-password account parameters", () => {
  it("uses one stable case-insensitive username domain", () => {
    expect(normalizeAccountUsername("  Alice.Example  ")).toBe("alice.example");
  });

  it("keeps the authentication derivation distinct from the vault KDF", () => {
    expect(ONE_PASSWORD_AUTH_VERSION).toBe(1);
    expect(ACCOUNT_AUTH_KDF).toEqual({
      algorithm: "argon2id13",
      operations: 3,
      memoryBytes: 64 * 1024 * 1024,
      outputBytes: 32,
    });
  });
});
