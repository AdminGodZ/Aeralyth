import type { VaultManifest } from "@/features/vault/protocol";
import { enqueueShareDirectorySync } from "@/features/vault/share-directory-sync";
import {
  getVaultDownloadPlan,
  publishVaultRecord,
  VaultApiError,
  type VaultPublishResponse,
} from "@/features/vault/vault-api";
import {
  type VaultCryptoClient,
  VaultWorkerError,
} from "@/features/vault/vault-client";
import type { VaultRenameResult } from "@/features/vault/vault-messages";

// The server keeps legacy names to 180 characters; encrypted names follow suit.
export const MAX_ITEM_NAME_LENGTH = 180;

/** Returns why a name cannot be used, or null when it can. */
export function getItemNameError(name: string): string | null {
  const trimmed = name.normalize("NFC").trim();
  if (!trimmed) return "Enter a name.";
  if (trimmed === "." || trimmed === "..") return "This name is reserved.";
  if (/[/\\]/u.test(trimmed)) return "Names cannot contain / or \\.";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects.
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) {
    return "Names cannot contain control characters.";
  }
  if (Array.from(trimmed).length > MAX_ITEM_NAME_LENGTH) {
    return `Names can be at most ${MAX_ITEM_NAME_LENGTH} characters.`;
  }
  return null;
}

export function normalizeItemName(name: string): string {
  return name.normalize("NFC").trim();
}

type RenameDependencies = {
  client: VaultCryptoClient;
  csrfToken: string;
  openNode(
    nodeId: string,
    plan?: Awaited<ReturnType<typeof getVaultDownloadPlan>>,
    signal?: AbortSignal,
  ): Promise<VaultManifest>;
};

/**
 * Renames an encrypted file or folder by publishing its next record. The
 * content and node key stay untouched; a head that moved since the plan was
 * read is retried once against the fresh head.
 */
export async function renameVaultNode(
  { client, csrfToken, openNode }: RenameDependencies,
  nodeId: string,
  name: string,
  signal?: AbortSignal,
): Promise<{ published: VaultPublishResponse; manifest: VaultManifest }> {
  const nameError = getItemNameError(name);
  if (nameError) throw new Error(nameError);
  const normalized = normalizeItemName(name);

  for (let attempt = 0; ; attempt += 1) {
    const plan = await getVaultDownloadPlan(nodeId, signal);
    if (plan.share) throw new Error("Only the owner can rename this item.");
    // Opening the node also opens any locked ancestors its key is wrapped by.
    await openNode(nodeId, plan, signal);
    signal?.throwIfAborted();
    let renamed: VaultRenameResult;
    try {
      renamed = await client.renameNode({ plan, name: normalized });
    } catch (failure) {
      const parentId = requiredParentId(failure);
      if (!parentId) throw failure;
      await openNode(parentId, undefined, signal);
      renamed = await client.renameNode({ plan, name: normalized });
    }
    signal?.throwIfAborted();
    try {
      const published = await publishVaultRecord(
        csrfToken,
        nodeId,
        renamed.record,
        signal,
      );
      if (published.shareSyncRequired) {
        // Recipients receive the renamed record through the share directory.
        void enqueueShareDirectorySync({
          csrfToken,
          client,
          job: { ...published, entryType: plan.entryType },
        });
      }
      return { published, manifest: renamed.manifest };
    } catch (failure) {
      if (attempt === 0 && isStaleHead(failure)) continue;
      throw renameFailure(failure);
    }
  }
}

function requiredParentId(error: unknown): string | null {
  if (
    !(error instanceof VaultWorkerError) ||
    error.code !== "PARENT_KEY_REQUIRED"
  ) {
    return null;
  }
  const separator = error.message.lastIndexOf(":");
  const parentId = separator >= 0 ? error.message.slice(separator + 1) : "";
  return parentId || null;
}

function isStaleHead(error: unknown): boolean {
  return (
    error instanceof VaultApiError &&
    error.status === 409 &&
    error.message.includes("node head changed")
  );
}

function renameFailure(error: unknown): unknown {
  if (!(error instanceof VaultApiError)) return error;
  if (error.status === 409) {
    return new Error(
      error.message.includes("share epoch rotation")
        ? "Sharing for this item is being updated. Try renaming again in a moment."
        : "This item changed while it was being renamed. Try again.",
    );
  }
  if (error.status === 404) {
    return new Error("This item no longer exists.");
  }
  return error;
}
