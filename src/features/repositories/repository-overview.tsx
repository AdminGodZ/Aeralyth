"use client";

import { formatDistanceToNow } from "date-fns";
import {
  BookMarked,
  ChevronRight,
  FolderGit2,
  LockKeyhole,
  Search,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { UploadPanel } from "@/features/dashboard/upload-panel";
import { NewRepositoryDialog } from "@/features/repositories/new-repository-dialog";
import { useResolvedVaultNames } from "@/features/repositories/use-resolved-vault-names";
import type { RepositoriesState } from "@/lib/api";

export function RepositoryOverview({
  repositoriesState,
  csrfToken,
  e2eeMode,
  ownerUsername,
}: {
  repositoriesState: RepositoriesState;
  csrfToken: string;
  e2eeMode: "off" | "migrate" | "required";
  ownerUsername: string;
}) {
  const [query, setQuery] = useState("");
  const repositories = useMemo(
    () =>
      repositoriesState.status === "ready"
        ? repositoriesState.data.repositories
        : [],
    [repositoriesState],
  );
  const rootNodes = useMemo(
    () => repositories.map((repository) => repository.root),
    [repositories],
  );
  const names = useResolvedVaultNames(rootNodes);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleRepositories = repositories.filter((repository) => {
    if (!normalizedQuery) {
      return true;
    }
    const presentation = names.presentationFor(repository.root);
    if (presentation.status !== "ready") return true;
    return `${repository.ownerUsername}/${presentation.name}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });

  if (repositoriesState.status !== "ready") {
    return (
      <div className="flex flex-1 flex-col px-4 py-5 sm:px-6">
        <section className="rounded-md border p-5">
          <p className="font-medium">Repositories unavailable</p>
          <p className="mt-2 text-sm text-muted-foreground">
            The repositories API is not reachable.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-5 sm:px-6">
      <div className="mx-auto w-full max-w-6xl">
        <section className="rounded-md border">
          <div className="flex flex-col gap-4 border-b px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="font-display text-lg font-semibold">
                Your repositories
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Create an empty repository or import an existing project folder.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <NewRepositoryDialog
                ownerUsername={ownerUsername}
                csrfToken={csrfToken}
                e2eeMode={e2eeMode}
              />
              <UploadPanel
                csrfToken={csrfToken}
                e2eeMode={e2eeMode}
                folderZipPromptEnabled={false}
                surface="repositories"
              />
            </div>
          </div>

          {repositories.length > 0 ? (
            <div className="border-b p-4">
              <div className="relative max-w-md">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder="Find a repository…"
                  aria-label="Find a repository"
                  className="h-9 rounded-md border bg-background pl-9"
                />
              </div>
            </div>
          ) : null}

          {visibleRepositories.length > 0 ? (
            <>
              <ul className="divide-y" aria-label="Repositories">
                {visibleRepositories.map((repository) => {
                  const presentation = names.presentationFor(repository.root);
                  return (
                    <li key={repository.id} className="px-4 py-5 sm:px-6">
                      <div className="flex items-start gap-3">
                        <BookMarked
                          className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            {presentation.status === "pending" ? (
                              <div
                                className="flex min-w-0 items-center gap-1.5 font-display text-base font-semibold"
                                aria-busy="true"
                              >
                                <span>{repository.ownerUsername}/</span>
                                <Skeleton
                                  className="h-4 w-32"
                                  aria-hidden="true"
                                />
                                <span className="sr-only">
                                  Decrypting repository name
                                </span>
                              </div>
                            ) : (
                              <Link
                                href={`/repositories/${encodeURIComponent(repository.id)}`}
                                className="min-w-0 truncate font-display text-base font-semibold text-primary hover:underline"
                              >
                                {`${repository.ownerUsername}/${presentation.name}`}
                              </Link>
                            )}
                            <Badge variant="outline" className="h-5">
                              <LockKeyhole
                                className="size-3"
                                aria-hidden="true"
                              />
                              Private
                            </Badge>
                          </div>
                          {repository.description ? (
                            <p className="mt-2 text-sm text-muted-foreground">
                              {repository.description}
                            </p>
                          ) : null}
                          <p
                            className={
                              repository.description
                                ? "mt-3 text-xs text-muted-foreground"
                                : "mt-2 text-xs text-muted-foreground"
                            }
                          >
                            Updated {formatRepositoryDate(repository.updatedAt)}
                          </p>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {repositoriesState.data.hasMore &&
              repositoriesState.data.nextCursor ? (
                <div className="flex justify-end border-t px-4 py-3">
                  <Button asChild variant="outline">
                    <Link
                      href={`/repositories?${new URLSearchParams({ cursor: repositoriesState.data.nextCursor })}`}
                    >
                      Next page
                      <ChevronRight className="size-4" aria-hidden="true" />
                    </Link>
                  </Button>
                </div>
              ) : null}
            </>
          ) : repositories.length === 0 ? (
            <div className="flex min-h-80 flex-col items-center justify-center px-6 py-12 text-center">
              <span className="flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
                <FolderGit2 className="size-8" aria-hidden="true" />
              </span>
              <h2 className="mt-5 font-display text-xl font-semibold">
                Create your first repository
              </h2>
              <p className="mt-2 max-w-lg text-sm text-muted-foreground">
                Start empty or import a project folder. Imported repositories
                preserve their existing file structure.
              </p>
            </div>
          ) : (
            <div className="flex min-h-56 flex-col items-center justify-center px-6 py-10 text-center">
              <p className="font-medium">No repositories match “{query}”</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Try a repository or owner name.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function formatRepositoryDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return "recently";
  }

  return formatDistanceToNow(date, { addSuffix: true });
}
