import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearRepositoryLanguageCache,
  forgetVaultDerivedLanguages,
  loadRepositoryLanguages,
  peekRepositoryLanguages,
  type RepositoryLanguageEntry,
  type RepositoryLanguageStats,
  type RepositoryLanguageVault,
} from "@/features/repositories/repository-language-stats-data";
import type {
  VaultManifest,
  VaultMetadataReference,
} from "@/features/vault/protocol";

afterEach(() => {
  clearRepositoryLanguageCache();
  vi.unstubAllGlobals();
});

function encrypted(
  id: string,
  parentId: string,
  entryType: "file" | "folder",
): RepositoryLanguageEntry {
  return {
    id,
    parentId,
    entryType,
    name: null,
    sizeBytes: 999,
    e2eeState: "encrypted",
    vaultGenerationId: `generation-${id}`,
    vaultRecordVersion: 1,
    vaultRecordHash: `hash-${id}`,
  };
}

function stubStats(stats: Omit<RepositoryLanguageStats, "repositoryId">) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ repositoryId: "repo", ...stats }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function manifest(
  name: string,
  entryType: "file" | "folder",
  plaintextBytes: number,
): VaultManifest {
  return {
    name,
    mimeType: null,
    entryType,
    plaintextBytes,
    paddedBytes: plaintextBytes,
    lastModified: 0,
    parentId: null,
    chunkCount: 1,
    generationId: new Uint8Array(),
    createdAt: 0,
  };
}

function unlockedVault(
  names: Map<string, { name: string; bytes: number }>,
  entries: RepositoryLanguageEntry[],
) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const resolveMetadata = vi.fn(async (references: VaultMetadataReference[]) =>
    references.map((reference) => {
      const entry = byId.get(reference.nodeId);
      const plain = names.get(reference.nodeId);
      if (!entry || !plain) throw new Error("unexpected node");
      return {
        status: "ready" as const,
        nodeId: reference.nodeId,
        recordHash: reference.recordHash,
        manifest: manifest(plain.name, entry.entryType, plain.bytes),
      };
    }),
  );
  const openNode = vi.fn(async () => {
    throw new Error("per-node opens are not expected");
  });
  return {
    state: "unlocked",
    resolveMetadata,
    openNode,
  } satisfies RepositoryLanguageVault;
}

const readableStats = {
  contentVersion: 7,
  languageGroups: [
    { kind: "extension" as const, key: "ts", files: 3, bytes: 300 },
    { kind: "extension" as const, key: "rs", files: 1, bytes: 100 },
  ],
  encryptedEntries: [],
};

