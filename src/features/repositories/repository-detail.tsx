"use client";

import { formatDistanceToNow } from "date-fns";
import {
  BookMarked,
  ChevronRight,
  Code2,
  FileCode2,
  FileText,
  Folder,
  GitBranch,
  History,
  LockKeyhole,
} from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { RepositoryCodeMenu } from "@/features/repositories/repository-code-menu";
import { RepositoryDescription } from "@/features/repositories/repository-description";
import { getRepositoryFilePresentation } from "@/features/repositories/repository-file-types";
import { RepositoryFileViewer } from "@/features/repositories/repository-file-viewer";
import { RepositoryLanguageStats } from "@/features/repositories/repository-language-stats";
import { useResolvedVaultNames } from "@/features/repositories/use-resolved-vault-names";
import type {
  RepositoryDetailData,
  RepositoryDetailState,
  RepositoryEntry,
} from "@/lib/api";

export function RepositoryDetail({
  csrfToken,
  repositoryState,
  selectedFileId,
}: {
  csrfToken: string;
  repositoryState: RepositoryDetailState;
  selectedFileId?: string;
}) {
  if (repositoryState.status !== "ready") {
    return (
      <div className="flex flex-1 flex-col px-4 py-5 sm:px-6">
        <section className="rounded-md border p-5">
          <p className="font-medium">Repository unavailable</p>
          <p className="mt-2 text-sm text-muted-foreground">
            This repository could not be loaded.
          </p>
        </section>
      </div>
    );
  }

  return (
    <ReadyRepositoryDetail
      csrfToken={csrfToken}
      data={repositoryState.data}
      selectedFileId={selectedFileId}
    />
  );
}

