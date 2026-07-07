"use client";

import { useId, useRef, useState } from "react";
import {
  FileArchive,
  FileText,
  ImageIcon,
  Plus,
  UploadCloud,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { cn } from "@/lib/utils";

export function UploadPanel({
  csrfToken,
  inputId: inputIdProp,
}: {
  csrfToken: string;
  inputId?: string;
}) {
  const generatedInputId = useId();
  const inputId = inputIdProp ?? generatedInputId;
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const action = `/api/files/upload?csrf_token=${encodeURIComponent(csrfToken)}`;

  function submitFiles(files: File[]) {
    if (files.length === 0 || !inputRef.current || !formRef.current) {
      return;
    }

    setSelectedFiles(files);

    const dataTransfer = new DataTransfer();

    files.forEach((file) => {
      dataTransfer.items.add(file);
    });

    inputRef.current.files = dataTransfer.files;
    setIsUploading(true);
    formRef.current.requestSubmit();
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    submitFiles(Array.from(event.currentTarget.files ?? []));
  }

  function handleDrop(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDragging(false);

    const droppedFiles = Array.from(event.dataTransfer.files);

    if (droppedFiles.length === 0) {
      return;
    }

    submitFiles(droppedFiles);
  }

  return (
    <section className="overflow-hidden rounded-md border bg-card/45 p-5 shadow-[0_18px_70px_rgb(0_0_0/0.08)]">
      <form
        ref={formRef}
        action={action}
        method="post"
        encType="multipart/form-data"
        className="space-y-5"
      >
        <input type="hidden" name="csrf_token" value={csrfToken} />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="font-display text-xl font-semibold leading-7">
              Upload files
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {isUploading
                ? "Uploading selected files"
                : "Drag and drop files anywhere in the area below, or use the button to browse."}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled
            className="self-start"
            title="Folder creation is not wired yet"
          >
            <Plus className="size-4" aria-hidden="true" />
            New folder
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
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              inputRef.current?.click();
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
            Drag & drop files here
          </span>
          <span className="relative z-10 mt-1 text-sm text-muted-foreground">
            or browse from your device
          </span>
          <span className="relative z-10 mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground shadow-[0_12px_34px_color-mix(in_oklch,var(--primary)_28%,transparent)]">
            <UploadCloud className="size-4" aria-hidden="true" />
            Choose files
          </span>
          <span className="relative z-10 mt-4 text-sm text-muted-foreground">
            Max file size: 2 GB
          </span>
          <input
            id={inputId}
            ref={inputRef}
            name="file"
            type="file"
            required
            multiple
            className="sr-only"
            onChange={handleFileChange}
          />
        </label>

        {selectedFiles.length > 0 ? (
          <AttachmentGroup
            role="group"
            aria-label="Selected files"
            tabIndex={0}
            className="pt-1"
          >
            {selectedFiles.map((file, index) => {
              const FileIcon = getUploadFileIcon(file);

              return (
                <Attachment
                  key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                  state={isUploading ? "uploading" : "idle"}
                  className="w-72"
                >
                  <AttachmentMedia>
                    <FileIcon aria-hidden="true" />
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle>{file.name}</AttachmentTitle>
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
      </form>
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
