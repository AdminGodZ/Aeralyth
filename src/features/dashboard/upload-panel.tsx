"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  FileArchive,
  FileUp,
  Folder,
  FolderUp,
  LoaderCircle,
  UploadCloud,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import type { FolderZipWorkerResponse } from "@/features/dashboard/folder-zip-messages";
import { uploadEncryptedSelections } from "@/features/vault/encrypted-upload";
import { useVault } from "@/features/vault/vault-provider";

type UploadSelection = {
  file: File;
  relativePath: string;
};

type PendingFolderUpload = {
  files: UploadSelection[];
  archiveName: string;
  totalBytes: number;
};

type CompressionProgress = {
  processedBytes: number;
  totalBytes: number;
  currentPath: string;
};

type UploadPlan = {
  uploadId: string;
  mode: "local" | "single" | "multipart";
  uploadUrl: string | null;
  existingParts: Array<{
    partNumber: number;
    etag: string;
    checksumSha256: string | null;
  }>;
  partSizeBytes: number | null;
  contentType: string;
};

type UploadedPart = {
  partNumber: number;
  etag: string;
  checksumSha256: string;
};

type UploadUrl = {
  url: string;
  contentLength: number;
};

type UploadCompletion = {
  status: "initializing" | "pending" | "completing" | "aborting" | "completed" | "aborted";
  fileId: string;
  location: string;
  pollUrl: string;
  retryAfterSeconds: number;
};

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SELECTION_FILES = 1000;
const MULTIPART_CONCURRENCY = 4;
const UPLOAD_RETRY_COUNT = 3;
const UPLOAD_FINALIZATION_TIMEOUT_MS = 45_000;

