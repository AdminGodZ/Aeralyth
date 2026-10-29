"use client";

import { FileArchive, FileText, Folder, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { formatHexDump } from "@/features/repositories/repository-file-types";
import { formatBytes } from "@/lib/format";

type ArchiveEntry = {
  compressedSize: number;
  directory: boolean;
  filename: string;
  id: string;
  uncompressedSize: number;
};

type ArchiveState =
  | { status: "loading" }
  | { entries: ArchiveEntry[]; status: "ready"; truncated: boolean }
  | { hex: string; status: "unavailable" };

const MAX_VISIBLE_ARCHIVE_ENTRIES = 2_000;

export function RepositoryArchivePreview({ blob }: { blob: Blob }) {
  const [state, setState] = useState<ArchiveState>({ status: "loading" });

  useEffect(() => {
    let canceled = false;
    void (async () => {
      try {
        const { BlobReader, ZipReader } = await import(
          "@/features/archive/zip"
        );
        const reader = new ZipReader(new BlobReader(blob));
        try {
          const entries = await reader.getEntries();
          if (canceled) return;
          const nameCounts = new Map<string, number>();
          setState({
            entries: entries
              .slice(0, MAX_VISIBLE_ARCHIVE_ENTRIES)
              .map((entry) => {
                const occurrence = (nameCounts.get(entry.filename) ?? 0) + 1;
                nameCounts.set(entry.filename, occurrence);
                return {
                  compressedSize: entry.compressedSize,
                  directory: entry.directory,
                  filename: entry.filename,
                  id: `${entry.filename}:${occurrence}`,
                  uncompressedSize: entry.uncompressedSize,
                };
              }),
            status: "ready",
            truncated: entries.length > MAX_VISIBLE_ARCHIVE_ENTRIES,
          });
        } finally {
          await reader.close();
        }
      } catch {
        const bytes = new Uint8Array(
          await blob.slice(0, 32 * 1024).arrayBuffer(),
        );
        if (!canceled) {
          setState({ hex: formatHexDump(bytes), status: "unavailable" });
        }
      }
    })();
    return () => {
      canceled = true;
    };
  }, [blob]);

  if (state.status === "loading") {
    return (
      <div className="flex min-h-72 items-center justify-center gap-3 text-sm text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin text-primary" />
        Reading archive directory…
      </div>
    );
  }

  if (state.status === "unavailable") {
    return (
      <div>
        <div className="border-b bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          This archive format cannot be expanded in the browser. Its binary
          header is shown below.
        </div>
        <pre className="overflow-auto p-4 font-mono text-xs leading-5">
          {state.hex || "This file is empty."}
        </pre>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 border-b bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
        <FileArchive className="size-4" aria-hidden="true" />
        {state.entries.length} archive entries
        {state.truncated ? " (first 2,000 shown)" : ""}
      </div>
      {state.entries.length === 0 ? (
        <p className="px-5 py-12 text-center text-sm text-muted-foreground">
          This archive is empty.
        </p>
      ) : (
        <ul className="divide-y" aria-label="Archive contents">
          {state.entries.map((entry) => (
            <li
              key={entry.id}
              className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-2 text-sm"
            >
              <span className="flex min-w-0 items-center gap-3">
                {entry.directory ? (
                  <Folder
                    className="size-4 shrink-0 fill-current text-muted-foreground"
                    aria-hidden="true"
                  />
                ) : (
                  <FileText
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <span className="truncate font-mono text-xs">
                  {entry.filename}
                </span>
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {entry.directory
                  ? "Folder"
                  : formatBytes(entry.uncompressedSize)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
