"use client";

import {
  AlertTriangle,
  Check,
  Clipboard,
  Download,
  ExternalLink,
  FileArchive,
  FileCode2,
  FileImage,
  FileText,
  FileType2,
  LoaderCircle,
  LockKeyhole,
  type LucideIcon,
  Music2,
  RefreshCw,
  Video,
  WrapText,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type ReadyRepositoryFile,
  RepositoryFileContent,
} from "@/features/repositories/repository-file-content";
import {
  loadRepositoryFile,
  MAX_REPOSITORY_PREVIEW_BYTES,
  MAX_REPOSITORY_TEXT_BYTES,
  prepareRepositoryFile,
  RepositoryPreviewTooLargeError,
} from "@/features/repositories/repository-file-loader";
import type { RepositoryFilePresentation } from "@/features/repositories/repository-file-types";
import { downloadEncryptedFile } from "@/features/vault/encrypted-download";
import { getVaultDownloadPlan } from "@/features/vault/vault-api";
import { useVault, VAULT_LOCKING_EVENT } from "@/features/vault/vault-provider";
import { isAbortError } from "@/lib/abort";
import type { RepositoryEntry } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

const FILE_LOADING_WIDTHS = [38, 61, 84, 49, 72, 95, 55, 78, 43, 66];

type ViewerState =
  | { progress: number | null; status: "loading" }
  | { file: ReadyRepositoryFile; status: "ready" }
  | { message: string; status: "error"; tooLarge: boolean };

type RepositoryFileViewerProps = {
  entry: RepositoryEntry & { resolvedName: string };
};

export function RepositoryFileViewer({ entry }: RepositoryFileViewerProps) {
  const [attempt, setAttempt] = useState(0);
  return (
    <RepositoryFileViewerRequest
      key={`${entry.id}:${attempt}`}
      entry={entry}
      onRetry={() => setAttempt((current) => current + 1)}
    />
  );
}

