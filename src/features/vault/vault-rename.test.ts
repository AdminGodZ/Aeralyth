import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSiblingConflict } from "@/features/vault/rename-dialog";
import { VaultApiError } from "@/features/vault/vault-api";
import { VaultWorkerError } from "@/features/vault/vault-client";

const api = vi.hoisted(() => ({
  getVaultDownloadPlan: vi.fn(),
  publishVaultRecord: vi.fn(),
}));
const sync = vi.hoisted(() => ({ enqueueShareDirectorySync: vi.fn() }));

vi.mock("@/features/vault/vault-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/vault/vault-api")>()),
  ...api,
}));
vi.mock("@/features/vault/share-directory-sync", () => sync);

const { getItemNameError, renameVaultNode } = await import(
  "@/features/vault/vault-rename"
);

function plan(recordHash: string) {
  return {
    nodeId: "fil_node",
    entryType: "file",
    recordVersion: 4,
    recordHash,
    share: null,
  };
}

function published(overrides: Record<string, unknown> = {}) {
  return {
    nodeId: "fil_node",
    generationNumber: 1,
    generationId: "gen",
    recordVersion: 5,
    recordHash: "next",
    shareSyncRequired: false,
    ...overrides,
  };
}

function renamed() {
  return {
    record: { wrappers: [] },
    recordVersion: 5,
    recordHash: "next",
    manifest: { name: "new.png" },
  };
}

describe("getItemNameError", () => {
  it.each([
    ["", "Enter a name."],
    ["   ", "Enter a name."],
    ["..", "This name is reserved."],
    ["a/b", "Names cannot contain / or \\."],
    ["a\\b", "Names cannot contain / or \\."],
    ["tab\there", "Names cannot contain control characters."],
    ["x".repeat(181), "Names can be at most 180 characters."],
  ])("rejects %j", (name, message) => {
    expect(getItemNameError(name)).toBe(message);
  });

  it("accepts ordinary names", () => {
    expect(getItemNameError(" Report (final).pdf ")).toBeNull();
    expect(getItemNameError("x".repeat(180))).toBeNull();
  });
});

describe("getSiblingConflict", () => {
  it("matches names case-insensitively", () => {
    expect(getSiblingConflict("photo.PNG", ["Photo.png"])).toBe(
      "An item named “photo.PNG” is already here.",
    );
    expect(getSiblingConflict("photo.png", ["photo.jpg"])).toBeNull();
  });
});

describe("renameVaultNode", () => {
  const client = { renameNode: vi.fn() };
  const openNode = vi.fn();
  const dependencies = {
    client: client as never,
    csrfToken: "csrf",
    openNode,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    openNode.mockResolvedValue({});
    client.renameNode.mockResolvedValue(renamed());
  });

  it("publishes the renamed record built from the current head", async () => {
    api.getVaultDownloadPlan.mockResolvedValue(plan("head"));
    api.publishVaultRecord.mockResolvedValue(published());

    const result = await renameVaultNode(dependencies, "fil_node", " new.png ");

    expect(client.renameNode).toHaveBeenCalledWith({
      plan: plan("head"),
      name: "new.png",
    });
    expect(api.publishVaultRecord).toHaveBeenCalledWith(
      "csrf",
      "fil_node",
      renamed().record,
      undefined,
    );
    expect(result.published.recordHash).toBe("next");
    expect(sync.enqueueShareDirectorySync).not.toHaveBeenCalled();
  });

  it("queues a share directory sync for shared items", async () => {
    api.getVaultDownloadPlan.mockResolvedValue(plan("head"));
    api.publishVaultRecord.mockResolvedValue(
      published({ shareSyncRequired: true }),
    );

    await renameVaultNode(dependencies, "fil_node", "new.png");

    expect(sync.enqueueShareDirectorySync).toHaveBeenCalledWith({
      csrfToken: "csrf",
      client,
      job: expect.objectContaining({
        nodeId: "fil_node",
        recordVersion: 5,
        recordHash: "next",
        entryType: "file",
      }),
    });
  });

  it("rebuilds once on a head that moved", async () => {
    api.getVaultDownloadPlan
      .mockResolvedValueOnce(plan("stale"))
      .mockResolvedValueOnce(plan("fresh"));
    api.publishVaultRecord
      .mockRejectedValueOnce(
        new VaultApiError("node head changed; fetch the current head", 409),
      )
      .mockResolvedValueOnce(published());

    await renameVaultNode(dependencies, "fil_node", "new.png");

    expect(client.renameNode).toHaveBeenLastCalledWith({
      plan: plan("fresh"),
      name: "new.png",
    });
    expect(api.publishVaultRecord).toHaveBeenCalledTimes(2);
  });

  it("opens a locked parent folder and retries", async () => {
    api.getVaultDownloadPlan.mockResolvedValue(plan("head"));
    api.publishVaultRecord.mockResolvedValue(published());
    client.renameNode
      .mockRejectedValueOnce(
        new VaultWorkerError(
          "Unlock the parent folder first:fol_parent",
          "PARENT_KEY_REQUIRED",
        ),
      )
      .mockResolvedValueOnce(renamed());

    await renameVaultNode(dependencies, "fil_node", "new.png");

    expect(openNode).toHaveBeenCalledWith("fol_parent", undefined, undefined);
    expect(client.renameNode).toHaveBeenCalledTimes(2);
  });

  it("explains conflicts and refuses shared plans", async () => {
    api.getVaultDownloadPlan.mockResolvedValue(plan("head"));
    api.publishVaultRecord.mockRejectedValue(
      new VaultApiError(
        "a share epoch rotation is publishing; regenerate after it completes",
        409,
      ),
    );
    await expect(
      renameVaultNode(dependencies, "fil_node", "new.png"),
    ).rejects.toThrow("Sharing for this item is being updated.");

    api.getVaultDownloadPlan.mockResolvedValue({
      ...plan("head"),
      share: {},
    });
    await expect(
      renameVaultNode(dependencies, "fil_node", "new.png"),
    ).rejects.toThrow("Only the owner can rename this item.");
  });

  it("rejects invalid names before any request", async () => {
    await expect(
      renameVaultNode(dependencies, "fil_node", "a/b"),
    ).rejects.toThrow("Names cannot contain / or \\.");
    expect(api.getVaultDownloadPlan).not.toHaveBeenCalled();
  });
});