export function UploadPanel({
  csrfToken,
  e2eeMode,
  folderZipPromptEnabled,
  parentFolderId,
}: {
  csrfToken: string;
  e2eeMode: "off" | "migrate" | "required";
  folderZipPromptEnabled: boolean;
  parentFolderId?: string | null;
}) {
  const router = useRouter();
  const vault = useVault();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipWorkerRef = useRef<Worker | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const activeUploadRequestsRef = useRef(new Set<XMLHttpRequest>());
  const queuedVaultSelectionRef = useRef<UploadSelection[] | null>(null);
  const [selectedFileCount, setSelectedFileCount] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pendingFolderUpload, setPendingFolderUpload] =
    useState<PendingFolderUpload | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [compressionError, setCompressionError] = useState<string | null>(null);
  const [compressionProgress, setCompressionProgress] =
    useState<CompressionProgress>({
      processedBytes: 0,
      totalBytes: 0,
      currentPath: "",
    });
  const isBusy = isUploading || isCompressing;

  useEffect(() => {
    return () => {
      zipWorkerRef.current?.terminate();
      uploadAbortRef.current?.abort();
      activeUploadRequestsRef.current.forEach((request) => request.abort());
      activeUploadRequestsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const queued = queuedVaultSelectionRef.current;
    if (e2eeMode === "off" || vault.state !== "unlocked" || !queued) {
      return;
    }
    queuedVaultSelectionRef.current = null;
    submitFiles(queued);
  }, [e2eeMode, vault.state]);

  function submitFiles(files: UploadSelection[]) {
    if (files.length === 0 || isUploading) {
      return;
    }

    if (files.length > MAX_SELECTION_FILES) {
      setUploadError(
        `Choose no more than ${MAX_SELECTION_FILES.toLocaleString()} files at once.`,
      );
      return;
    }

    if (e2eeMode !== "off" && vault.state !== "unlocked") {
      queuedVaultSelectionRef.current = files;
      vault.requestUnlock();
      return;
    }

    setSelectedFileCount(files.length);
    setUploadError(null);
    setIsUploading(true);
    setUploadProgress(0);
    void uploadSelections(files);
  }

  async function uploadSelections(files: UploadSelection[]) {
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    const totalBytes = files.reduce(
      (total, selection) => total + selection.file.size,
      0,
    );
    const uploadedByPart = new Map<string, number>();
    const reportProgress = (key: string, loaded: number) => {
      uploadedByPart.set(key, loaded);
      const uploadedBytes = Array.from(uploadedByPart.values()).reduce(
        (total, value) => total + value,
        0,
      );
      setUploadProgress(
        totalBytes === 0
          ? 100
          : Math.min(100, (uploadedBytes / totalBytes) * 100),
      );
    };

    try {
      if (e2eeMode !== "off") {
        if (!vault.client) {
          throw new Error("The encrypted vault worker is not available.");
        }
        if (parentFolderId) {
          await vault.openNode(parentFolderId);
        }
        await uploadEncryptedSelections({
          selections: files,
          parentFolderId: parentFolderId ?? null,
          csrfToken,
          client: vault.client,
          signal: controller.signal,
          onProgress: (processedBytes, encryptedTotalBytes) => {
            setUploadProgress(
              encryptedTotalBytes === 0
                ? 100
                : Math.min(100, (processedBytes / encryptedTotalBytes) * 100),
            );
          },
        });
        setUploadProgress(100);
        setIsUploading(false);
        setSelectedFileCount(0);
        uploadAbortRef.current = null;
        router.refresh();
        return;
      }

      for (const [fileIndex, selection] of files.entries()) {
        if (controller.signal.aborted) {
          throw new DOMException("Upload canceled", "AbortError");
        }

        await uploadSelection(
          selection,
          fileIndex,
          controller.signal,
          reportProgress,
        );
      }

      setUploadProgress(100);
      setIsUploading(false);
      setSelectedFileCount(0);
      uploadAbortRef.current = null;
      router.refresh();
    } catch (uploadFailure) {
      uploadAbortRef.current = null;

      if (controller.signal.aborted || isAbortError(uploadFailure)) {
        setIsUploading(false);
        setUploadProgress(null);
        setSelectedFileCount(0);
        return;
      }

      finishUploadWithError(
        uploadFailure instanceof Error && uploadFailure.message
          ? uploadFailure.message
          : "Upload failed. Check the backend and try again.",
      );
    }
  }

  async function uploadSelection(
    selection: UploadSelection,
    fileIndex: number,
    signal: AbortSignal,
    reportProgress: (key: string, loaded: number) => void,
  ) {
    if (selection.file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`${selection.file.name} exceeds the 2 GB upload limit.`);
    }

    const plan = await requestJson<UploadPlan>(
      "/api/files/uploads",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          name: selection.file.name,
          relativePath: selection.relativePath,
          sizeBytes: selection.file.size,
          mimeType: selection.file.type || null,
          parentId: parentFolderId ?? null,
        }),
        signal,
      },
    );
    let completionStarted = false;

    try {
      let parts: UploadedPart[] = [];

      if (plan.mode === "multipart") {
        if (!plan.partSizeBytes) {
          throw new Error("The storage service returned an invalid multipart plan.");
        }

        const partCount = Math.ceil(selection.file.size / plan.partSizeBytes);
        const uploadParts = Array.from({ length: partCount }, (_, index) => ({
          partNumber: index + 1,
        }));
        const existingParts = new Map(
          plan.existingParts.map((part) => [part.partNumber, part]),
        );
        parts = await mapWithConcurrency(
          uploadParts,
          MULTIPART_CONCURRENCY,
          async (part) => {
            const start = (part.partNumber - 1) * plan.partSizeBytes!;
            const end = Math.min(start + plan.partSizeBytes!, selection.file.size);
            const blob = selection.file.slice(start, end, "");
            const progressKey = `${fileIndex}:${part.partNumber}`;
            const checksumSha256 = await sha256Base64(blob);
            const existingPart = existingParts.get(part.partNumber);

            if (
              existingPart?.checksumSha256 === checksumSha256 &&
              existingPart.etag
            ) {
              reportProgress(progressKey, blob.size);
              return {
                partNumber: part.partNumber,
                etag: existingPart.etag,
                checksumSha256,
              };
            }

            const signedPart = await requestJson<UploadUrl>(
              `/api/files/uploads/${encodeURIComponent(plan.uploadId)}/parts/${part.partNumber}`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-CSRF-Token": csrfToken,
                },
                body: JSON.stringify({ checksumSha256 }),
                signal,
              },
            );

            if (signedPart.contentLength !== blob.size) {
              throw new Error(
                "The storage service returned an invalid signed part length.",
              );
            }
            const response = await putBlobWithRetry(
              signedPart.url,
              blob,
              { "x-amz-checksum-sha256": checksumSha256 },
              signal,
              activeUploadRequestsRef.current,
              (loaded) => reportProgress(progressKey, loaded),
            );
            const etag = response.getResponseHeader("ETag")?.trim();

            if (!etag) {
              throw new Error(
                "The storage service did not expose the multipart ETag header.",
              );
            }

            return { partNumber: part.partNumber, etag, checksumSha256 };
          },
        );
        parts.sort((left, right) => left.partNumber - right.partNumber);
      } else {
        const checksumSha256 =
          plan.mode === "single"
            ? await sha256Base64(selection.file)
            : null;
        const signedUpload =
          plan.mode === "single"
            ? await requestJson<UploadUrl>(
                  `/api/files/uploads/${encodeURIComponent(plan.uploadId)}/content-url`,
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "X-CSRF-Token": csrfToken,
                    },
                    body: JSON.stringify({ checksumSha256 }),
                    signal,
                  },
                )
            : null;
        const uploadUrl = signedUpload?.url ?? plan.uploadUrl;

        if (!uploadUrl) {
          throw new Error("The storage service did not return an upload URL.");
        }
        if (
          signedUpload &&
          signedUpload.contentLength !== selection.file.size
        ) {
          throw new Error(
            "The storage service returned an invalid signed upload length.",
          );
        }

        await putBlobWithRetry(
          uploadUrl,
          selection.file,
          {
            "Content-Type": plan.contentType,
            ...(checksumSha256
              ? { "x-amz-checksum-sha256": checksumSha256 }
              : {}),
            ...(plan.mode === "local" ? { "X-CSRF-Token": csrfToken } : {}),
          },
          signal,
          activeUploadRequestsRef.current,
          (loaded) => reportProgress(`${fileIndex}:single`, loaded),
        );
      }

      completionStarted = true;
      await completeUploadWithPolling(
        `/api/files/uploads/${encodeURIComponent(plan.uploadId)}/complete`,
        { parts },
        csrfToken,
        signal,
      );
    } catch (error) {
      if (signal.aborted || (!completionStarted && plan.mode !== "multipart")) {
        await fetch(`/api/files/uploads/${encodeURIComponent(plan.uploadId)}`, {
          method: "DELETE",
          headers: { "X-CSRF-Token": csrfToken },
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  function finishUploadWithError(message: string) {
    setIsUploading(false);
    setUploadProgress(null);
    setSelectedFileCount(0);
    setUploadError(message);
  }

  function handleSelection(files: UploadSelection[]) {
    if (files.length === 0 || isBusy) {
      return;
    }

    setUploadError(null);

    if (folderZipPromptEnabled && isFolderSelection(files)) {
      setCompressionError(null);
      setPendingFolderUpload({
        files,
        archiveName: getFolderArchiveName(files),
        totalBytes: files.reduce(
          (total, selection) => total + selection.file.size,
          0,
        ),
      });
      return;
    }

    submitFiles(files);
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []).map((file) => ({
      file,
      relativePath: getBrowserRelativePath(file),
    }));

    handleSelection(files);
    event.currentTarget.value = "";
  }

  function startFolderCompression() {
    if (!pendingFolderUpload || isCompressing) {
      return;
    }

    if (typeof Worker === "undefined") {
      setCompressionError(
        "This browser cannot create ZIP archives in the background.",
      );
      return;
    }

    setCompressionError(null);
    setIsCompressing(true);
    setCompressionProgress({
      processedBytes: 0,
      totalBytes: pendingFolderUpload.totalBytes,
      currentPath: "",
    });

    let worker: Worker;

    try {
      worker = new Worker("/folder-zip.worker.js", {
        type: "module",
        name: "aeralyth-folder-zip",
      });
    } catch {
      setIsCompressing(false);
      setCompressionError(
        "The browser blocked the background ZIP worker. Upload the folder without compression instead.",
      );
      return;
    }

    zipWorkerRef.current = worker;
    worker.addEventListener(
      "message",
      (event: MessageEvent<FolderZipWorkerResponse>) => {
        if (zipWorkerRef.current !== worker) {
          return;
        }

        if (event.data.type === "progress") {
          setCompressionProgress(event.data);
          return;
        }

        if (event.data.type === "complete") {
          worker.terminate();
          zipWorkerRef.current = null;
          setIsCompressing(false);

          if (event.data.archive.size > MAX_UPLOAD_BYTES) {
            setCompressionError(
              "The generated ZIP is larger than the 2 GB upload limit.",
            );
            return;
          }

          const archiveFile = new File(
            [event.data.archive],
            pendingFolderUpload.archiveName,
            {
              type: "application/zip",
              lastModified: Date.now(),
            },
          );
          setPendingFolderUpload(null);
          submitFiles([
            {
              file: archiveFile,
              relativePath: archiveFile.name,
            },
          ]);
          return;
        }

        if (event.data.type === "canceled") {
          worker.terminate();
          zipWorkerRef.current = null;
          setIsCompressing(false);
          setPendingFolderUpload(null);
          return;
        }

        worker.terminate();
        zipWorkerRef.current = null;
        setIsCompressing(false);
        setCompressionError(
          event.data.message || "The ZIP archive could not be created.",
        );
      },
    );
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      worker.terminate();
      zipWorkerRef.current = null;
      setIsCompressing(false);
      setCompressionError("The ZIP archive could not be created.");
    });
    worker.postMessage({
      type: "compress",
      sources: pendingFolderUpload.files.map(({ file, relativePath }) => ({
        file,
        path: relativePath,
      })),
    });
  }

  function uploadPendingFolder() {
    if (!pendingFolderUpload || isCompressing) {
      return;
    }

    const files = pendingFolderUpload.files;
    setPendingFolderUpload(null);
    submitFiles(files);
  }

  function cancelCompression() {
    zipWorkerRef.current?.postMessage({ type: "cancel" });
    zipWorkerRef.current?.terminate();
    zipWorkerRef.current = null;
    setIsCompressing(false);
    setPendingFolderUpload(null);
  }

  function cancelUpload() {
    uploadAbortRef.current?.abort();
    activeUploadRequestsRef.current.forEach((request) => request.abort());
    activeUploadRequestsRef.current.clear();
  }

  return (
    <div className="flex min-w-0 flex-col items-end gap-2 sm:flex-row sm:items-center">
      {uploadError ? (
        <p
          role="alert"
          className="max-w-64 truncate text-xs text-destructive"
          title={uploadError}
        >
          {uploadError}
        </p>
      ) : null}

      {isUploading ? (
        <div className="flex min-w-52 items-center gap-3">
          <LoaderCircle
            className="size-4 shrink-0 animate-spin text-primary"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center justify-between gap-3 text-xs">
              <span className="truncate">
                {formatUploadCount(selectedFileCount)}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {uploadProgress === null
                  ? "Preparing"
                  : String(Math.round(uploadProgress)) + "%"}
              </span>
            </div>
            <Progress value={uploadProgress ?? 0} aria-label="Upload progress" />
          </div>
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            className="rounded-md"
            onClick={cancelUpload}
            aria-label="Cancel upload"
            title="Cancel upload"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" disabled={isBusy} className="rounded-full">
              <UploadCloud className="size-4" aria-hidden="true" />
              Upload
              <ChevronDown className="size-4 opacity-70" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem
              onSelect={() => fileInputRef.current?.click()}
            >
              <FileUp className="size-4" aria-hidden="true" />
              Upload files
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => folderInputRef.current?.click()}
            >
              <FolderUp className="size-4" aria-hidden="true" />
              Upload folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        disabled={isBusy}
        className="sr-only"
        tabIndex={-1}
        onChange={handleFileChange}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        disabled={isBusy}
        className="sr-only"
        tabIndex={-1}
        onChange={handleFileChange}
        {...({
          webkitdirectory: "",
          directory: "",
        } as React.InputHTMLAttributes<HTMLInputElement>)}
      />

      {pendingFolderUpload ? (
        <FolderUploadDecisionDialog
          pendingUpload={pendingFolderUpload}
          isCompressing={isCompressing}
          compressionError={compressionError}
          compressionProgress={compressionProgress}
          onClose={() => setPendingFolderUpload(null)}
          onUploadFolder={uploadPendingFolder}
          onCreateZip={startFolderCompression}
          onCancelCompression={cancelCompression}
        />
      ) : null}
    </div>
  );
}

function FolderUploadDecisionDialog({
  pendingUpload,
  isCompressing,
  compressionError,
  compressionProgress,
  onClose,
  onUploadFolder,
  onCreateZip,
  onCancelCompression,
}: {
  pendingUpload: PendingFolderUpload;
  isCompressing: boolean;
  compressionError: string | null;
  compressionProgress: CompressionProgress;
  onClose: () => void;
  onUploadFolder: () => void;
  onCreateZip: () => void;
  onCancelCompression: () => void;
}) {
  const progress = getProgressPercentage(
    compressionProgress.processedBytes,
    compressionProgress.totalBytes,
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isCompressing) {
          onClose();
        }
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={!isCompressing}
        onEscapeKeyDown={(event) => {
          if (isCompressing) {
            event.preventDefault();
          }
        }}
        onPointerDownOutside={(event) => {
          if (isCompressing) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {isCompressing
              ? "Creating ZIP archive"
              : "How should this folder be uploaded?"}
          </DialogTitle>
          <DialogDescription>
            {isCompressing
              ? "Compression stays in this browser. The server receives only the finished archive."
              : "Keep the folder browsable in Aeralyth or combine it into one ZIP before uploading."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 rounded-md border p-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Folder className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {pendingUpload.archiveName}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatFolderSelectionSummary(pendingUpload)}
            </p>
          </div>
        </div>

        {isCompressing ? (
          <div className="space-y-4" role="status" aria-live="polite">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-4 text-xs">
                <span className="min-w-0 truncate text-muted-foreground">
                  {compressionProgress.currentPath || "Preparing files"}
                </span>
                <span className="shrink-0 font-medium tabular-nums">
                  {Math.round(progress)}%
                </span>
              </div>
              <Progress value={progress} aria-label="ZIP compression progress" />
              <p className="text-xs text-muted-foreground">
                {formatCompressionProgress(compressionProgress)}
              </p>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                className="rounded-md"
                onClick={onCancelCompression}
              >
                <X className="size-4" aria-hidden="true" />
                Cancel compression
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            {compressionError ? (
              <p role="alert" className="text-sm text-destructive">
                {compressionError}
              </p>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="h-auto min-h-16 justify-start gap-3 rounded-md border border-transparent px-4 py-3 text-left whitespace-normal"
                onClick={onUploadFolder}
              >
                <FolderUp
                  className="size-5 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block font-semibold">
                    Upload uncompressed
                  </span>
                  <span className="mt-0.5 block text-xs font-normal leading-4 text-muted-foreground">
                    Keep the folder browsable
                  </span>
                </span>
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="h-auto min-h-16 justify-start gap-3 rounded-md border border-primary/70 px-4 py-3 text-left whitespace-normal hover:border-primary"
                onClick={onCreateZip}
              >
                <FileArchive
                  className="size-5 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block font-semibold">Compress to ZIP</span>
                  <span className="mt-0.5 block text-xs font-normal leading-4 text-muted-foreground">
                    Store it as one archive
                  </span>
                </span>
              </Button>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                className="rounded-md"
                onClick={onClose}
              >
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function getBrowserRelativePath(file: File) {
  const relativePath = (file as File & { webkitRelativePath?: string })
    .webkitRelativePath;

  return relativePath || file.name;
}

async function requestJson<T = unknown>(
  input: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);

  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new Error(message || `Upload request failed (${response.status}).`);
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function completeUploadWithPolling(
  completeUrl: string,
  body: { parts: UploadedPart[] },
  csrfToken: string,
  signal: AbortSignal,
) {
  const deadline = Date.now() + UPLOAD_FINALIZATION_TIMEOUT_MS;
  let completion = await requestUploadCompletion(completeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(body),
    signal,
  });
  let delayMs = completionRetryDelay(completion.retryAfterSeconds);

  while (completion.status !== "completed") {
    if (completion.status !== "completing") {
      throw new Error(`Upload finalization stopped (${completion.status}).`);
    }
    if (Date.now() + delayMs > deadline) {
      throw new Error(
        "The file is still being finalized. Its upload state was preserved; try refreshing shortly.",
      );
    }

    await wait(delayMs, signal);
    completion = await requestUploadCompletion(completion.pollUrl, {
      method: "GET",
      signal,
    });
    delayMs = Math.min(
      5_000,
      Math.max(delayMs * 1.5, completionRetryDelay(completion.retryAfterSeconds)),
    );
  }
}

async function requestUploadCompletion(
  input: string,
  init: RequestInit,
): Promise<UploadCompletion> {
  const response = await fetch(input, init);
  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    const message = (await response.text()).trim();
    throw new Error(message || `Upload finalization failed (${response.status}).`);
  }

  const completion = (await response.json()) as Partial<UploadCompletion>;

  if (!response.ok) {
    throw new Error(
      completion.status === "aborting" || completion.status === "aborted"
        ? "Upload finalization failed and the stored data is being cleaned up."
        : `Upload finalization failed (${response.status}).`,
    );
  }
  if (
    typeof completion.status !== "string" ||
    typeof completion.pollUrl !== "string" ||
    typeof completion.retryAfterSeconds !== "number"
  ) {
    throw new Error("The storage service returned an invalid completion status.");
  }

  return completion as UploadCompletion;
}

function completionRetryDelay(retryAfterSeconds: number) {
  return Math.min(5_000, Math.max(500, retryAfterSeconds * 1_000));
}

async function sha256Base64(blob: Blob) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("This browser cannot verify upload integrity with SHA-256.");
  }

  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  const bytes = new Uint8Array(digest);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

async function putBlobWithRetry(
  url: string,
  blob: Blob,
  headers: Record<string, string>,
  signal: AbortSignal,
  activeRequests: Set<XMLHttpRequest>,
  onProgress: (loaded: number) => void,
) {
  let lastError: unknown;

  for (let attempt = 0; attempt < UPLOAD_RETRY_COUNT; attempt += 1) {
    if (signal.aborted) {
      throw new DOMException("Upload canceled", "AbortError");
    }

    onProgress(0);

    try {
      return await putBlobOnce(
        url,
        blob,
        headers,
        signal,
        activeRequests,
        onProgress,
      );
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        throw error;
      }

      lastError = error;

      if (attempt + 1 < UPLOAD_RETRY_COUNT) {
        await wait(400 * 2 ** attempt, signal);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("The object upload failed after multiple attempts.");
}

function putBlobOnce(
  url: string,
  blob: Blob,
  headers: Record<string, string>,
  signal: AbortSignal,
  activeRequests: Set<XMLHttpRequest>,
  onProgress: (loaded: number) => void,
) {
  return new Promise<XMLHttpRequest>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abortRequest = () => request.abort();
    activeRequests.add(request);
    request.open("PUT", url);

    for (const [name, value] of Object.entries(headers)) {
      request.setRequestHeader(name, value);
    }

    const cleanup = () => {
      activeRequests.delete(request);
      signal.removeEventListener("abort", abortRequest);
    };

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(Math.min(blob.size, event.loaded));
      }
    });
    request.addEventListener("load", () => {
      cleanup();

      if (request.status >= 200 && request.status < 300) {
        onProgress(blob.size);
        resolve(request);
        return;
      }

      reject(new Error(`Object upload failed (${request.status}).`));
    });
    request.addEventListener("error", () => {
      cleanup();
      reject(new Error("The storage service could not be reached."));
    });
    request.addEventListener("abort", () => {
      cleanup();
      reject(new DOMException("Upload canceled", "AbortError"));
    });
    signal.addEventListener("abort", abortRequest, { once: true });
    request.send(blob);
  });
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failure: unknown;

  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (failure === undefined) {
        const index = nextIndex;
        nextIndex += 1;

        if (index >= values.length) {
          return;
        }

        try {
          results[index] = await operation(values[index]);
        } catch (error) {
          failure = error;
        }
      }
    },
  );

  await Promise.all(workers);

  if (failure !== undefined) {
    throw failure;
  }

  return results;
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new DOMException("Upload canceled", "AbortError"));
      },
      { once: true },
    );
  });
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function isFolderSelection(files: UploadSelection[]) {
  return files.some(({ relativePath }) =>
    relativePath.replaceAll("\\", "/").includes("/"),
  );
}

