import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sodium from "libsodium-wrappers-sumo";
import { beforeAll, describe, expect, it } from "vitest";

import { incrementalCiphertextLeafHash } from "@/features/vault/incremental-ciphertext-hash";
import {
  ciphertextLeafHash,
  randomBytes,
  VAULT_CRYPTO_CHUNK_BYTES,
  wipe,
} from "@/features/vault/protocol";

describe("incremental ciphertext leaf hashing", () => {
  beforeAll(async () => {
    await sodium.ready;
  });

  it("matches the protocol vector without constructing an aggregate input", async () => {
    const ciphertext = randomBytes(VAULT_CRYPTO_CHUNK_BYTES + 16);
    const snapshot = Uint8Array.from(ciphertext);
    const expected = await ciphertextLeafHash(7, ciphertext);

    const actual = incrementalCiphertextLeafHash(7, ciphertext);

    expect(actual).toEqual(expected);
    expect(ciphertext).toEqual(snapshot);
    wipe(ciphertext, snapshot, expected, actual);
  }, 20_000);

  it("rejects invalid chunk indexes before creating hash state", () => {
    expect(() => incrementalCiphertextLeafHash(-1, new Uint8Array())).toThrow(
      "Invalid ciphertext chunk index.",
    );
  });

  it("keeps full chunks on their transferred buffers in the worker", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "vault.worker.ts"),
      "utf8",
    );
    const encryptChunk = source
      .split("async function encryptChunk(")[1]
      ?.split("async function finalizeEncryption(")[0];
    const decryptChunk = source
      .split("async function decryptChunk(")[1]
      ?.split("async function finalizeDecryption(")[0];

    expect(source).toContain(
      "incrementalCiphertextLeafHash(chunkIndex, ciphertext)",
    );
    expect(encryptChunk).toContain(
      "expectedSourceLength === expectedPaddedLength",
    );
    expect(encryptChunk).toContain("? plaintext");
    expect(decryptChunk).toContain("usefulLength === padded.length");
    expect(decryptChunk).toContain("if (plaintext === padded) padded = null");
  });
});
