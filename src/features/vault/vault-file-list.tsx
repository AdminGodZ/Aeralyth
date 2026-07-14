"use client";

import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Download,
  FileArchive,
  FileText,
  Folder,
  ImageIcon,
  ListFilter,
  LockKeyhole,
  RotateCcw,
  Share2,
  Star,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { downloadEncryptedFile } from "@/features/vault/encrypted-download";
import { getVaultDownloadPlan } from "@/features/vault/vault-api";
import { useVault } from "@/features/vault/vault-provider";
import { VaultShareDialog } from "@/features/vault/vault-share-dialog";
import type { FileEntry, FileSort, FileSortDirection } from "@/lib/api";

type ResolvedEntry = FileEntry & {
  resolved: boolean;
};

export function VaultFileList({
  entries,
  sectionKey,
  csrfToken,
  currentUserId,
  initialSort,
  initialDirection,
}: {
  entries: FileEntry[];
  sectionKey: string;
  csrfToken: string;
  currentUserId: string;
  initialSort?: FileSort;
  initialDirection?: FileSortDirection;
}) {
  const vault = useVault();
  const [resolved, setResolved] = useState<Record<string, ResolvedEntry>>({});
  const [sort, setSort] = useState<FileSort>(initialSort ?? "name");
  const [direction, setDirection] = useState<FileSortDirection>(
    initialDirection ?? (initialSort === "name" ? "asc" : "desc"),
  );
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [shareEntry, setShareEntry] = useState<ResolvedEntry | null>(null);

  useEffect(() => {
    if (vault.state !== "unlocked") return;
    let canceled = false;
    void (async () => {
      const next: Record<string, ResolvedEntry> = {};
      for (const entry of entries) {
        if (entry.e2eeState !== "encrypted") {
          next[entry.id] = { ...entry, resolved: true };
          continue;
        }
        try {
          const manifest = await vault.openNode(entry.id);
          next[entry.id] = {
            ...entry,
            name: manifest.name,
            kind:
              manifest.entryType === "folder"
                ? "Folder"
                : fileKind(manifest.name, manifest.mimeType),
            sizeBytes: manifest.plaintextBytes,
            resolved: true,
          };
        } catch {
          next[entry.id] = {
            ...entry,
            name:
              entry.entryType === "folder"
                ? "Encrypted folder"
                : "Encrypted file",
            kind: entry.entryType === "folder" ? "Folder" : "Encrypted",
            resolved: false,
          };
        }
      }
      if (!canceled) setResolved(next);
    })();
    return () => {
      canceled = true;
    };
  }, [entries, vault]);

  const displayed = useMemo(() => {
    const values = entries.map(
      (entry) =>
        resolved[entry.id] ?? {
          ...entry,
          name:
            entry.e2eeState === "encrypted"
              ? entry.entryType === "folder"
                ? "Encrypted folder"
                : "Encrypted file"
              : entry.name,
          kind:
            entry.e2eeState === "encrypted"
              ? entry.entryType === "folder"
                ? "Folder"
                : "Encrypted"
              : entry.kind,
          resolved: entry.e2eeState !== "encrypted",
        },
    );
    return values.sort((left, right) => {
      if (left.entryType !== right.entryType)
        return left.entryType === "folder" ? -1 : 1;
      let comparison = 0;
      if (sort === "name")
        comparison = left.name.localeCompare(right.name, undefined, {
          sensitivity: "base",
        });
      if (sort === "size") comparison = left.sizeBytes - right.sizeBytes;
      if (sort === "updated")
        comparison = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
      if (comparison === 0) comparison = left.id.localeCompare(right.id);
      return direction === "asc" ? comparison : -comparison;
    });
  }, [direction, entries, resolved, sort]);

  function changeSort(field: FileSort): void {
    if (sort === field) {
      setDirection((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSort(field);
      setDirection(field === "name" ? "asc" : "desc");
    }
  }

  async function download(entry: ResolvedEntry): Promise<void> {
    if (!vault.client || entry.e2eeState !== "encrypted") return;
    setDownloadError(null);
    setDownloadId(entry.id);
    try {
      const manifest = await vault.openNode(entry.id);
      const plan = await getVaultDownloadPlan(entry.id);
      await downloadEncryptedFile({ plan, manifest, client: vault.client });
    } catch (failure) {
      setDownloadError(
        failure instanceof Error
          ? failure.message
          : "The encrypted download failed.",
      );
    } finally {
      setDownloadId(null);
    }
  }

  const isTrash = sectionKey === "trash";
  const isShared = sectionKey === "shared";
  const dateLabel = isTrash ? "Deleted" : isShared ? "Shared" : "Updated";

  return (
    <>
      <div className="grid min-h-14 grid-cols-[2rem_minmax(0,1fr)_7rem] gap-3 border-b px-4 py-3 text-sm font-medium text-muted-foreground md:grid-cols-[2rem_minmax(12rem,1fr)_7rem_7rem_9rem_minmax(18rem,22rem)] md:items-center">
        <span />
        <SortButton
          field="name"
          label="Name"
          sort={sort}
          direction={direction}
          onChange={changeSort}
        />
        <span>Kind</span>
        <SortButton
          field="size"
          label="Size"
          sort={sort}
          direction={direction}
          onChange={changeSort}
          className="hidden md:flex"
        />
        <SortButton
          field="updated"
          label={dateLabel}
          sort={sort}
          direction={direction}
          onChange={changeSort}
          className="hidden md:flex"
        />
        <span className="hidden items-center justify-end gap-1.5 md:flex">
          Actions
          <ListFilter className="size-3.5" aria-hidden="true" />
        </span>
      </div>
      {vault.state !== "unlocked" ? (
        <button
          type="button"
          onClick={vault.requestUnlock}
          className="flex items-center justify-center gap-2 border-b px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <LockKeyhole className="size-4" aria-hidden="true" />
          Unlock the vault to reveal encrypted names
        </button>
      ) : null}
      {downloadError ? (
        <p role="alert" className="border-b px-4 py-2 text-sm text-destructive">
          {downloadError}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 divide-y overflow-auto">
        {displayed.map((entry) => (
          <VaultFileRow
            key={entry.id}
            entry={entry}
            sectionKey={sectionKey}
            csrfToken={csrfToken}
            downloading={downloadId === entry.id}
            onDownload={() => void download(entry)}
            onShare={() => setShareEntry(entry)}
          />
        ))}
      </div>
      {shareEntry ? (
        <VaultShareDialog
          open
          onOpenChange={(open) => {
            if (!open) setShareEntry(null);
          }}
          nodeId={shareEntry.id}
          nodeName={shareEntry.name}
          currentUserId={currentUserId}
          csrfToken={csrfToken}
        />
      ) : null}
    </>
  );
}

function SortButton({
  field,
  label,
  sort,
  direction,
  onChange,
  className,
}: {
  field: FileSort;
  label: string;
  sort: FileSort;
  direction: FileSortDirection;
  onChange(field: FileSort): void;
  className?: string;
}) {
  const active = sort === field;
  const Icon = active
    ? direction === "asc"
      ? ArrowUp
      : ArrowDown
    : ChevronsUpDown;
  return (
    <button
      type="button"
      className={`items-center gap-1.5 text-left transition-colors hover:text-foreground ${active ? "text-foreground" : ""} ${className ?? "flex"}`}
      onClick={() => onChange(field)}
    >
      {label}
      <Icon className="size-3.5" aria-hidden="true" />
    </button>
  );
}

function VaultFileRow({
  entry,
  sectionKey,
  csrfToken,
  downloading,
  onDownload,
  onShare,
}: {
  entry: ResolvedEntry;
  sectionKey: string;
  csrfToken: string;
  downloading: boolean;
  onDownload(): void;
  onShare(): void;
}) {
  const isTrash = sectionKey === "trash";
  const isShared = sectionKey === "shared";
  const isFolder = entry.entryType === "folder";
  const Icon = getIcon(entry);
  const rowDate =
    isTrash && entry.trashedAt
      ? entry.trashedAt
      : isShared && entry.sharedAt
        ? entry.sharedAt
        : entry.updatedAt;

  return (
    <div className="grid gap-3 px-4 py-3 text-sm md:min-h-16 md:grid-cols-[2rem_minmax(12rem,1fr)_7rem_7rem_9rem_minmax(18rem,22rem)] md:items-center">
      <span className="hidden md:block" />
      {isFolder && !isTrash ? (
        <Link
          href={{
            pathname: sectionKey === "shared" ? "/shared" : "/files",
            query: { folder: entry.id },
          }}
          className="flex min-w-0 items-center gap-3"
        >
          <Icon className="size-5 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate font-medium">{entry.name}</span>
        </Link>
      ) : (
        <div className="flex min-w-0 items-center gap-3">
          <Icon className="size-5 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate font-medium">{entry.name}</p>
            {isShared && entry.ownerUsername ? (
              <p className="truncate text-xs text-muted-foreground">
                Shared by {entry.ownerUsername}
              </p>
            ) : null}
          </div>
        </div>
      )}
      <span className="text-muted-foreground">{entry.kind}</span>
      <span className="hidden text-muted-foreground md:block">
        {isFolder ? "-" : formatBytes(entry.sizeBytes)}
      </span>
      <span className="hidden text-muted-foreground md:block">
        {formatDate(rowDate)}
      </span>
      <div className="flex flex-wrap items-center justify-start gap-2 md:justify-end">
        {isTrash ? (
          <>
            <ActionForm
              action={`/api/files/${entry.id}/restore`}
              csrfToken={csrfToken}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              Restore
            </ActionForm>
            <ActionForm
              action={`/api/files/${entry.id}/delete`}
              csrfToken={csrfToken}
              destructive
            >
              <Trash2 className="size-4" aria-hidden="true" />
              Delete
            </ActionForm>
          </>
        ) : (
          <>
            {!isFolder ? (
              entry.e2eeState === "encrypted" ? (
                <Button
                  type="button"
                  variant="secondary"
                  className="text-primary hover:text-primary"
                  disabled={downloading || !entry.resolved}
                  onClick={onDownload}
                >
                  <Download className="size-4" aria-hidden="true" />
                  {downloading ? "Decrypting..." : "Download"}
                </Button>
              ) : (
                <Button
                  asChild
                  variant="secondary"
                  className="text-primary hover:text-primary"
                >
                  <a href={`/api/files/${entry.id}/download`}>
                    <Download className="size-4" aria-hidden="true" />
                    Download
                  </a>
                </Button>
              )
            ) : null}
            {!isShared && entry.e2eeState === "encrypted" ? (
              <Button
                type="button"
                variant="secondary"
                onClick={onShare}
                disabled={!entry.resolved}
              >
                <Share2 className="size-4" aria-hidden="true" />
                Share
              </Button>
            ) : null}
            <ActionForm
              action={`/api/files/${entry.id}/favorite`}
              csrfToken={csrfToken}
              amber
            >
              <Star
                className={entry.favorite ? "size-4 fill-current" : "size-4"}
                aria-hidden="true"
              />
              {entry.favorite ? "Unstar" : "Star"}
            </ActionForm>
            {isShared ? (
              <ActionForm
                action={`/api/files/${entry.id}/unshare`}
                csrfToken={csrfToken}
              >
                <X className="size-4" aria-hidden="true" />
                Remove
              </ActionForm>
            ) : (
              <ActionForm
                action={`/api/files/${entry.id}/trash`}
                csrfToken={csrfToken}
                destructive
              >
                <Trash2 className="size-4" aria-hidden="true" />
                Trash
              </ActionForm>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ActionForm({
  action,
  csrfToken,
  children,
  destructive,
  amber,
}: {
  action: string;
  csrfToken: string;
  children: React.ReactNode;
  destructive?: boolean;
  amber?: boolean;
}) {
  return (
    <form action={action} method="post">
      <input type="hidden" name="csrf_token" value={csrfToken} />
      <Button
        type="submit"
        variant="secondary"
        className={
          destructive
            ? "text-destructive hover:text-destructive"
            : amber
              ? "text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
              : undefined
        }
      >
        {children}
      </Button>
    </form>
  );
}

function getIcon(entry: FileEntry) {
  if (entry.entryType === "folder") return Folder;
  if (entry.kind === "Image") return ImageIcon;
  if (entry.kind === "Archive") return FileArchive;
  return FileText;
}

function fileKind(name: string, mimeType: string | null): string {
  if (mimeType?.startsWith("image/")) return "Image";
  if (mimeType?.includes("zip") || /\.(zip|tar|gz|7z)$/iu.test(name))
    return "Archive";
  const extension = name.split(".").pop();
  return extension && extension !== name
    ? extension.toUpperCase().slice(0, 12)
    : "File";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}