function getFolderArchiveName(files: UploadSelection[]) {
  const normalizedPaths = files.map(({ relativePath }) =>
    relativePath.replaceAll("\\", "/").replace(/^\/+/, ""),
  );
  const hasTopLevelFile = normalizedPaths.some((path) => !path.includes("/"));
  const roots = new Set(
    normalizedPaths
      .filter((path) => path.includes("/"))
      .map((path) => path.split("/", 1)[0])
      .filter(Boolean),
  );
  const fallbackName =
    "folder-upload-" + new Date().toISOString().slice(0, 10);
  const rootName =
    !hasTopLevelFile && roots.size === 1 ? Array.from(roots)[0] : fallbackName;
  const safeName = rootName
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  const archiveBaseName = (safeName || fallbackName).replace(/\.zip$/i, "");

  return archiveBaseName + ".zip";
}

function formatUploadCount(fileCount: number) {
  if (fileCount === 1) {
    return "Uploading 1 item";
  }

  return "Uploading " + String(fileCount) + " items";
}

function formatFolderSelectionSummary(pendingUpload: PendingFolderUpload) {
  const fileCount =
    pendingUpload.files.length === 1
      ? "1 file"
      : String(pendingUpload.files.length) + " files";

  return fileCount + " - " + formatUploadBytes(pendingUpload.totalBytes);
}

function formatCompressionProgress(progress: CompressionProgress) {
  return (
    formatUploadBytes(progress.processedBytes) +
    " of " +
    formatUploadBytes(progress.totalBytes) +
    " processed"
  );
}

function getProgressPercentage(processedBytes: number, totalBytes: number) {
  if (totalBytes <= 0) {
    return 0;
  }

  return Math.min(100, Math.max(0, (processedBytes / totalBytes) * 100));
}

function formatUploadBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let unitIndex = 0;
  let size = value;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const formattedSize =
    size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1);

  return formattedSize + " " + units[unitIndex];
}
