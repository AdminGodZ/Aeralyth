import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VaultFileList } from "@/features/vault/vault-file-list";
import { removeEncryptedSelections } from "@/features/vault/vault-list-selection";
import type { FileEntry } from "@/lib/api";

const vaultMock = vi.hoisted(() => ({ state: "unlocked" }));

vi.mock("@/features/vault/vault-provider", () => ({
  useVault: () => ({
    enabled: true,
    state: vaultMock.state,
    client: null,
    requestUnlock: vi.fn(),
    lock: vi.fn(),
    openNode: vi.fn(() => new Promise(() => undefined)),
    resolveMetadata: vi.fn(() => new Promise(() => undefined)),
    prefetchFolderMetadata: vi.fn(async () => undefined),
    rememberFolderMetadata: vi.fn(),
  }),
}));

afterEach(() => {
  vaultMock.state = "unlocked";
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

function rowActionsTag(markup: string): string {
  return (
    markup.match(/<button[^>]*data-vault-row-actions="true"[^>]*>/u)?.[0] ?? ""
  );
}

function isDisabled(tag: string): boolean {
  return /\sdisabled(?:=""|(?=[\s>]))/u.test(tag);
}
