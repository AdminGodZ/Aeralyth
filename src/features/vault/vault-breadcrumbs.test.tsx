import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VaultBreadcrumbs } from "@/features/vault/vault-breadcrumbs";
import { VaultMetadataResolver } from "@/features/vault/vault-metadata-resolver";
import type { FolderBreadcrumb } from "@/lib/api";

const vaultMock = vi.hoisted(() => ({
  resolver: null as VaultMetadataResolver | null,
}));

vi.mock("@/features/vault/vault-provider", () => ({
  useVault: () => ({
    state: "unlocked",
    resolveMetadata: vi.fn(() => new Promise(() => undefined)),
    peekMetadata: (references: Parameters<VaultMetadataResolver["peek"]>[0]) =>
      vaultMock.resolver?.peek(references) ?? [],
  }),
}));

afterEach(() => {
  vaultMock.resolver = null;
});

const encryptedFolder: FolderBreadcrumb = {
  id: "fil_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-",
  name: "ciphertext-placeholder",
  e2eeState: "encrypted",
  vaultGenerationId: "AAAAAAAAAAAAAAAAAAAAAA",
  vaultRecordVersion: 1,
  vaultRecordHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

describe("VaultBreadcrumbs metadata loading", () => {
  it("renders a skeleton while the folder name is not cached", () => {
    vaultMock.resolver = new VaultMetadataResolver();

    const markup = renderToStaticMarkup(
      <VaultBreadcrumbs breadcrumbs={[encryptedFolder]} />,
    );

    expect(markup).toContain('data-slot="skeleton"');
    expect(markup).toContain("Decrypting folder name");
  });

  it("renders a folder name already decrypted in memory on the first render", () => {
    vaultMock.resolver = resolverWithCachedFolder("Quarterly reports");

    const markup = renderToStaticMarkup(
      <VaultBreadcrumbs breadcrumbs={[encryptedFolder]} />,
    );

    expect(markup).toContain("Quarterly reports");
    expect(markup).not.toContain('data-slot="skeleton"');
  });

  it("waits for server validation before showing a cached shared name", () => {
    vaultMock.resolver = resolverWithCachedFolder("Quarterly reports");

    const markup = renderToStaticMarkup(
      <VaultBreadcrumbs breadcrumbs={[encryptedFolder]} basePath="/shared" />,
    );

    expect(markup).toContain('data-slot="skeleton"');
    expect(markup).not.toContain("Quarterly reports");
  });
});

function resolverWithCachedFolder(name: string): VaultMetadataResolver {
  const resolver = new VaultMetadataResolver();
  resolver.remember({
    status: "ready",
    nodeId: encryptedFolder.id,
    recordHash: encryptedFolder.vaultRecordHash ?? "",
    manifest: {
      name,
      mimeType: null,
      entryType: "folder",
      plaintextBytes: 0,
      paddedBytes: 0,
      lastModified: 1,
      parentId: null,
      chunkCount: 0,
      generationId: new Uint8Array(16),
      createdAt: 1,
    },
  });
  return resolver;
}
