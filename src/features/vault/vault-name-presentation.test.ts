import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { getVaultNamePresentation } from "@/features/vault/vault-name-presentation";

const encryptedFolder = {
  name: "ciphertext-placeholder",
  e2eeState: "encrypted" as const,
  entryType: "folder" as const,
};

describe("getVaultNamePresentation", () => {
  it("keeps an unresolved encrypted name in a loading state", () => {
    expect(
      getVaultNamePresentation({
        node: encryptedFolder,
        unlocked: true,
      }),
    ).toEqual({ status: "pending", name: null });
  });

  it("reveals only a successfully decrypted name", () => {
    expect(
      getVaultNamePresentation({
        node: encryptedFolder,
        unlocked: true,
        resolution: { status: "ready", name: "Projects" },
      }),
    ).toEqual({ status: "ready", name: "Projects" });
  });

  it("distinguishes a decryption failure from slow decryption", () => {
    expect(
      getVaultNamePresentation({
        node: encryptedFolder,
        unlocked: true,
        resolution: { status: "unavailable" },
      }),
    ).toEqual({ status: "unavailable", name: "Name unavailable" });
  });

  it("uses an intentional locked label while the vault is locked", () => {
    expect(
      getVaultNamePresentation({
        node: encryptedFolder,
        unlocked: false,
        resolution: { status: "ready", name: "Projects" },
      }),
    ).toEqual({ status: "locked", name: "Locked folder" });
  });

  it("preserves server metadata for content that is not encrypted", () => {
    expect(
      getVaultNamePresentation({
        node: {
          name: "Readme.md",
          e2eeState: "legacy",
          entryType: "file",
        },
        unlocked: false,
      }),
    ).toEqual({ status: "ready", name: "Readme.md" });
  });

  it("keeps fake encrypted filenames out of metadata-loading UI", async () => {
    const sourceUrls = [
      new URL("./vault-file-list.tsx", import.meta.url),
      new URL("./vault-breadcrumbs.tsx", import.meta.url),
      new URL("../repositories/use-resolved-vault-names.ts", import.meta.url),
      new URL("../repositories/repository-overview.tsx", import.meta.url),
      new URL("../repositories/repository-detail.tsx", import.meta.url),
    ];
    const sources = await Promise.all(
      sourceUrls.map((sourceUrl) => readFile(sourceUrl, "utf8")),
    );

    expect(sources.join("\n")).not.toMatch(
      /Encrypted (?:file|folder|repository)/u,
    );
  });
});
