"use client";

import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Download,
  Ellipsis,
  FileArchive,
  FileText,
  Folder,
  ImageIcon,
  Link2,
  ListFilter,
  LockKeyhole,
  RotateCcw,
  Share2,
  Star,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import type { FolderArchiveProgress } from "@/features/files/folder-archive";
import { FolderDownloadProgressPanel } from "@/features/files/folder-download-progress-panel";
import { ShareLinkDialog } from "@/features/sharing/share-link-dialog";
import { downloadEncryptedFile } from "@/features/vault/encrypted-download";
import { getVaultDownloadPlan } from "@/features/vault/vault-api";
import { removeEncryptedSelections } from "@/features/vault/vault-list-selection";
import {
  markVaultFolderClick,
  recordVaultMetadataPerformance,
  vaultPerformanceNow,
} from "@/features/vault/vault-metadata-performance";
import {
  getVaultNamePresentation,
  type VaultNamePresentation,
  type VaultNameResolution,
} from "@/features/vault/vault-name-presentation";
import { useVault, VAULT_LOCKING_EVENT } from "@/features/vault/vault-provider";
import { VaultShareDialog } from "@/features/vault/vault-share-dialog";
import type { FileEntry, FileSort, FileSortDirection } from "@/lib/api";

type ResolvedEntry = FileEntry & {
  resolved: boolean;
  metadataStatus: VaultNamePresentation["status"];
};

type ResolvedMetadata =
  | {
      status: "ready";
      name: string;
      kind: string;
      sizeBytes: number;
      sourceRecordHash: string;
    }
  | { status: "unavailable"; sourceRecordHash: string };

type FavoriteResponse = {
  favorite: boolean;
};

type FolderDownloadSession = {
  folderId: string;
  folderName: string;
  progress: FolderArchiveProgress;
};

const fileDateFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeZone: "UTC",
});

