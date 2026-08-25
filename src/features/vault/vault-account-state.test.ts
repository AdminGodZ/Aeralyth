import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getVaultAccountState } from "@/features/vault/vault-api";

describe("lazy vault account state", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads the exact current compact snapshot as raw binary only on demand", async () => {
    const ciphertext = Uint8Array.from([1, 2, 3, 4]);
    const fetchMock = vi.fn(
      async () =>
        new Response(ciphertext, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "x-vault-account-state-record-id": "record",
            "x-vault-account-state-version": "7",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getVaultAccountState({
        recordId: "record",
        version: 7,
        ciphertextBytes: ciphertext.length,
      }),
    ).resolves.toEqual(ciphertext);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not put the account-state ciphertext on unlock paths", () => {
    const worker = readFileSync(
      resolve(import.meta.dirname, "vault.worker.ts"),
      "utf8",
    );
    const install = worker
      .split("async function installUnlockedRoot(")[1]
      ?.split("function lockVault(")[0];

    expect(install).not.toContain("encryptedAccountState");
    expect(install).not.toContain('"account-state"');
    expect(worker).toContain("material.accountState.ciphertextBytes");
  });
});