describe("repository language statistics loading", () => {
  it("uses one aggregate request and caches it per content version", async () => {
    const fetchMock = stubStats(readableStats);
    const vault = unlockedVault(new Map(), []);
    const signal = new AbortController().signal;

    const [first, concurrent] = await Promise.all([
      loadRepositoryLanguages({
        repositoryId: "repo",
        contentVersion: 7,
        vault,
        signal,
      }),
      loadRepositoryLanguages({
        repositoryId: "repo",
        contentVersion: 7,
        vault,
        signal,
      }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/repositories/repo/language-stats",
      { signal: expect.any(AbortSignal), cache: "no-cache" },
    );
    expect(first).toEqual(concurrent);
    expect(first).toMatchObject({
      status: "ready",
      languages: [
        { name: "TypeScript", bytes: 300, percentage: 75 },
        { name: "Rust", bytes: 100, percentage: 25 },
      ],
    });
    expect(peekRepositoryLanguages("repo", 7, "locked")).toEqual(first);
    await loadRepositoryLanguages({
      repositoryId: "repo",
      contentVersion: 7,
      vault,
      signal,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(peekRepositoryLanguages("repo", 8, "locked")).toBeNull();
    expect(vault.resolveMetadata).not.toHaveBeenCalled();
  });

  it("resolves encrypted names in batches instead of per-node opens", async () => {
    const entries: RepositoryLanguageEntry[] = [
      encrypted("src", "root", "folder"),
      encrypted("deps", "root", "folder"),
      encrypted("vendored", "deps", "file"),
    ];
    const names = new Map([
      ["src", { name: "src", bytes: 0 }],
      ["deps", { name: "node_modules", bytes: 0 }],
      ["vendored", { name: "index.ts", bytes: 5_000 }],
    ]);
    for (let index = 0; index < 1_200; index += 1) {
      const id = `file-${index}`;
      entries.push(encrypted(id, "src", "file"));
      names.set(id, {
        name: index % 2 === 0 ? `module-${index}.ts` : `style-${index}.css`,
        bytes: 10,
      });
    }
    entries.push({
      ...encrypted("readable", "src", "file"),
      e2eeState: "legacy",
      name: "notes.py",
      sizeBytes: 4_000,
    });
    const fetchMock = stubStats({
      contentVersion: 3,
      languageGroups: [
        { kind: "extension", key: "ts", files: 1, bytes: 6_000 },
      ],
      encryptedEntries: entries,
    });
    const vault = unlockedVault(names, entries);

    const result = await loadRepositoryLanguages({
      repositoryId: "repo",
      contentVersion: 3,
      vault,
      signal: new AbortController().signal,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vault.openNode).not.toHaveBeenCalled();
    expect(vault.resolveMetadata).toHaveBeenCalledTimes(2);
    const batches = vault.resolveMetadata.mock.calls.map(
      ([references]) => references,
    );
    expect(batches.map((batch) => batch.length)).toEqual([1_000, 203]);
    expect(batches[0][0]).toEqual({
      nodeId: "src",
      parentId: "root",
      recordVersion: 1,
      recordHash: "hash-src",
      generationId: "generation-src",
    });
    // The decrypted node_modules folder is ignored, plaintext sizes win over
    // ciphertext sizes, and readable entries below encrypted folders count.
    expect(result).toMatchObject({
      status: "ready",
      languages: [
        { name: "TypeScript", bytes: 12_000 },
        { name: "CSS", bytes: 6_000 },
        { name: "Python", bytes: 4_000 },
      ],
    });
  });

  it("reports a locked vault without decrypting or caching names", async () => {
    const entries = [encrypted("secret", "root", "file")];
    const fetchMock = stubStats({
      contentVersion: 4,
      languageGroups: readableStats.languageGroups,
      encryptedEntries: entries,
    });
    const vault = {
      ...unlockedVault(
        new Map([["secret", { name: "main.go", bytes: 400 }]]),
        entries,
      ),
      state: "locked",
    };

    await expect(
      loadRepositoryLanguages({
        repositoryId: "repo",
        contentVersion: 4,
        vault,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "locked" });
    expect(vault.resolveMetadata).not.toHaveBeenCalled();
    expect(peekRepositoryLanguages("repo", 4, "unlocked")).toBeNull();

    // Unlocking reuses the fetched aggregate: no second request.
    const unlocked = await loadRepositoryLanguages({
      repositoryId: "repo",
      contentVersion: 4,
      vault: { ...vault, state: "unlocked" },
      signal: new AbortController().signal,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(unlocked).toMatchObject({
      status: "ready",
      languages: [{ name: "Go", bytes: 400 }, { name: "TypeScript" }, {}],
    });
    expect(peekRepositoryLanguages("repo", 4, "locked")).toEqual({
      status: "locked",
    });

    forgetVaultDerivedLanguages();
    expect(peekRepositoryLanguages("repo", 4, "unlocked")).toBeNull();
  });

  it("cancels shared work only after every caller leaves", async () => {
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            fetchSignal = init.signal ?? undefined;
            fetchSignal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    const vault = unlockedVault(new Map(), []);
    const first = new AbortController();
    const second = new AbortController();
    const firstLoad = loadRepositoryLanguages({
      repositoryId: "repo",
      contentVersion: 1,
      vault,
      signal: first.signal,
    });
    const secondLoad = loadRepositoryLanguages({
      repositoryId: "repo",
      contentVersion: 1,
      vault,
      signal: second.signal,
    });

    first.abort();
    await expect(firstLoad).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSignal?.aborted).toBe(false);
    second.abort();
    await expect(secondLoad).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("keeps ZIP code out of the repository page language path", () => {
    for (const file of [
      "repository-language-stats.tsx",
      "repository-language-stats-data.ts",
      "repository-languages.ts",
    ]) {
      const source = readFileSync(resolve(import.meta.dirname, file), "utf8");
      expect(source).not.toMatch(
        /from "@\/features\/repositories\/repository-archive"/u,
      );
      expect(source).not.toMatch(/from "@\/features\/archive\//u);
      expect(source).not.toContain("@zip.js");
    }
  });
});