function RepositoryFileViewerRequest({
  entry,
  onRetry,
}: RepositoryFileViewerProps & { onRetry(): void }) {
  const vault = useVault();
  const [state, setState] = useState<ViewerState>({
    progress: null,
    status: "loading",
  });
  const encryptedLocked =
    entry.e2eeState === "encrypted" && vault.state !== "unlocked";
  const requestName =
    entry.e2eeState === "encrypted" ? entry.name : entry.resolvedName;

  useEffect(() => {
    if (encryptedLocked) {
      vault.requestUnlock();
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    let rawObjectUrl: string | null = null;
    let canceled = false;
    void loadRepositoryFile({
      entry,
      resolvedName: requestName,
      vault,
      signal: controller.signal,
      onProgress(percentage) {
        if (!canceled) setState({ progress: percentage, status: "loading" });
      },
    })
      .then(async (loaded) => {
        const prepared = await prepareRepositoryFile(loaded);
        if (canceled) return;
        objectUrl = URL.createObjectURL(loaded.blob);
        rawObjectUrl = shouldForceSafeRawText(prepared)
          ? // This distinct inert URL is tracked and revoked in the effect cleanup.
            // react-doctor-disable-next-line react-doctor/no-create-object-url-without-revoke
            URL.createObjectURL(
              new Blob([loaded.blob], { type: "text/plain;charset=utf-8" }),
            )
          : objectUrl;
        setState({
          file: { ...prepared, objectUrl, rawObjectUrl },
          status: "ready",
        });
      })
      .catch((failure: unknown) => {
        if (canceled || isAbortError(failure)) return;
        setState({
          message:
            failure instanceof Error
              ? failure.message
              : "This repository file could not be loaded.",
          status: "error",
          tooLarge: failure instanceof RepositoryPreviewTooLargeError,
        });
      });
    return () => {
      canceled = true;
      controller.abort();
      if (rawObjectUrl && rawObjectUrl !== objectUrl) {
        URL.revokeObjectURL(rawObjectUrl);
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [encryptedLocked, entry, requestName, vault]);

  if (encryptedLocked) {
    return <RepositoryFileLocked onUnlock={vault.requestUnlock} />;
  }
  if (state.status === "loading") {
    return (
      <RepositoryFileLoading
        name={entry.resolvedName}
        progress={state.progress}
      />
    );
  }
  if (state.status === "error") {
    return (
      <RepositoryFileError
        entry={entry}
        message={state.message}
        tooLarge={state.tooLarge}
        onRetry={onRetry}
      />
    );
  }
  return <ReadyRepositoryFileViewer file={state.file} entry={entry} />;
}

function ReadyRepositoryFileViewer({
  file,
  entry,
}: RepositoryFileViewerProps & { file: ReadyRepositoryFile }) {
  const [wrap, setWrap] = useState(false);
  const [markdownMode, setMarkdownMode] = useState<"preview" | "source">(
    "preview",
  );
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markdown = file.presentation.kind === "markdown";
  const sourceVisible = !markdown || markdownMode === "source";
  const partial = file.blob.size < file.sizeBytes;

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  async function copyVisibleText() {
    if (!file.text) return;
    await navigator.clipboard.writeText(file.text);
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 2_000);
  }

  return (
    <section className="overflow-hidden rounded-md border">
      <header className="flex flex-col gap-3 border-b px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <FilePresentationIcon presentation={file.presentation} />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{file.name}</h1>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span>{file.presentation.label}</span>
              <span aria-hidden="true">·</span>
              <span>{formatBytes(file.sizeBytes)}</span>
              {file.encoding ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{file.encoding}</span>
                </>
              ) : null}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {markdown ? (
            <MarkdownViewToggle
              mode={markdownMode}
              onModeChange={setMarkdownMode}
            />
          ) : null}
          {sourceVisible && file.text !== null ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setWrap((current) => !current)}
              aria-pressed={wrap}
            >
              <WrapText className="size-4" aria-hidden="true" />
              {wrap ? "Unwrap" : "Wrap"}
            </Button>
          ) : null}
          {file.text !== null ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void copyVisibleText()}
            >
              {copied ? (
                <Check className="size-4 text-emerald-500" aria-hidden="true" />
              ) : (
                <Clipboard className="size-4" aria-hidden="true" />
              )}
              {copied ? "Copied" : file.textTruncated ? "Copy preview" : "Copy"}
            </Button>
          ) : null}
          <Button asChild size="sm" variant="outline">
            <a
              href={file.rawObjectUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              {partial ? "Raw preview" : "Raw"}
            </a>
          </Button>
          {partial ? (
            <RepositoryOriginalDownload entry={entry} />
          ) : (
            <Button asChild size="sm">
              <a href={file.objectUrl} download={file.name}>
                <Download className="size-4" aria-hidden="true" />
                Download
              </a>
            </Button>
          )}
        </div>
      </header>

      {file.textTruncated || partial ? (
        <p className="border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
          This preview shows up to {formatBytes(MAX_REPOSITORY_TEXT_BYTES)} and
          500,000 text characters.
          {partial
            ? " Raw preview contains only the loaded prefix. Download original retrieves the complete file."
            : " Raw and Download contain the complete file."}
          {file.verification === "partial"
            ? " Preview chunks are authenticated; the complete file has not been verified."
            : null}
        </p>
      ) : null}

      <RepositoryFileContent
        file={file}
        markdownMode={markdownMode}
        wrap={wrap}
      />
    </section>
  );
}

function MarkdownViewToggle({
  mode,
  onModeChange,
}: {
  mode: "preview" | "source";
  onModeChange(mode: "preview" | "source"): void;
}) {
  return (
    <fieldset className="inline-flex rounded-md border p-0.5">
      <legend className="sr-only">Markdown view</legend>
      <Button
        type="button"
        size="sm"
        variant={mode === "preview" ? "secondary" : "ghost"}
        className="h-7 px-2.5"
        onClick={() => onModeChange("preview")}
      >
        Preview
      </Button>
      <Button
        type="button"
        size="sm"
        variant={mode === "source" ? "secondary" : "ghost"}
        className="h-7 px-2.5"
        onClick={() => onModeChange("source")}
      >
        Source
      </Button>
    </fieldset>
  );
}

function RepositoryFileLoading({
  name,
  progress,
}: {
  name: string;
  progress: number | null;
}) {
  return (
    <section className="overflow-hidden rounded-md border" aria-live="polite">
      <header className="flex min-h-14 items-center gap-3 border-b px-4">
        <LoaderCircle className="size-5 animate-spin text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            Loading {name || "file"}
          </p>
          <p className="text-xs text-muted-foreground">
            {progress === null
              ? "Reading file contents…"
              : `${Math.round(progress)}% complete`}
          </p>
        </div>
        {progress !== null ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {Math.round(progress)}%
          </span>
        ) : null}
      </header>
      <div className="h-1 bg-muted">
        <div
          className={cn(
            "h-full bg-primary transition-[width] duration-200",
            progress === null && "w-1/3 animate-pulse",
          )}
          style={progress === null ? undefined : { width: `${progress}%` }}
        />
      </div>
      <div className="space-y-3 p-5">
        {FILE_LOADING_WIDTHS.map((width) => (
          <Skeleton
            key={`file-loading-${width}`}
            className="h-4"
            style={{ width: `${width}%` }}
          />
        ))}
      </div>
    </section>
  );
}

