import { describe, expect, it } from "vitest";
import {
  normalizeVaultAutoLockMinutes,
  validVaultResumeExpiration,
  vaultAutoLockDeadline,
  vaultResumeRecordExpiration,
} from "./vault-preferences";

describe("Never automatic lock", () => {
  it("has no deadline and never becomes a zero-delay timeout", () => {
    expect(normalizeVaultAutoLockMinutes(0)).toBe(0);
    expect(vaultAutoLockDeadline(0, 1000)).toBe(0);
    expect(vaultResumeRecordExpiration(0)).toBe(0);
    expect(
      validVaultResumeExpiration(0, 1000 + 365 * 24 * 60 * 60 * 1000),
    ).toBe(true);
  });
  it("keeps finite lock deadlines bounded and rejects malformed resume records", () => {
    const deadline = vaultAutoLockDeadline(5, 1000);
    expect(deadline).toBe(301000);
    expect(vaultResumeRecordExpiration(deadline)).toBe(306000);
    expect(validVaultResumeExpiration(deadline, deadline)).toBe(false);
    for (const invalid of [
      null,
      undefined,
      -1,
      Infinity,
      NaN,
      "0",
      0.5,
      4000000,
    ]) {
      expect(validVaultResumeExpiration(invalid, 1000)).toBe(false);
    }
  });
});