export function VaultFileList({
  entries,
  sectionKey,
  csrfToken,
  currentUserId,
  currentFolderId,
  initialSort,
  initialDirection,
}: {
  entries: FileEntry[];
  sectionKey: string;
  csrfToken: string;
  currentUserId: string;
  currentFolderId: string | null;
  initialSort?: FileSort;
  initialDirection?: FileSortDirection;
}) {
  const vault = useVault();
  const [localEntries, setLocalEntries] = useState(entries);
  const [resolved, setResolved] = useState<Record<string, ResolvedMetadata>>(
    {},
  );
  const [sort, setSort] = useState<FileSort>(initialSort ?? "name");
  const [direction, setDirection] = useState<FileSortDirection>(
    initialDirection ?? (initialSort === "name" ? "asc" : "desc"),
  );
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [folderDownloadSession, setFolderDownloadSession] =
    useState<FolderDownloadSession | null>(null);
  const folderDownloadAbortRef = useRef<AbortController | null>(null);
  const activeDownloadIdRef = useRef<string | null>(null);
  const metadataCommitStartedAtRef = useRef<number | null>(null);
  const vaultStateRef = useRef(vault.state);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const favoritePendingIdsRef = useRef<Set<string> | null>(null);
  if (favoritePendingIdsRef.current === null) {
    favoritePendingIdsRef.current = new Set();
  }
  const favoritePendingIds = favoritePendingIdsRef.current;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [shareEntry, setShareEntry] = useState<ResolvedEntry | null>(null);

  // localEntries is an optimistic overlay; server refreshes replace its base.
  // react-doctor-disable-next-line react-doctor/no-mirror-prop-effect
  useEffect(() => {
    setLocalEntries(entries);
    const availableIds = new Set(entries.map((entry) => entry.id));
    setSelectedIds((current) => {
      const next = new Set(
        [...current].filter((entryId) => availableIds.has(entryId)),
      );
      return next.size === current.size ? current : next;
    });
  }, [entries]);

  useEffect(
    () => () => {
      folderDownloadAbortRef.current?.abort();
      folderDownloadAbortRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const cancelForLock = () => {
      vaultStateRef.current = "locked";
      folderDownloadAbortRef.current?.abort();
      setFolderDownloadSession(null);
    };
    window.addEventListener(VAULT_LOCKING_EVENT, cancelForLock);
    return () => window.removeEventListener(VAULT_LOCKING_EVENT, cancelForLock);
  }, []);

  useEffect(() => {
    vaultStateRef.current = vault.state;
    if (vault.state === "unlocked") return;
    folderDownloadAbortRef.current?.abort();
    setFolderDownloadSession(null);
  }, [vault.state]);

  useEffect(() => {
    const startedAt = metadataCommitStartedAtRef.current;
    if (startedAt === null) return;
    metadataCommitStartedAtRef.current = null;
    recordVaultMetadataPerformance("react_commit", startedAt, {
      readyCount: Object.keys(resolved).length,
    });
  }, [resolved]);

  useEffect(() => {
    if (vault.state !== "unlocked") {
      setResolved((current) =>
        Object.keys(current).length === 0 ? current : {},
      );
      setShareEntry((current) =>
        current?.e2eeState === "encrypted" ? null : current,
      );
      setSelectedIds((current) => removeEncryptedSelections(current, entries));
      return;
    }
    const controller = new AbortController();
    let canceled = false;
    void (async () => {
      const next: Record<string, ResolvedMetadata> = {};
      const references = entries.flatMap((entry) => {
        if (entry.e2eeState !== "encrypted") return [];
        if (
          entry.vaultRecordHash === null ||
          entry.vaultRecordVersion === null ||
          entry.vaultGenerationId === null
        ) {
          next[entry.id] = {
            status: "unavailable",
            sourceRecordHash: entry.vaultRecordHash ?? "missing",
          };
          return [];
        }
        return [
          {
            nodeId: entry.id,
            parentId: entry.parentId,
            recordVersion: entry.vaultRecordVersion,
            recordHash: entry.vaultRecordHash,
            generationId: entry.vaultGenerationId,
          },
        ];
      });
      const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
      const metadataFromResults = (
        results: Awaited<ReturnType<typeof vault.resolveMetadata>>,
      ): Record<string, ResolvedMetadata> =>
        Object.fromEntries(
          results.flatMap((result) => {
            const entry = entriesById.get(result.nodeId);
            if (!entry || result.recordHash !== entry.vaultRecordHash)
              return [];
            const metadata: ResolvedMetadata =
              result.status === "ready"
                ? {
                    status: "ready",
                    name: result.manifest.name,
                    kind:
                      result.manifest.entryType === "folder"
                        ? "Folder"
                        : fileKind(
                            result.manifest.name,
                            result.manifest.mimeType,
                          ),
                    sizeBytes: result.manifest.plaintextBytes,
                    sourceRecordHash: result.recordHash,
                  }
                : {
                    status: "unavailable",
                    sourceRecordHash: result.recordHash,
                  };
            return [[result.nodeId, metadata]];
          }),
        );
      try {
        if (sectionKey === "files" || sectionKey === "shared") {
          vault.rememberFolderMetadata(currentFolderId, sectionKey, references);
        }
        const results = await vault.resolveMetadata(references, {
          signal: controller.signal,
          onCached(cached) {
            if (canceled) return;
            metadataCommitStartedAtRef.current ??= vaultPerformanceNow();
            setResolved((current) => ({
              ...current,
              ...metadataFromResults(cached),
            }));
          },
          onPriority(priority) {
            if (canceled) return;
            metadataCommitStartedAtRef.current ??= vaultPerformanceNow();
            setResolved((current) => ({
              ...current,
              ...metadataFromResults(priority),
            }));
          },
        });
        Object.assign(next, metadataFromResults(results));
      } catch {
        if (controller.signal.aborted) return;
        for (const reference of references) {
          next[reference.nodeId] = {
            status: "unavailable",
            sourceRecordHash: reference.recordHash,
          };
        }
      }
      if (!canceled) {
        metadataCommitStartedAtRef.current ??= vaultPerformanceNow();
        setResolved(next);
      }
    })();
    return () => {
      canceled = true;
      controller.abort();
    };
  }, [
    currentFolderId,
    entries,
    sectionKey,
    vault.rememberFolderMetadata,
    vault.resolveMetadata,
    vault.state,
  ]);

  const displayed = useMemo(() => {
    const values = localEntries.map((entry) => {
      if (entry.e2eeState !== "encrypted") {
        return {
          ...entry,
          resolved: true,
          metadataStatus: "ready" as const,
        };
      }

      const storedMetadata = resolved[entry.id];
      const currentMetadata =
        entry.vaultRecordHash !== null &&
        storedMetadata?.sourceRecordHash === entry.vaultRecordHash
          ? storedMetadata
          : undefined;
      const resolution: VaultNameResolution | undefined =
        currentMetadata?.status === "ready"
          ? { status: "ready", name: currentMetadata.name }
          : currentMetadata?.status === "unavailable"
            ? { status: "unavailable" }
            : undefined;
      const presentation = getVaultNamePresentation({
        node: entry,
        unlocked: vault.state === "unlocked",
        resolution,
      });

      return {
        ...entry,
        name: presentation.name ?? "",
        kind:
          currentMetadata?.status === "ready"
            ? currentMetadata.kind
            : entry.entryType === "folder"
              ? "Folder"
              : presentation.status === "locked"
                ? "Locked"
                : presentation.status === "unavailable"
                  ? "Unavailable"
                  : "",
        sizeBytes:
          currentMetadata?.status === "ready"
            ? currentMetadata.sizeBytes
            : entry.sizeBytes,
        resolved: presentation.status === "ready",
        metadataStatus: presentation.status,
      };
    });
    return values.sort((left, right) => {
      if (left.entryType !== right.entryType)
        return left.entryType === "folder" ? -1 : 1;
      if (
        (sort === "name" || sort === "size") &&
        left.resolved !== right.resolved
      ) {
        return left.resolved ? -1 : 1;
      }
      let comparison = 0;
      if (sort === "name") {
        comparison =
          left.resolved && right.resolved
            ? left.name.localeCompare(right.name, undefined, {
                sensitivity: "base",
              })
            : left.id.localeCompare(right.id);
      }
      if (sort === "size")
        comparison =
          left.resolved && right.resolved
            ? left.sizeBytes - right.sizeBytes
            : left.id.localeCompare(right.id);
      if (sort === "updated")
        comparison = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
      if (comparison === 0) comparison = left.id.localeCompare(right.id);
      return direction === "asc" ? comparison : -comparison;
    });
  }, [direction, localEntries, resolved, sort, vault.state]);

  function changeSort(field: FileSort): void {
    if (sort === field) {
      setDirection((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSort(field);
      setDirection(field === "name" ? "asc" : "desc");
    }
  }

  function setEntrySelected(entryId: string, selected: boolean): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(entryId);
      else next.delete(entryId);
      return next;
    });
  }

  function setAllDisplayedSelected(selected: boolean): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const entry of displayed) {
        if (selected && entry.resolved) next.add(entry.id);
        else next.delete(entry.id);
      }
      return next;
    });
  }

  async function toggleFavorite(entry: ResolvedEntry): Promise<void> {
    if (favoritePendingIds.has(entry.id)) return;

    const nextFavorite = !entry.favorite;
    const originalEntry: FileEntry = entry;
    setFavoriteError(null);
    favoritePendingIds.add(entry.id);
    setLocalEntries((current) =>
      sectionKey === "favorites" && !nextFavorite
        ? current.filter((candidate) => candidate.id !== entry.id)
        : current.map((candidate) =>
            candidate.id === entry.id
              ? { ...candidate, favorite: nextFavorite }
              : candidate,
          ),
    );

    try {
      const favorite = await requestFavorite(entry.id, csrfToken, nextFavorite);
      setLocalEntries((current) =>
        sectionKey === "favorites" && !favorite
          ? current.filter((candidate) => candidate.id !== entry.id)
          : current.map((candidate) =>
              candidate.id === entry.id
                ? { ...candidate, favorite }
                : candidate,
            ),
      );
    } catch (failure) {
      setLocalEntries((current) => {
        if (current.some((candidate) => candidate.id === entry.id)) {
          return current.map((candidate) =>
            candidate.id === entry.id ? originalEntry : candidate,
          );
        }
        return [...current, originalEntry];
      });
      setFavoriteError(
        failure instanceof Error
          ? failure.message
          : "The favorite could not be updated.",
      );
    } finally {
      favoritePendingIds.delete(entry.id);
    }
  }

  async function moveToTrash(targets: ResolvedEntry[]): Promise<void> {
    if (targets.length === 0) return;

    const targetIds = new Set(targets.map((entry) => entry.id));
    setDeleteError(null);
    setLocalEntries((current) =>
      current.filter((entry) => !targetIds.has(entry.id)),
    );
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const entryId of targetIds) next.delete(entryId);
      return next;
    });

    const results = await Promise.allSettled(
      targets.map((entry) => requestTrash(entry.id, csrfToken)),
    );
    const failed = targets.filter(
      (_entry, index) => results[index]?.status === "rejected",
    );
    if (failed.length === 0) return;

    const failedIds = new Set(failed.map((entry) => entry.id));
    setLocalEntries((current) => [
      ...current,
      ...failed.filter(
        (entry) => !current.some((candidate) => candidate.id === entry.id),
      ),
    ]);
    setSelectedIds((current) => new Set([...current, ...failedIds]));
    setDeleteError(
      failed.length === 1
        ? "The item could not be deleted."
        : `${failed.length} items could not be deleted.`,
    );
  }

  async function download(entry: ResolvedEntry): Promise<void> {
    if (entry.entryType === "folder") {
      if (!entry.resolved || !beginDownload(entry.id)) return;
      const controller = new AbortController();
      folderDownloadAbortRef.current = controller;
      setDownloadError(null);
      setFolderDownloadSession({
        folderId: entry.id,
        folderName: entry.name,
        progress: { label: "Reading folder tree…", percentage: null },
      });
      try {
        const { downloadFolderArchive } = await import(
          "@/features/files/folder-archive"
        );
        await downloadFolderArchive({
          folder: {
            id: entry.id,
            name: entry.name,
            entryType: "folder",
            e2eeState: entry.e2eeState,
            updatedAt: entry.updatedAt,
          },
          vault: {
            ...vault,
            isUnlocked: () => vaultStateRef.current === "unlocked",
          },
          signal: controller.signal,
          onProgress: (progress) => {
            if (folderDownloadAbortRef.current !== controller) return;
            setFolderDownloadSession({
              folderId: entry.id,
              folderName: entry.name,
              progress,
            });
          },
        });
      } catch (failure) {
        if (!isAbortError(failure)) {
          setDownloadError(
            failure instanceof Error
              ? failure.message
              : "The folder download failed.",
          );
        }
      } finally {
        if (folderDownloadAbortRef.current === controller) {
          folderDownloadAbortRef.current = null;
          setFolderDownloadSession(null);
        }
        finishDownload(entry.id);
      }
      return;
    }
    if (
      !vault.client ||
      entry.e2eeState !== "encrypted" ||
      !beginDownload(entry.id)
    )
      return;
    const controller = new AbortController();
    folderDownloadAbortRef.current = controller;
    setDownloadError(null);
    try {
      const plan = await getVaultDownloadPlan(entry.id, controller.signal);
      const manifest = await vault.openNode(entry.id, plan, controller.signal);
      await downloadEncryptedFile({
        plan,
        manifest,
        client: vault.client,
        signal: controller.signal,
      });
    } catch (failure) {
      if (!isAbortError(failure)) {
        setDownloadError(
          failure instanceof Error
            ? failure.message
            : "The encrypted download failed.",
        );
      }
    } finally {
      if (folderDownloadAbortRef.current === controller) {
        folderDownloadAbortRef.current = null;
      }
      finishDownload(entry.id);
    }
  }

  function cancelFolderDownload(): void {
    folderDownloadAbortRef.current?.abort();
    setFolderDownloadSession(null);
  }

  function beginDownload(entryId: string): boolean {
    if (activeDownloadIdRef.current) return false;
    activeDownloadIdRef.current = entryId;
    setDownloadId(entryId);
    return true;
  }

  function finishDownload(entryId: string): void {
    if (activeDownloadIdRef.current !== entryId) return;
    activeDownloadIdRef.current = null;
    setDownloadId(null);
  }

  return (
    <>
      <VaultFileListView
        onAllDisplayedSelectedChange={setAllDisplayedSelected}
        sort={sort}
        direction={direction}
        onSortChange={changeSort}
        onShareEntryChange={setShareEntry}
        onMoveToTrash={moveToTrash}
        onClearSelection={() => setSelectedIds(new Set())}
        vault={vault}
        downloadError={downloadError}
        favoriteError={favoriteError}
        deleteError={deleteError}
        displayed={displayed}
        sectionKey={sectionKey}
        csrfToken={csrfToken}
        downloadId={downloadId}
        selectedIds={selectedIds}
        onDownload={download}
        onFavorite={toggleFavorite}
        onEntrySelectedChange={setEntrySelected}
        shareEntry={shareEntry}
        currentUserId={currentUserId}
      />
      {folderDownloadSession ? (
        <div className="pointer-events-none fixed inset-x-4 bottom-4 z-40 flex justify-end sm:right-6 sm:bottom-6 sm:left-auto">
          <div className="pointer-events-auto">
            <FolderDownloadProgressPanel
              folderName={folderDownloadSession.folderName}
              progress={folderDownloadSession.progress}
              onCancel={cancelFolderDownload}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

function VaultFileListView({
  onAllDisplayedSelectedChange,
  sort,
  direction,
  onSortChange,
  onShareEntryChange,
  onMoveToTrash,
  onClearSelection,
  vault,
  downloadError,
  favoriteError,
  deleteError,
  displayed,
  sectionKey,
  csrfToken,
  downloadId,
  selectedIds,
  onDownload,
  onFavorite,
  onEntrySelectedChange,
  shareEntry,
  currentUserId,
}: {
  onAllDisplayedSelectedChange(value: boolean): void;
  sort: FileSort;
  direction: FileSortDirection;
  onSortChange(field: FileSort): void;
  onShareEntryChange(entry: ResolvedEntry | null): void;
  onMoveToTrash(entries: ResolvedEntry[]): Promise<void>;
  onClearSelection(): void;
  vault: ReturnType<typeof useVault>;
  downloadError: string | null;
  favoriteError: string | null;
  deleteError: string | null;
  displayed: ResolvedEntry[];
  sectionKey: string;
  csrfToken: string;
  downloadId: string | null;
  selectedIds: Set<string>;
  onDownload(entry: ResolvedEntry): Promise<void>;
  onFavorite(entry: ResolvedEntry): Promise<void>;
  onEntrySelectedChange(entryId: string, selected: boolean): void;
  shareEntry: ResolvedEntry | null;
  currentUserId: string;
}) {
  const selectedEntries: ResolvedEntry[] = [];
  let selectableCount = 0;
  let pendingCount = 0;
  let unavailableCount = 0;
  for (const entry of displayed) {
    if (entry.resolved) {
      selectableCount += 1;
      if (selectedIds.has(entry.id)) selectedEntries.push(entry);
    }
    if (entry.metadataStatus === "pending") pendingCount += 1;
    if (entry.metadataStatus === "unavailable") unavailableCount += 1;
  }
  const selectedCount = selectedEntries.length;
  const singleSelectedEntry =
    selectedEntries.length === 1 ? selectedEntries[0] : null;
  const allDisplayedSelected =
    selectableCount > 0 && selectedCount === selectableCount;
  const selectAllState = allDisplayedSelected
    ? true
    : selectedCount > 0
      ? "indeterminate"
      : false;
  const isTrash = sectionKey === "trash";
  const isShared = sectionKey === "shared";
  const dateLabel = isTrash ? "Deleted" : isShared ? "Shared" : "Updated";

  return (
    <>
      <div className="grid min-h-14 grid-cols-[2rem_minmax(0,1fr)_7rem] gap-3 border-b px-4 py-3 text-sm font-medium text-muted-foreground md:grid-cols-[2rem_minmax(12rem,1fr)_7rem_7rem_9rem_6rem] md:items-center">
        <span className="flex items-center justify-center">
          <Checkbox
            checked={selectAllState}
            disabled={selectableCount === 0}
            onCheckedChange={(checked) =>
              onAllDisplayedSelectedChange(checked === true)
            }
            aria-label={
              allDisplayedSelected
                ? "Deselect all files and folders"
                : "Select all files and folders"
            }
          />
        </span>
        <SortButton
          field="name"
          label="Name"
          sort={sort}
          direction={direction}
          onChange={onSortChange}
        />
        <span>Kind</span>
        <SortButton
          field="size"
          label="Size"
          sort={sort}
          direction={direction}
          onChange={onSortChange}
          className="hidden md:flex"
        />
        <SortButton
          field="updated"
          label={dateLabel}
          sort={sort}
          direction={direction}
          onChange={onSortChange}
          className="hidden md:flex"
        />
        <span className="hidden items-center justify-end gap-1.5 md:flex">
          Actions
          <ListFilter className="size-3.5" aria-hidden="true" />
        </span>
      </div>
      {selectedCount > 0 ? (
        <div className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b bg-muted/20 px-4 py-2 text-sm">
          <span className="font-medium">
            {selectedCount} {selectedCount === 1 ? "item" : "items"} selected
          </span>
          <div className="flex items-center gap-2">
            {!isTrash && !isShared && singleSelectedEntry ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={
                  singleSelectedEntry.e2eeState === "encrypted" &&
                  !singleSelectedEntry.resolved
                }
                onClick={() => onShareEntryChange(singleSelectedEntry)}
              >
                {hasManagedSharing(singleSelectedEntry) ? (
                  <Link2 className="size-4" aria-hidden="true" />
                ) : (
                  <Share2 className="size-4" aria-hidden="true" />
                )}
                {sharingActionLabel(singleSelectedEntry)}
              </Button>
            ) : null}
            {!isTrash && !isShared ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => void onMoveToTrash(selectedEntries)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                Delete
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClearSelection}
            >
              <X className="size-4" aria-hidden="true" />
              Clear
            </Button>
          </div>
        </div>
      ) : null}
      {vault.enabled && vault.state !== "unlocked" ? (
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
      {favoriteError ? (
        <p role="alert" className="border-b px-4 py-2 text-sm text-destructive">
          {favoriteError}
        </p>
      ) : null}
      {deleteError ? (
        <p role="alert" className="border-b px-4 py-2 text-sm text-destructive">
          {deleteError}
        </p>
      ) : null}
      {pendingCount > 0 ? (
        <p role="status" className="sr-only">
          Decrypting details for {pendingCount}{" "}
          {pendingCount === 1 ? "item" : "items"}.
        </p>
      ) : null}
      {unavailableCount > 0 ? (
        <p role="alert" className="border-b px-4 py-2 text-sm text-destructive">
          {unavailableCount === 1
            ? "One encrypted item could not be revealed."
            : `${unavailableCount} encrypted items could not be revealed.`}{" "}
          Reload and unlock the vault to try again.
        </p>
      ) : null}
      <div className="min-h-0 flex-1 divide-y overflow-auto">
        {displayed.map((entry) => (
          <VaultFileRow
            key={entry.id}
            entry={entry}
            sectionKey={sectionKey}
            csrfToken={csrfToken}
            downloadBusy={downloadId !== null}
            downloading={downloadId === entry.id}
            selected={entry.resolved && selectedIds.has(entry.id)}
            onDownload={() => void onDownload(entry)}
            onDelete={() => void onMoveToTrash([entry])}
            onFavorite={() => void onFavorite(entry)}
            onPrefetchFolder={() =>
              void vault.prefetchFolderMetadata(
                entry.id,
                sectionKey === "shared" ? "shared" : "files",
              )
            }
            onSelectedChange={(selected) =>
              onEntrySelectedChange(entry.id, selected)
            }
            onShare={() => onShareEntryChange(entry)}
          />
        ))}
      </div>
      {shareEntry?.e2eeState === "encrypted" ? (
        vault.state === "unlocked" ? (
          <VaultShareDialog
            open
            onOpenChange={(open) => {
              if (!open) onShareEntryChange(null);
            }}
            nodeId={shareEntry.id}
            nodeName={shareEntry.name}
            currentUserId={currentUserId}
            csrfToken={csrfToken}
          />
        ) : null
      ) : shareEntry ? (
        <ShareLinkDialog
          open
          onOpenChange={(open) => {
            if (!open) onShareEntryChange(null);
          }}
          itemId={shareEntry.id}
          itemName={shareEntry.name}
          itemType={shareEntry.entryType}
          initiallyShared={shareEntry.hasActiveShareLink}
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
  downloadBusy,
  downloading,
  selected,
  onDownload,
  onDelete,
  onFavorite,
  onPrefetchFolder,
  onSelectedChange,
  onShare,
}: {
  entry: ResolvedEntry;
  sectionKey: string;
  csrfToken: string;
  downloadBusy: boolean;
  downloading: boolean;
  selected: boolean;
  onDownload(): void;
  onDelete(): void;
  onFavorite(): void;
  onPrefetchFolder(): void;
  onSelectedChange(selected: boolean): void;
  onShare(): void;
}) {
  const isTrash = sectionKey === "trash";
  const isShared = sectionKey === "shared";
  const isFolder = entry.entryType === "folder";
  const pending = entry.metadataStatus === "pending";
  const Icon = getIcon(entry);
  const rowDate =
    isTrash && entry.trashedAt
      ? entry.trashedAt
      : isShared && entry.sharedAt
        ? entry.sharedAt
        : entry.updatedAt;

  return (
    <div
      data-selected={selected || undefined}
      data-metadata-status={entry.metadataStatus}
      aria-busy={pending || undefined}
      className="grid gap-3 px-4 py-3 text-sm transition-colors data-[selected=true]:bg-primary/5 md:min-h-16 md:grid-cols-[2rem_minmax(12rem,1fr)_7rem_7rem_9rem_6rem] md:items-center"
    >
      <span className="flex items-center justify-center">
        <Checkbox
          checked={selected}
          disabled={!entry.resolved}
          onCheckedChange={(checked) => onSelectedChange(checked === true)}
          aria-label={
            entry.resolved
              ? `${selected ? "Deselect" : "Select"} ${entry.name}`
              : "Item selection unavailable until its name is revealed"
          }
        />
      </span>
      {isFolder && !isTrash && entry.resolved ? (
        <Link
          href={{
            pathname: sectionKey === "shared" ? "/shared" : "/files",
            query: { folder: entry.id },
          }}
          className="flex min-w-0 items-center gap-3"
          onPointerEnter={onPrefetchFolder}
          onPointerDown={onPrefetchFolder}
          onFocus={onPrefetchFolder}
          onClick={markVaultFolderClick}
        >
          <Icon className="size-5 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate font-medium">{entry.name}</span>
        </Link>
      ) : (
        <div className="flex min-w-0 items-center gap-3">
          <Icon className="size-5 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            {pending ? (
              <>
                <Skeleton className="h-4 w-40 max-w-full" aria-hidden="true" />
                <span className="sr-only">Decrypting item details</span>
              </>
            ) : (
              <p className="truncate font-medium">{entry.name}</p>
            )}
            {!isFolder && isShared && entry.ownerUsername ? (
              <p className="truncate text-xs text-muted-foreground">
                Shared by {entry.ownerUsername}
              </p>
            ) : null}
          </div>
        </div>
      )}
      <div className="text-muted-foreground">
        {pending ? (
          <Skeleton className="h-4 w-14" aria-hidden="true" />
        ) : (
          entry.kind
        )}
      </div>
      <div className="hidden text-muted-foreground md:block">
        {isFolder ? (
          "-"
        ) : pending ? (
          <Skeleton className="h-4 w-12" aria-hidden="true" />
        ) : entry.resolved ? (
          formatBytes(entry.sizeBytes)
        ) : (
          "-"
        )}
      </div>
      <span className="hidden text-muted-foreground md:block">
        {formatDate(rowDate)}
      </span>
      <div className="flex items-center justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="secondary"
              size="icon"
              data-vault-row-actions="true"
              disabled={pending}
              aria-label={
                pending
                  ? "Actions unavailable until item details are revealed"
                  : `Actions for ${entry.name}`
              }
              title={
                pending
                  ? "Actions unavailable until item details are revealed"
                  : `Actions for ${entry.name}`
              }
            >
              <Ellipsis className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {isTrash ? (
              <>
                <ActionMenuForm
                  action={`/api/files/${entry.id}/restore`}
                  csrfToken={csrfToken}
                >
                  <RotateCcw className="size-4" aria-hidden="true" />
                  Restore
                </ActionMenuForm>
                <DropdownMenuSeparator />
                <ActionMenuForm
                  action={`/api/files/${entry.id}/delete`}
                  csrfToken={csrfToken}
                  destructive
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Delete
                </ActionMenuForm>
              </>
            ) : (
              <>
                {isFolder ? (
                  <DropdownMenuItem
                    disabled={downloadBusy || !entry.resolved}
                    onSelect={onDownload}
                  >
                    <Download className="size-4" aria-hidden="true" />
                    {downloading ? "Preparing ZIP…" : "Download ZIP"}
                  </DropdownMenuItem>
                ) : entry.e2eeState === "encrypted" ? (
                  <DropdownMenuItem
                    disabled={downloadBusy || !entry.resolved}
                    onSelect={onDownload}
                  >
                    <Download className="size-4" aria-hidden="true" />
                    {downloading ? "Decrypting..." : "Download"}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem asChild disabled={downloadBusy}>
                    <a
                      href={
                        downloadBusy
                          ? undefined
                          : `/api/files/${entry.id}/download`
                      }
                      aria-disabled={downloadBusy || undefined}
                    >
                      <Download className="size-4" aria-hidden="true" />
                      Download
                    </a>
                  </DropdownMenuItem>
                )}
                {!isShared ? (
                  <>
                    <DropdownMenuItem
                      disabled={
                        entry.e2eeState === "encrypted" && !entry.resolved
                      }
                      onSelect={onShare}
                    >
                      {hasManagedSharing(entry) ? (
                        <Link2 className="size-4" aria-hidden="true" />
                      ) : (
                        <Share2 className="size-4" aria-hidden="true" />
                      )}
                      {sharingActionLabel(entry)}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={onFavorite}>
                      <Star
                        className={
                          entry.favorite ? "size-4 fill-current" : "size-4"
                        }
                        aria-hidden="true"
                      />
                      {entry.favorite ? "Unstar" : "Star"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                      <Trash2 className="size-4" aria-hidden="true" />
                      Delete
                    </DropdownMenuItem>
                  </>
                ) : (
                  <>
                    <DropdownMenuSeparator />
                    <ActionMenuForm
                      action={`/api/files/${entry.id}/unshare`}
                      csrfToken={csrfToken}
                    >
                      <X className="size-4" aria-hidden="true" />
                      Remove
                    </ActionMenuForm>
                  </>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === "AbortError";
}

function ActionMenuForm({
  action,
  csrfToken,
  children,
  destructive,
}: {
  action: string;
  csrfToken: string;
  children: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <form action={action} method="post" className="contents">
      <input type="hidden" name="csrf_token" value={csrfToken} />
      <DropdownMenuItem
        asChild
        variant={destructive ? "destructive" : "default"}
      >
        <button type="submit" className="w-full">
          {children}
        </button>
      </DropdownMenuItem>
    </form>
  );
}

function getIcon(entry: FileEntry) {
  if (entry.entryType === "folder") return Folder;
  if (entry.kind === "Image") return ImageIcon;
  if (entry.kind === "Archive") return FileArchive;
  return FileText;
}

function hasManagedSharing(entry: FileEntry): boolean {
  return entry.e2eeState === "encrypted"
    ? entry.shared
    : entry.hasActiveShareLink;
}

function sharingActionLabel(entry: FileEntry): string {
  if (!hasManagedSharing(entry)) return "Share";
  return entry.e2eeState === "encrypted" ? "Manage sharing" : "Manage link";
}

async function requestFavorite(
  entryId: string,
  csrfToken: string,
  expectedFavorite: boolean,
): Promise<boolean> {
  const body = new URLSearchParams({ csrf_token: csrfToken });
  const response = await fetch(
    `/api/files/${encodeURIComponent(entryId)}/favorite`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
  );

  if (!response.ok) {
    throw new Error("The favorite could not be updated.");
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const responsePath = new URL(response.url).pathname;
    if (response.redirected && responsePath === "/files") {
      return expectedFavorite;
    }
    throw new Error("The favorite endpoint returned an invalid response.");
  }

  const payload = (await response.json()) as Partial<FavoriteResponse>;
  if (typeof payload.favorite !== "boolean") {
    throw new Error("The favorite response was invalid.");
  }

  return payload.favorite;
}

async function requestTrash(entryId: string, csrfToken: string): Promise<void> {
  const response = await fetch(
    `/api/files/${encodeURIComponent(entryId)}/trash`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf_token: csrfToken }),
    },
  );

  if (!response.ok) {
    throw new Error("The item could not be deleted.");
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return;

  if (response.redirected) {
    const responseUrl = new URL(response.url);
    if (
      responseUrl.pathname === "/files" &&
      responseUrl.searchParams.get("file") === "trashed"
    ) {
      return;
    }
  }

  throw new Error("The delete endpoint returned an invalid response.");
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
  return Number.isNaN(date.getTime()) ? value : fileDateFormatter.format(date);
}
