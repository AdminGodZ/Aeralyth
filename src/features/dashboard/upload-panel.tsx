"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  FileArchive,
  FileText,
  FolderUp,
  ImageIcon,
  LoaderCircle,
  UploadCloud,
  X,
} from "lucide-react";

import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import type { FolderZipWorkerResponse } from "@/features/dashboard/folder-zip-messages";
import { cn } from "@/lib/utils";

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

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_VISIBLE_SELECTIONS = 4;

export function UploadPanel({
  csrfToken,
  folderZipPromptEnabled,
  inputId: inputIdProp,
  parentFolderId,
}: {
  csrfToken: string;
  folderZipPromptEnabled: boolean;
  inputId?: string;
  parentFolderId?: string | null;
}) {
  const generatedInputId = useId();
  const inputId = inputIdProp ?? generatedInputId;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipWorkerRef = useRef<Worker | null>(null);
  const uploadRequestRef = useRef<XMLHttpRequest | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<UploadSelection[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
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
  const action = `/api/files/upload?${new URLSearchParams({
    csrf_token: csrfToken,
    ...(parentFolderId ? { parent_id: parentFolderId } : {}),
  })}`;
  const isBusy = isUploading || isCompressing;
  const visibleSelectedFiles = selectedFiles.slice(0, MAX_VISIBLE_SELECTIONS);

  useEffect(() => {
    return () => {
      zipWorkerRef.current?.terminate();
      uploadRequestRef.current?.abort();
    };
  }, []);

  function submitFiles(files: UploadSelection[]) {
    if (files.length === 0 || isUploading) {
      return;
    }

    setSelectedFiles(files);
    setUploadError(null);
    setIsUploading(true);
    setUploadProgress(null);

    const formData = new FormData();
    formData.append("csrf_token", csrfToken);

    files.forEach(({ file, relativePath }) => {
      formData.append("file", file, relativePath);
    });

    const request = new XMLHttpRequest();
    uploadRequestRef.current = request;
    request.open("POST", action);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        setUploadProgress(Math.min(100, (event.loaded / event.total) * 100));
      }
    });
    request.addEventListener("load", () => {
      uploadRequestRef.current = null;

      if (request.status >= 200 && request.status < 400) {
        setUploadProgress(100);
        window.location.assign(request.responseURL || action);
        return;
      }

      setIsUploading(false);
      setUploadProgress(null);
      setUploadError("Upload failed. Check the backend and try again.");
    });
    request.addEventListener("error", () => {
      uploadRequestRef.current = null;
      setIsUploading(false);
      setUploadProgress(null);
      setUploadError("Upload failed. Check the backend and try again.");
    });
    request.addEventListener("abort", () => {
      uploadRequestRef.current = null;
      setIsUploading(false);
      setUploadProgress(null);
      setSelectedFiles([]);
    });
    request.send(formData);
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
        totalBytes: files.reduce((total, selection) => total + selection.file.size, 0),
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

  async function handleDrop(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDragging(false);

    if (isBusy) {
      return;
    }

    const files = await collectDroppedFiles(event.dataTransfer);
    handleSelection(files);
  }

  function startFolderCompression() {
    if (!pendingFolderUpload || isCompressing) {
      return;
    }

    if (typeof Worker === "undefined") {
      setCompressionError("This browser cannot create ZIP archives in the background.");
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
      worker = new Worker(new URL("./folder-zip.worker.ts", import.meta.url), {
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
    uploadRequestRef.current?.abort();
  }

  return (
    <section className="overflow-hidden rounded-md border bg-card/45 p-5 shadow-[0_18px_70px_rgb(0_0_0/0.08)]">
      <div className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="font-display text-xl font-semibold leading-7">
              Upload files and folders
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {isCompressing
                ? "Creating a ZIP archive in your browser"
                : isUploading
                  ? "Uploading selected items"
                  : "Add any file type or preserve a complete folder structure."}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={isBusy}
            className="self-start"
            onClick={() => folderInputRef.current?.click()}
          >
            <FolderUp className="size-4" aria-hidden="true" />
            Choose folder
          </Button>
        </div>

        <label
          id="file-upload-area"
          htmlFor={inputId}
          role="button"
          tabIndex={isBusy ? -1 : 0}
          aria-disabled={isBusy}
          onDragEnter={() => {
            if (!isBusy) {
              setIsDragging(true);
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            if (!isBusy) {
              setIsDragging(true);
            }
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setIsDragging(false);
            }
          }}
          onDrop={(event) => void handleDrop(event)}
          onKeyDown={(event) => {
            if (!isBusy && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          className={cn(
            "upload-dropzone relative isolate flex min-h-60 cursor-pointer flex-col items-center justify-center overflow-hidden rounded-md border border-dashed px-4 py-8 text-center outline-none transition-colors",
            "bg-[linear-gradient(180deg,--theme(--color-muted/.20),transparent)]",
            "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30",
            isDragging
              ? "border-primary/80 bg-primary/10"
              : "border-border hover:border-primary/40 hover:bg-muted/40",
            isDragging && "is-dragging",
            isBusy && "cursor-not-allowed opacity-70",
          )}
        >
          <UploadEdgeAnimation active={isDragging} />
          <span className="relative z-10 flex size-14 items-center justify-center rounded-full border bg-background/80 text-primary shadow-[0_12px_40px_rgb(0_0_0/0.18)] backdrop-blur">
            <UploadCloud className="size-7" aria-hidden="true" />
          </span>
          <span className="relative z-10 mt-5 font-display text-lg font-semibold">
            Drag & drop files or folders here
          </span>
          <span className="relative z-10 mt-1 text-sm text-muted-foreground">
            or browse files from your device
          </span>
          <span className="relative z-10 mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground shadow-[0_12px_34px_color-mix(in_oklch,var(--primary)_28%,transparent)]">
            <UploadCloud className="size-4" aria-hidden="true" />
            Choose files
          </span>
          <span className="relative z-10 mt-4 text-sm text-muted-foreground">
            Any file type · Max file size: 2 GB
          </span>
          <input
            id={inputId}
            ref={fileInputRef}
            type="file"
            multiple
            disabled={isBusy}
            className="sr-only"
            onChange={handleFileChange}
          />
        </label>

        <input
          ref={folderInputRef}
          type="file"
          multiple
          disabled={isBusy}
          className="sr-only"
          onChange={handleFileChange}
          {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
        />

        {uploadError ? (
          <p role="alert" className="text-sm text-destructive">
            {uploadError}
          </p>
        ) : null}

        {isUploading ? (
          <div className="rounded-md border bg-muted/25 p-3" role="status">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                <LoaderCircle
                  className="size-4 shrink-0 animate-spin text-primary"
                  aria-hidden="true"
                />
                <span className="truncate">
                  Uploading{" "}
                  {selectedFiles.length === 1
                    ? "1 item"
                    : `${selectedFiles.length} items`}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs tabular-nums text-muted-foreground">
                  {uploadProgress === null
                    ? "Preparing"
                    : `${Math.round(uploadProgress)}%`}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={cancelUpload}
                >
                  <X className="size-4" aria-hidden="true" />
                  Cancel
                </Button>
              </div>
            </div>
            <Progress value={uploadProgress ?? 0} aria-label="Upload progress" />
          </div>
        ) : null}

        {selectedFiles.length > 0 ? (
          <AttachmentGroup
            role="group"
            aria-label="Selected files"
            tabIndex={0}
            className="pt-1"
          >
            {visibleSelectedFiles.map(({ file, relativePath }, index) => {
              const FileIcon = getUploadFileIcon(file);

              return (
                <Attachment
                  key={`${relativePath}-${file.size}-${file.lastModified}-${index}`}
                  state={isUploading ? "uploading" : "idle"}
                  className="w-72"
                >
                  <AttachmentMedia>
                    <FileIcon aria-hidden="true" />
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle>{relativePath}</AttachmentTitle>
                    <AttachmentDescription>
                      {isUploading
                        ? `Uploading - ${formatUploadBytes(file.size)}`
                        : formatUploadFileDescription(file)}
                    </AttachmentDescription>
                  </AttachmentContent>
                </Attachment>
              );
            })}
            {selectedFiles.length > MAX_VISIBLE_SELECTIONS ? (
              <p className="self-center px-2 text-sm text-muted-foreground">
                +{selectedFiles.length - MAX_VISIBLE_SELECTIONS} more
              </p>
            ) : null}
          </AttachmentGroup>
        ) : null}
      </div>

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
    </section>
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

        <div className="flex items-center gap-3 rounded-md border bg-muted/25 p-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <FileArchive className="size-5" aria-hidden="true" />
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
                variant="outline"
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
                variant="outline"
                className="h-auto min-h-24 items-start justify-start gap-3 whitespace-normal p-4 text-left"
                onClick={onUploadFolder}
              >
                <FolderUp
                  className="mt-0.5 size-5 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block font-semibold">Upload as folder</span>
                  <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">
                    Preserve the hierarchy so its contents remain browsable.
                  </span>
                </span>
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-24 items-start justify-start gap-3 whitespace-normal border-primary/35 bg-primary/5 p-4 text-left hover:bg-primary/10"
                onClick={onCreateZip}
              >
                <FileArchive
                  className="mt-0.5 size-5 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block font-semibold">
                    Create ZIP and upload
                  </span>
                  <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">
                    Compress locally and store the folder as one archive.
                  </span>
                </span>
              </Button>
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const uploadSparks = [
  ["2.5%", "7px", "0.2s", "3.2s", "42px", "8px"],
  ["5.5%", "11px", "1.1s", "3.8s", "58px", "16px"],
  ["9%", "6px", "2.1s", "3.4s", "34px", "-7px"],
  ["17%", "7px", "1.6s", "3.9s", "24px", "10px"],
  ["28%", "5px", "2.7s", "3.5s", "18px", "-6px"],
  ["72%", "6px", "0.7s", "3.6s", "20px", "8px"],
  ["83%", "8px", "1.8s", "4.1s", "28px", "-10px"],
  ["91%", "6px", "2.9s", "3.5s", "38px", "7px"],
  ["94.5%", "10px", "0.9s", "3.7s", "56px", "-17px"],
  ["97.5%", "6px", "2.4s", "3.3s", "44px", "-9px"],
] as const;

function UploadEdgeAnimation({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "upload-edge-effect pointer-events-none absolute inset-0 z-0 overflow-hidden",
        active && "is-active",
      )}
    >
      <span className="upload-edge-glow" />
      <span className="upload-edge-rim" />
      {uploadSparks.map(([left, size, delay, duration, rise, drift]) => (
        <span
          key={`${left}-${delay}`}
          className="upload-edge-spark"
          style={
            {
              "--spark-left": left,
              "--spark-size": size,
              "--spark-delay": delay,
              "--spark-duration": duration,
              "--spark-rise": rise,
              "--spark-drift": drift,
            } as React.CSSProperties
          }
        />
      ))}
    </span>
  );
}

function getBrowserRelativePath(file: File) {
  const relativePath = (file as File & { webkitRelativePath?: string })
    .webkitRelativePath;

  return relativePath || file.name;
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
  const fallbackName = `folder-upload-${new Date().toISOString().slice(0, 10)}`;
  const rootName =
    !hasTopLevelFile && roots.size === 1 ? Array.from(roots)[0] : fallbackName;
  const safeName = rootName
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  const archiveBaseName = (safeName || fallbackName).replace(/\.zip$/i, "");

  return `${archiveBaseName}.zip`;
}

async function collectDroppedFiles(dataTransfer: DataTransfer) {
  const entries = Array.from(dataTransfer.items)
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (entries.length === 0) {
    return Array.from(dataTransfer.files).map((file) => ({
      file,
      relativePath: file.name,
    }));
  }

  const nestedFiles = await Promise.all(entries.map(readDroppedEntry));
  return nestedFiles.flat();
}

async function readDroppedEntry(
  entry: FileSystemEntry,
): Promise<UploadSelection[]> {
  if (entry.isFile) {
    const file = await readDroppedFile(entry as FileSystemFileEntry);

    return [
      {
        file,
        relativePath: entry.fullPath.replace(/^\/+/, "") || file.name,
      },
    ];
  }

  if (!entry.isDirectory) {
    return [];
  }

  const children = await readDirectoryEntries(
    (entry as FileSystemDirectoryEntry).createReader(),
  );
  const nestedFiles = await Promise.all(children.map(readDroppedEntry));
  return nestedFiles.flat();
}

function readDroppedFile(entry: FileSystemFileEntry) {
  return new Promise<File>((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryEntries(reader: FileSystemDirectoryReader) {
  return new Promise<FileSystemEntry[]>((resolve, reject) => {
    const entries: FileSystemEntry[] = [];

    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(entries);
          return;
        }

        entries.push(...batch);
        readBatch();
      }, reject);
    };

    readBatch();
  });
}

function getUploadFileIcon(file: File) {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();

  if (type.startsWith("image/")) {
    return ImageIcon;
  }

  if (
    type.includes("zip") ||
    type.includes("archive") ||
    name.endsWith(".zip") ||
    name.endsWith(".tar") ||
    name.endsWith(".gz") ||
    name.endsWith(".rar")
  ) {
    return FileArchive;
  }

  return FileText;
}

function formatUploadFileDescription(file: File) {
  const type = file.type.split("/").at(-1)?.toUpperCase() || "File";

  return `${type} - ${formatUploadBytes(file.size)}`;
}

function formatFolderSelectionSummary(pendingUpload: PendingFolderUpload) {
  const fileCount =
    pendingUpload.files.length === 1
      ? "1 file"
      : `${pendingUpload.files.length} files`;

  return `${fileCount} · ${formatUploadBytes(pendingUpload.totalBytes)} total`;
}

function formatCompressionProgress(progress: CompressionProgress) {
  return `${formatUploadBytes(progress.processedBytes)} of ${formatUploadBytes(
    progress.totalBytes,
  )} processed`;
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

  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${
    units[unitIndex]
  }`;
}