function ReadyRepositoryDetail({
  csrfToken,
  data,
  selectedFileId,
}: {
  csrfToken: string;
  data: RepositoryDetailData;
  selectedFileId?: string;
}) {
  const nodes = useMemo(
    () => [
      data.repository.root,
      ...data.breadcrumbs.map((breadcrumb) => ({
        ...breadcrumb,
        entryType: "folder" as const,
      })),
      ...data.entries,
    ],
    [data],
  );
  const names = useResolvedVaultNames(nodes);
  const repositoryName = names.nameFor(data.repository.root);
  const resolvedEntries = data.entries.map((entry) => ({
    ...entry,
    resolvedName: names.nameFor(entry),
  }));
  const selectedFile = resolvedEntries.find(
    (entry) => entry.entryType === "file" && entry.id === selectedFileId,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="border-b px-4 pt-5 sm:px-6">
        <div className="mx-auto w-full max-w-7xl">
          <div className="flex flex-wrap items-center gap-2 pb-4">
            <BookMarked
              className="size-5 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="text-lg text-muted-foreground">
              {data.repository.ownerUsername}
            </span>
            <span className="text-lg text-muted-foreground">/</span>
            <Link
              href={`/repositories/${encodeURIComponent(data.repository.id)}`}
              className="min-w-0 truncate font-display text-lg font-semibold text-primary hover:underline"
            >
              {repositoryName}
            </Link>
            <Badge variant="outline">
              <LockKeyhole className="size-3" aria-hidden="true" />
              Private
            </Badge>
          </div>

          <nav aria-label="Repository" className="flex gap-1">
            <Link
              href={`/repositories/${encodeURIComponent(data.repository.id)}`}
              aria-current="page"
              className="relative flex h-11 items-center gap-2 px-3 text-sm font-semibold after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary"
            >
              <Code2 className="size-4" aria-hidden="true" />
              Code
            </Link>
          </nav>
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <main className="min-w-0">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium">
                <GitBranch className="size-4" aria-hidden="true" />
                {data.repository.defaultBranch}
              </span>
              <span className="text-sm text-muted-foreground">
                {formatTreeCount(
                  data.summary.totalFiles,
                  data.summary.totalFolders,
                )}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3 sm:justify-end">
              <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <History className="size-4" aria-hidden="true" />
                Imported {formatRepositoryDate(data.repository.createdAt)}
              </span>
              <RepositoryCodeMenu
                repository={data.repository}
                repositoryName={repositoryName}
              />
            </div>
          </div>

          {selectedFile ? (
            <>
              <div className="mb-3 overflow-hidden rounded-md border">
                <RepositoryPath
                  data={data}
                  repositoryName={repositoryName}
                  nameFor={names.nameFor}
                  selectedFileName={selectedFile.resolvedName}
                />
              </div>
              <RepositoryFileViewer
                key={selectedFile.id}
                entry={selectedFile}
              />
            </>
          ) : (
            <section className="overflow-hidden rounded-md border">
              <RepositoryPath
                data={data}
                repositoryName={repositoryName}
                nameFor={names.nameFor}
              />

              <div className="flex items-center justify-between gap-4 border-b bg-muted/25 px-4 py-3 text-sm">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/12 text-xs font-semibold text-primary">
                    {data.repository.ownerUsername.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="truncate font-medium">
                    {data.repository.ownerUsername}
                  </span>
                  <span className="hidden truncate text-muted-foreground sm:inline">
                    imported this project folder
                  </span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatRepositoryDate(data.repository.updatedAt)}
                </span>
              </div>

              <table
                className="w-full table-fixed"
                aria-label="Folders and files"
              >
                <thead>
                  <tr className="border-b text-left text-xs font-medium text-muted-foreground">
                    <th scope="col" className="px-4 py-2 font-medium">
                      Name
                    </th>
                    <th
                      scope="col"
                      className="hidden w-32 px-4 py-2 text-right font-medium sm:table-cell"
                    >
                      Last change
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {resolvedEntries.length > 0 ? (
                    resolvedEntries.map((entry) => (
                      <RepositoryEntryRow
                        key={entry.id}
                        entry={entry}
                        repositoryId={data.repository.id}
                        currentFolderId={data.currentFolderId}
                      />
                    ))
                  ) : (
                    <tr>
                      <td colSpan={2} className="px-4 py-10 text-center">
                        <p className="font-medium">This folder is empty</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          No files or folders are stored here.
                        </p>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              {data.entriesTruncated ? (
                <p className="border-t px-4 py-3 text-xs text-muted-foreground">
                  Showing the first 500 entries in this folder.
                </p>
              ) : null}
            </section>
          )}
        </main>

        <aside className="space-y-5 lg:border-l lg:pl-6">
          <RepositoryDescription
            repositoryId={data.repository.id}
            initialDescription={data.repository.description}
            csrfToken={csrfToken}
          />
          <section className="border-t pt-4">
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">Visibility</dt>
                <dd className="font-medium">Private</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">Files</dt>
                <dd className="font-medium tabular-nums">
                  {data.summary.totalFiles}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">Folders</dt>
                <dd className="font-medium tabular-nums">
                  {data.summary.totalFolders}
                </dd>
              </div>
            </dl>
          </section>
          <RepositoryLanguageStats
            key={data.repository.id}
            repository={data.repository}
          />
        </aside>
      </div>
    </div>
  );
}

function RepositoryPath({
  data,
  repositoryName,
  nameFor,
  selectedFileName,
}: {
  data: RepositoryDetailData;
  repositoryName: string;
  nameFor(node: {
    id: string;
    name: string;
    e2eeState: "legacy" | "staged" | "encrypted";
    entryType?: "file" | "folder";
  }): string;
  selectedFileName?: string;
}) {
  if (data.breadcrumbs.length === 0 && !selectedFileName) {
    return null;
  }

  return (
    <nav
      aria-label="Repository path"
      className="flex min-h-11 items-center gap-1 overflow-x-auto border-b px-4 text-sm"
    >
      <Link
        href={`/repositories/${encodeURIComponent(data.repository.id)}`}
        className="shrink-0 font-semibold text-primary hover:underline"
      >
        {repositoryName}
      </Link>
      {data.breadcrumbs.map((breadcrumb, index) => {
        const current =
          index === data.breadcrumbs.length - 1 && !selectedFileName;
        const name = nameFor({ ...breadcrumb, entryType: "folder" });
        return (
          <span key={breadcrumb.id} className="flex min-w-0 items-center gap-1">
            <ChevronRight
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            {current ? (
              <span className="max-w-52 truncate font-semibold">{name}</span>
            ) : (
              <Link
                href={{
                  pathname: `/repositories/${data.repository.id}`,
                  query: { folder: breadcrumb.id },
                }}
                className="max-w-52 truncate text-primary hover:underline"
              >
                {name}
              </Link>
            )}
          </span>
        );
      })}
      {selectedFileName ? (
        <span className="flex min-w-0 items-center gap-1" aria-current="page">
          <ChevronRight
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="max-w-80 truncate font-semibold">
            {selectedFileName}
          </span>
        </span>
      ) : null}
    </nav>
  );
}

function RepositoryEntryRow({
  entry,
  repositoryId,
  currentFolderId,
}: {
  entry: RepositoryEntry & { resolvedName: string };
  repositoryId: string;
  currentFolderId: string;
}) {
  const presentation = getRepositoryFilePresentation(
    entry.resolvedName,
    entry.mimeType,
  );
  const icon =
    entry.entryType === "folder" ? (
      <Folder className="size-4 fill-current" aria-hidden="true" />
    ) : presentation.kind === "text" || presentation.kind === "markdown" ? (
      <FileCode2 className="size-4" aria-hidden="true" />
    ) : (
      <FileText className="size-4" aria-hidden="true" />
    );
  const content = (
    <span className="flex min-w-0 items-center gap-3">
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="truncate">{entry.resolvedName}</span>
    </span>
  );

  return (
    <tr className="h-11 text-sm hover:bg-muted/30">
      <td className="min-w-0 px-4 py-2">
        {entry.entryType === "folder" ? (
          <Link
            href={{
              pathname: `/repositories/${repositoryId}`,
              query: { folder: entry.id },
            }}
            className="font-medium text-primary hover:underline"
          >
            {content}
          </Link>
        ) : (
          <Link
            href={{
              pathname: `/repositories/${repositoryId}`,
              query: { file: entry.id, folder: currentFolderId },
            }}
            className="font-medium text-primary hover:underline"
          >
            {content}
          </Link>
        )}
      </td>
      <td className="hidden w-32 px-4 py-2 text-right text-xs text-muted-foreground sm:table-cell">
        {formatRepositoryDate(entry.updatedAt)}
      </td>
    </tr>
  );
}

function formatTreeCount(totalFiles: number, totalFolders: number) {
  const files = totalFiles === 1 ? "1 file" : `${totalFiles} files`;
  const folders = totalFolders === 1 ? "1 folder" : `${totalFolders} folders`;
  return `${files} · ${folders}`;
}

function formatRepositoryDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return "recently";
  }

  return formatDistanceToNow(date, { addSuffix: true });
}
