import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { VaultManifest } from "@/features/vault/protocol";
import { VaultFileList } from "@/features/vault/vault-file-list";
import { removeEncryptedSelections } from "@/features/vault/vault-list-selection";
import { VaultMetadataResolver } from "@/features/vault/vault-metadata-resolver";
import type { FileEntry } from "@/lib/api";

const vaultMock = vi.hoisted(() => ({
  state: "unlocked",
  resolver: null as VaultMetadataResolver | null,
}));

vi.mock("@/features/vault/vault-provider", () => ({
  useVault: () => ({
    enabled: true,
    state: vaultMock.state,
    client: null,
    requestUnlock: vi.fn(),
    lock: vi.fn(),
    openNode: vi.fn(() => new Promise(() => undefined)),
    resolveMetadata: vi.fn(() => new Promise(() => undefined)),
    peekMetadata: (references: Parameters<VaultMetadataResolver["peek"]>[0]) =>
      vaultMock.resolver?.peek(references) ?? [],
    prefetchFolderMetadata: vi.fn(async () => undefined),
    rememberFolderMetadata: vi.fn(),
  }),
}));

afterEach(() => {
  vaultMock.state = "unlocked";
  vaultMock.resolver = null;
});

const encryptedFolder: FileEntry = {
  id: "fil_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-",
  name: "ciphertext-placeholder",
  kind: "Folder",
  entryType: "folder",
  parentId: null,
  sizeBytes: 4096,
  state: "active",
  favorite: false,
  ownerUsername: "admin",
  shared: false,
  hasActiveShareLink: false,
  sharedAt: null,
  createdAt: "2026-08-17T12:00:00.000Z",
  updatedAt: "2026-08-17T12:00:00.000Z",
  trashedAt: null,
  e2eeState: "encrypted",
  vaultGenerationId: "AAAAAAAAAAAAAAAAAAAAAA",
  vaultRecordVersion: 1,
  vaultRecordHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

describe("VaultFileList metadata loading", () => {
  it("renders a busy, non-interactive skeleton instead of a fake filename", () => {
    const markup = renderToStaticMarkup(
      <VaultFileList
        entries={[encryptedFolder]}
        sectionKey="files"
        csrfToken="test-csrf"
        currentUserId="usr_test"
        currentFolderId={null}
      />,
    );

    expect(markup).toContain('data-metadata-status="pending"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('data-slot="skeleton"');
    expect(markup).toContain("Decrypting item details");
    expect(markup).not.toContain("Encrypted folder");
    expect(markup).not.toContain("ciphertext-placeholder");
    expect(isDisabled(rowActionsTag(markup))).toBe(true);
  });

  it("renders names already decrypted in memory on the first render", () => {
    vaultMock.resolver = resolverWithCachedFolder("Quarterly reports");

    const markup = renderToStaticMarkup(
      <VaultFileList
        entries={[encryptedFolder]}
        sectionKey="files"
        csrfToken="test-csrf"
        currentUserId="usr_test"
        currentFolderId={null}
      />,
    );

    expect(markup).toContain("Quarterly reports");
    expect(markup).toContain('data-metadata-status="ready"');
    expect(markup).not.toContain('data-slot="skeleton"');
    expect(isDisabled(rowActionsTag(markup))).toBe(false);
  });

  it("keeps the skeleton when only another revision is cached", () => {
    vaultMock.resolver = resolverWithCachedFolder("Quarterly reports");

    const markup = renderToStaticMarkup(
      <VaultFileList
        entries={[
          {
            ...encryptedFolder,
            vaultRecordVersion: 2,
            vaultRecordHash: `B${encryptedFolder.vaultRecordHash?.slice(1)}`,
          },
        ]}
        sectionKey="files"
        csrfToken="test-csrf"
        currentUserId="usr_test"
        currentFolderId={null}
      />,
    );

    expect(markup).toContain('data-metadata-status="pending"');
    expect(markup).not.toContain("Quarterly reports");
  });

  it("waits for server validation before showing cached shared names", () => {
    vaultMock.resolver = resolverWithCachedFolder("Quarterly reports");

    const markup = renderToStaticMarkup(
      <VaultFileList
        entries={[encryptedFolder]}
        sectionKey="shared"
        csrfToken="test-csrf"
        currentUserId="usr_test"
        currentFolderId={null}
      />,
    );

    expect(markup).toContain('data-metadata-status="pending"');
    expect(markup).not.toContain("Quarterly reports");
  });

  it("drops encrypted selections when the vault locks", () => {
    const selectedIds = new Set([encryptedFolder.id, "legacy-file"]);

    expect(
      removeEncryptedSelections(selectedIds, [
        encryptedFolder,
        { id: "legacy-file", e2eeState: "legacy" },
      ]),
    ).toEqual(new Set(["legacy-file"]));
  });

  it("keeps ID-only actions available while the encrypted name is locked", () => {
    vaultMock.state = "locked";

    const markup = renderToStaticMarkup(
      <VaultFileList
        entries={[encryptedFolder]}
        sectionKey="files"
        csrfToken="test-csrf"
        currentUserId="usr_test"
        currentFolderId={null}
      />,
    );

    expect(markup).toContain("Locked folder");
    expect(isDisabled(rowActionsTag(markup))).toBe(false);
  });
});

function resolverWithCachedFolder(name: string): VaultMetadataResolver {
  const manifest: VaultManifest = {
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
  };
  const resolver = new VaultMetadataResolver();
  resolver.remember({
    status: "ready",
    nodeId: encryptedFolder.id,
    recordHash: encryptedFolder.vaultRecordHash ?? "",
    manifest,
  });
  return resolver;
}

function rowActionsTag(markup: string): string {
  return (
    markup.match(/<button[^>]*data-vault-row-actions="true"[^>]*>/u)?.[0] ?? ""
  );
}

function isDisabled(tag: string): boolean {
  return /\sdisabled(?:=""|(?=[\s>]))/u.test(tag);
}
