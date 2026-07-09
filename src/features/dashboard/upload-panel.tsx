"use client";

import { useId, useRef, useState } from "react";
import {
  FileArchive,
  FileText,
  FolderUp,
  ImageIcon,
  UploadCloud,
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
import { cn } from "@/lib/utils";

type UploadSelection = {
  file: File;
  relativePath: string;
};

export function UploadPanel({
  csrfToken,
  inputId: inputIdProp,
  parentFolderId,
}: {
  csrfToken: string;
  inputId?: string;
  parentFolderId?: string | null;
}) {
  const generatedInputId = useId();
  const inputId = inputIdProp ?? generatedInputId;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [selectedFiles, setSelectedFiles] = useState<UploadSelection[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const action = `/api/files/upload?${new URLSearchParams({
    csrf_token: csrfToken,
    ...(parentFolderId ? { parent_id: parentFolderId } : {}),
  })}`;

  async function submitFiles(files: UploadSelection[]) {
    if (files.length === 0 || isUploading) {
      return;
    }

    setSelectedFiles(files);
    setUploadError(null);
    setIsUploading(true);

    const formData = new FormData();
    formData.append("csrf_token", csrfToken);

    files.forEach(({ file, relativePath }) => {
      formData.append("file", file, relativePath);
    });

    try {
      const response = await fetch(action, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Upload failed with status ${response.status}`);
      }

      window.location.assign(response.url);
    } catch {
      setIsUploading(false);
      setUploadError("Upload failed. Check the backend and try again.");
    }
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []).map((file) => ({
      file,
      relativePath: getBrowserRelativePath(file),
    }));

    void submitFiles(files);
    event.currentTarget.value = "";
  }

  async function handleDrop(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDragging(false);

    const files = await collectDroppedFiles(event.dataTransfer);
    void submitFiles(files);
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
              {isUploading
                ? "Uploading selected items"
                : "Add any file type or preserve a complete folder structure."}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={isUploading}
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
          tabIndex={0}
          onDragEnter={() => setIsDragging(true)}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setIsDragging(false);
            }
          }}
          onDrop={(event) => void handleDrop(event)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
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
            className="sr-only"
            onChange={handleFileChange}
          />
        </label>

        <input
          ref={folderInputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={handleFileChange}
          {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
        />

        {uploadError ? (
          <p role="alert" className="text-sm text-destructive">
            {uploadError}
          </p>
        ) : null}

        {selectedFiles.length > 0 ? (
          <AttachmentGroup
            role="group"
            aria-label="Selected files"
            tabIndex={0}
            className="pt-1"
          >
            {selectedFiles.map(({ file, relativePath }, index) => {
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
          </AttachmentGroup>
        ) : null}
      </div>
    </section>
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