function RepositoryFileLocked({ onUnlock }: { onUnlock(): void }) {
  return (
    <ViewerMessage
      icon={LockKeyhole}
      title="Unlock this repository file"
      description="The file name and contents are encrypted. They will be decrypted only in this browser."
    >
      <Button type="button" onClick={onUnlock}>
        <LockKeyhole className="size-4" aria-hidden="true" />
        Unlock vault
      </Button>
    </ViewerMessage>
  );
}

function RepositoryFileError({
  entry,
  message,
  tooLarge,
  onRetry,
}: RepositoryFileViewerProps & {
  message: string;
  tooLarge: boolean;
  onRetry(): void;
}) {
  return (
    <ViewerMessage
      icon={tooLarge ? FileArchive : AlertTriangle}
      title={tooLarge ? "File is too large to preview" : "Preview unavailable"}
      description={
        tooLarge
          ? `${formatBytes(entry.sizeBytes)} exceeds the ${formatBytes(MAX_REPOSITORY_PREVIEW_BYTES)} in-browser preview limit. You can still download the original file.`
          : message
      }
    >
      <Button type="button" variant="outline" onClick={onRetry}>
        <RefreshCw className="size-4" aria-hidden="true" />
        Try again
      </Button>
      <RepositoryOriginalDownload entry={entry} />
    </ViewerMessage>
  );
}

function RepositoryOriginalDownload({ entry }: RepositoryFileViewerProps) {
  const vault = useVault();
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const downloadRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    const abort = () => downloadRef.current?.abort();
    window.addEventListener(VAULT_LOCKING_EVENT, abort);
    return () => {
      mountedRef.current = false;
      window.removeEventListener(VAULT_LOCKING_EVENT, abort);
      abort();
    };
  }, []);

  async function downloadOriginalEncryptedFile() {
    if (downloadRef.current) return;
    const controller = new AbortController();
    downloadRef.current = controller;
    setDownloadBusy(true);
    setError(null);
    try {
      if (!vault.client)
        throw new Error("Unlock the vault to download this file.");
      const manifest = await vault.openNode(entry.id);
      controller.signal.throwIfAborted();
      const plan = await getVaultDownloadPlan(entry.id, controller.signal);
      await downloadEncryptedFile({
        plan,
        manifest,
        client: vault.client,
        signal: controller.signal,
      });
    } catch (failure) {
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        !isAbortError(failure)
      ) {
        setError(
          failure instanceof Error ? failure.message : "Download failed.",
        );
      }
    } finally {
      downloadRef.current = null;
      if (mountedRef.current) setDownloadBusy(false);
    }
  }

  if (entry.e2eeState !== "encrypted") {
    return (
      <Button asChild size="sm">
        <a href={`/api/files/${encodeURIComponent(entry.id)}/download`}>
          <Download className="size-4" aria-hidden="true" />
          Download original
        </a>
      </Button>
    );
  }
  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() => void downloadOriginalEncryptedFile()}
        disabled={downloadBusy}
      >
        {downloadBusy ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="size-4" aria-hidden="true" />
        )}
        Download original
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

function ViewerMessage({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="flex min-h-80 flex-col items-center justify-center rounded-md border px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-6" aria-hidden="true" />
      </span>
      <h1 className="mt-4 font-display text-lg font-semibold">{title}</h1>
      <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
        {description}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">{children}</div>
    </section>
  );
}

function FilePresentationIcon({
  presentation,
}: {
  presentation: RepositoryFilePresentation;
}) {
  const Icon =
    presentation.kind === "image"
      ? FileImage
      : presentation.kind === "audio"
        ? Music2
        : presentation.kind === "video"
          ? Video
          : presentation.kind === "archive"
            ? FileArchive
            : presentation.kind === "font"
              ? FileType2
              : presentation.kind === "text" || presentation.kind === "markdown"
                ? FileCode2
                : FileText;
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
      <Icon className="size-5" aria-hidden="true" />
    </span>
  );
}

function shouldForceSafeRawText(
  file: Awaited<ReturnType<typeof prepareRepositoryFile>>,
): boolean {
  const mimeType = file.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    file.presentation.kind === "text" ||
    file.presentation.kind === "markdown" ||
    mimeType === "image/svg+xml" ||
    mimeType.includes("html") ||
    mimeType.includes("javascript") ||
    mimeType.includes("xml") ||
    /\.svg$/iu.test(file.name)
  );
}
