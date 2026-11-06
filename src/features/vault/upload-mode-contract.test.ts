import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { VAULT_SINGLE_UPLOAD_MAX_CIPHERTEXT_BYTES } from "@/features/vault/protocol";

describe("encrypted upload mode contract", () => {
  it("pre-encrypts exactly the uploads the server plans as single objects", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../../backend/src/e2ee.rs"),
      "utf8",
    );
    const factors = source
      .match(/pub const UPLOAD_PART_BYTES: u64 = ([\d_ *]+);/u)?.[1]
      ?.split("*")
      .map((factor) => Number(factor.trim().replaceAll("_", "")));

    expect(factors?.every(Number.isSafeInteger)).toBe(true);
    expect(factors?.reduce((product, factor) => product * factor, 1)).toBe(
      VAULT_SINGLE_UPLOAD_MAX_CIPHERTEXT_BYTES,
    );
    // Multipart starts strictly above the part size.
    expect(source).toContain("ciphertext_bytes > UPLOAD_PART_BYTES");
  });
});
