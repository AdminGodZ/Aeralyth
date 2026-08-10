"use client";

import { LoaderCircle, LockKeyhole } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { requestRepositoryArchiveManifest } from "@/features/repositories/repository-archive";
import {
  calculateRepositoryLanguages,
  type RepositoryLanguage,
  type RepositoryLanguageFile,
} from "@/features/repositories/repository-languages";
import { useVault } from "@/features/vault/vault-provider";
import type { RepositoryEntry, RepositorySummary } from "@/lib/api";

type LanguageState =
  | { status: "loading" }
  | { status: "locked" }
  | { status: "ready"; languages: RepositoryLanguage[] }
  | { status: "error"; message: string };

export function RepositoryLanguageStats({
  repository,
}: {
  repository: RepositorySummary;
}) {
  const vault = useVault();
  const [state, setState] = useState<LanguageState>({ status: "loading" });

  useEffect(() => {
    let canceled = false;
    const controller = new AbortController();

    void loadRepositoryLanguageState({
      repositoryId: repository.id,
      rootFolderId: repository.root.id,
      signal: controller.signal,
      vault,
    })
      .then((nextState) => {
        if (!canceled) setState(nextState);
      })
      .catch((failure: unknown) => {
        if (
          canceled ||
          (failure instanceof DOMException && failure.name === "AbortError")
        ) {
          return;
        }
        setState({
          status: "error",
          message:
            failure instanceof Error
              ? failure.message
              : "Repository languages could not be calculated.",
        });
      });

    return () => {
      canceled = true;
      controller.abort();
    };
  }, [repository.id, repository.root.id, vault]);

  return (
    <section className="border-t pt-4">
      <h2 className="font-display text-base font-semibold">Languages</h2>
      <LanguageStatsContent
        state={
          state.status === "locked" && vault.state === "unlocked"
            ? { status: "loading" }
            : state
        }
        unlocking={vault.state === "unlocking"}
        onUnlock={vault.requestUnlock}
      />
    </section>
  );
}

async function loadRepositoryLanguageState({
  repositoryId,
  rootFolderId,
  signal,
  vault,
}: {
  repositoryId: string;
  rootFolderId: string;
  signal: AbortSignal;
  vault: Pick<ReturnType<typeof useVault>, "openNode" | "state">;
}): Promise<LanguageState> {
  const manifest = await requestRepositoryArchiveManifest(repositoryId, signal);
  const entriesById = new Map<string, RepositoryEntry>();
  const encryptedEntries: RepositoryEntry[] = [];
  const namesById = new Map<string, string>();
  const sizesById = new Map<string, number>();

  for (const entry of manifest.entries) {
    entriesById.set(entry.id, entry);
    if (entry.e2eeState === "encrypted") {
      encryptedEntries.push(entry);
    } else {
      namesById.set(entry.id, entry.name);
      sizesById.set(entry.id, entry.sizeBytes);
    }
  }
  if (encryptedEntries.length > 0 && vault.state !== "unlocked") {
    return { status: "locked" };
  }

  for (const entry of encryptedEntries) {
    // Repository nodes share one worker and parent-key cache. Resolving them
    // in tree order lets child manifests reuse their parent key.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const encryptedManifest = await vault.openNode(entry.id);
    if (encryptedManifest.entryType !== entry.entryType) {
      throw new Error("The encrypted repository metadata is inconsistent.");
    }
    namesById.set(entry.id, encryptedManifest.name);
    sizesById.set(entry.id, encryptedManifest.plaintextBytes);
  }

  const files: RepositoryLanguageFile[] = [];
  for (const entry of manifest.entries) {
    if (entry.entryType !== "file") continue;
    files.push({
      name: namesById.get(entry.id) ?? entry.name,
      path: buildRepositoryPath({
        entry,
        entriesById,
        namesById,
        rootFolderId,
      }),
      sizeBytes: sizesById.get(entry.id) ?? entry.sizeBytes,
    });
  }

  return {
    status: "ready",
    languages: calculateRepositoryLanguages(files),
  };
}

function LanguageStatsContent({
  state,
  unlocking,
  onUnlock,
}: {
  state: LanguageState;
  unlocking: boolean;
  onUnlock(): void;
}) {
  if (state.status === "loading") {
    return (
      <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        Analyzing source files…
      </div>
    );
  }

  if (state.status === "locked") {
    return (
      <div className="mt-3 space-y-3">
        <p className="text-sm leading-5 text-muted-foreground">
          Unlock the vault to analyze encrypted filenames and sizes.
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={unlocking}
          onClick={onUnlock}
        >
          {unlocking ? (
            <LoaderCircle
              className="size-3.5 animate-spin"
              aria-hidden="true"
            />
          ) : (
            <LockKeyhole className="size-3.5" aria-hidden="true" />
          )}
          {unlocking ? "Unlocking…" : "Unlock vault"}
        </Button>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <p className="mt-3 text-sm leading-5 text-destructive" role="alert">
        {state.message}
      </p>
    );
  }

  if (state.languages.length === 0) {
    return (
      <p className="mt-3 text-sm leading-5 text-muted-foreground">
        No recognized source-language files yet.
      </p>
    );
  }

  const summary = state.languages
    .map(
      (language) => `${language.name} ${formatPercentage(language.percentage)}`,
    )
    .join(", ");

  return (
    <div className="mt-3">
      <div
        className="flex h-2 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`Language usage: ${summary}`}
      >
        {state.languages.map((language) => (
          <span
            key={language.name}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{
              backgroundColor: language.color,
              width: `${language.percentage}%`,
            }}
            title={`${language.name} ${formatPercentage(language.percentage)}`}
          />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        {state.languages.map((language) => (
          <li key={language.name} className="flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-full"
              style={{ backgroundColor: language.color }}
              aria-hidden="true"
            />
            <span className="font-medium">{language.name}</span>
            <span className="tabular-nums text-muted-foreground">
              {formatPercentage(language.percentage)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function buildRepositoryPath({
  entry,
  entriesById,
  namesById,
  rootFolderId,
}: {
  entry: RepositoryEntry;
  entriesById: Map<string, RepositoryEntry>;
  namesById: Map<string, string>;
  rootFolderId: string;
}) {
  const segments: string[] = [];
  const visited = new Set<string>();
  let current: RepositoryEntry | undefined = entry;

  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    segments.unshift(namesById.get(current.id) ?? current.name);
    if (current.parentId === rootFolderId) break;
    current = current.parentId ? entriesById.get(current.parentId) : undefined;
  }

  return segments.join("/");
}

function formatPercentage(value: number) {
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${value.toFixed(1)}%`;
}
