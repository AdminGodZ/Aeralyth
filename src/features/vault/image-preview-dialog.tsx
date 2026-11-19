"use client";

import {
  ChevronLeft,
  ChevronRight,
  Download,
  ImageOff,
  LoaderCircle,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { readEncryptedFileBlob } from "@/features/vault/encrypted-download";
import { getVaultDownloadPlan } from "@/features/vault/vault-api";
import { useVault } from "@/features/vault/vault-provider";
import { isAbortError } from "@/lib/abort";
import { formatBytes } from "@/lib/format";

/** Decrypted previews are held in memory, so very large images download instead. */
export const MAX_IMAGE_PREVIEW_BYTES = 64 * 1024 * 1024;

export type ImagePreviewEntry = {
  id: string;
  name: string;
  sizeBytes: number;
  e2eeState: "legacy" | "staged" | "encrypted";
  vaultRecordHash: string | null;
};

type PreviewState =
  | { status: "loading"; progress: number | null }
  | { status: "ready"; url: string }
  | { status: "too-large" }
  | { status: "error"; message: string };

export function ImagePreviewDialog({
  entries,
  activeId,
  downloading,
  onActiveIdChange,
  onClose,
  onDownload,
}: {
  /** Every previewable image in the listing, in display order. */
  entries: ImagePreviewEntry[];
  activeId: string;
  downloading: boolean;
  onActiveIdChange(id: string): void;
  onClose(): void;
  onDownload(entry: ImagePreviewEntry): void;
}) {
  const index = entries.findIndex((entry) => entry.id === activeId);
  const entry = index === -1 ? null : entries[index];
  const previous = index > 0 ? entries[index - 1] : null;
  const next =
    index !== -1 && index + 1 < entries.length ? entries[index + 1] : null;
  const preview = useImagePreview(entry);

  useEffect(() => {
    if (!entry) onClose();
  }, [entry, onClose]);

  if (!entry) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(90dvh,960px)] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(calc(100%-4rem),1280px)]"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" && previous) {
            event.preventDefault();
            onActiveIdChange(previous.id);
          } else if (event.key === "ArrowRight" && next) {
            event.preventDefault();
            onActiveIdChange(next.id);
          }
        }}
      >
        <div className="flex min-h-14 shrink-0 items-center gap-3 border-b px-4 py-2">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate leading-5">
              {entry.name}
            </DialogTitle>
            <DialogDescription className="text-xs tabular-nums">
              {formatBytes(entry.sizeBytes)}
              {entries.length > 1 ? ` · ${index + 1} of ${entries.length}` : ""}
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={downloading}
            onClick={() => onDownload(entry)}
            aria-label={`Download ${entry.name}`}
            title="Download"
          >
            {downloading ? (
              <LoaderCircle
                className="size-4 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Download className="size-4" aria-hidden="true" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close preview"
            title="Close"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black/[3%] p-4 dark:bg-white/[2%]">
          <PreviewBody
            key={`${entry.id}:${entry.vaultRecordHash ?? ""}`}
            name={entry.name}
            state={preview}
            downloading={downloading}
            onDownload={() => onDownload(entry)}
          />
          {previous ? (
            <PreviewStepButton
              side="left"
              label={`Previous image: ${previous.name}`}
              onClick={() => onActiveIdChange(previous.id)}
            />
          ) : null}
          {next ? (
            <PreviewStepButton
              side="right"
              label={`Next image: ${next.name}`}
              onClick={() => onActiveIdChange(next.id)}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({
  name,
  state,
  downloading,
  onDownload,
}: {
  name: string;
  state: PreviewState;
  downloading: boolean;
  onDownload(): void;
}) {
  const [decodeFailed, setDecodeFailed] = useState(false);

  if (state.status === "loading") {
    return (
      <p
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        Decrypting image
        {state.progress === null ? "…" : ` ${Math.round(state.progress)}%`}
      </p>
    );
  }

  if (state.status === "ready" && !decodeFailed) {
    return (
      // biome-ignore lint/performance/noImgElement: a decrypted blob URL cannot go through the image optimizer.
      <img
        src={state.url}
        alt={name}
        className="max-h-full max-w-full object-contain select-none"
        draggable={false}
        onError={() => setDecodeFailed(true)}
      />
    );
  }

  const message =
    state.status === "too-large"
      ? `Images larger than ${formatBytes(MAX_IMAGE_PREVIEW_BYTES)} open as a download.`
      : state.status === "error"
        ? state.message
        : "This browser cannot display this image format.";
  return (
    <div className="flex max-w-sm flex-col items-center gap-3 text-center">
      <ImageOff className="size-6 text-muted-foreground" aria-hidden="true" />
      <p role="alert" className="text-sm text-muted-foreground">
        {message}
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={downloading}
        onClick={onDownload}
      >
        <Download className="size-4" aria-hidden="true" />
        Download instead
      </Button>
    </div>
  );
}

function PreviewStepButton({
  side,
  label,
  onClick,
}: {
  side: "left" | "right";
  label: string;
  onClick(): void;
}) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <Button
      type="button"
      variant="secondary"
      size="icon-lg"
      className={`absolute top-1/2 -translate-y-1/2 rounded-full shadow-sm ${side === "left" ? "left-3" : "right-3"}`}
      onClick={onClick}
      aria-label={label}
      title={side === "left" ? "Previous (←)" : "Next (→)"}
    >
      <Icon className="size-5" aria-hidden="true" />
    </Button>
  );
}

function useImagePreview(entry: ImagePreviewEntry | null): PreviewState {
  const vault = useVault();
  // Each state names the image it belongs to, so switching images never
  // shows the previous image's revoked URL.
  const [tagged, setTagged] = useState<{
    key: string;
    state: PreviewState;
  } | null>(null);
  const entryId = entry?.id ?? null;
  const recordHash = entry?.vaultRecordHash ?? null;
  const encrypted = entry?.e2eeState === "encrypted";
  const tooLarge = (entry?.sizeBytes ?? 0) > MAX_IMAGE_PREVIEW_BYTES;
  const { client, openNode } = vault;
  // The record hash restarts the preview when the image is replaced while open.
  const previewKey = entryId ? `${entryId}:${recordHash ?? ""}` : null;

  useEffect(() => {
    if (!entryId || !previewKey) return;
    const setState = (state: PreviewState) =>
      setTagged({ key: previewKey, state });
    if (tooLarge) {
      setState({ status: "too-large" });
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ status: "loading", progress: null });
    void (async () => {
      try {
        let blob: Blob;
        if (encrypted) {
          if (!client) throw new Error("Unlock the vault to preview images.");
          const plan = await getVaultDownloadPlan(entryId, controller.signal);
          const manifest = await openNode(entryId, plan, controller.signal);
          blob = await readEncryptedFileBlob({
            plan,
            manifest,
            client,
            signal: controller.signal,
            onProgress(progress) {
              if (!controller.signal.aborted) {
                setState({ status: "loading", progress });
              }
            },
          });
        } else {
          const response = await fetch(
            `/api/files/${encodeURIComponent(entryId)}/download`,
            { credentials: "same-origin", signal: controller.signal },
          );
          if (!response.ok) throw new Error("The image could not be loaded.");
          blob = await response.blob();
        }
        controller.signal.throwIfAborted();
        objectUrl = URL.createObjectURL(blob);
        setState({ status: "ready", url: objectUrl });
      } catch (failure) {
        if (controller.signal.aborted || isAbortError(failure)) return;
        setState({
          status: "error",
          message:
            failure instanceof Error && failure.message
              ? failure.message
              : "The image could not be previewed.",
        });
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, encrypted, entryId, openNode, previewKey, tooLarge]);

  return tagged && tagged.key === previewKey
    ? tagged.state
    : { status: "loading", progress: null };
}
