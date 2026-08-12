"use client";

import {
  ChevronDown,
  CircleAlert,
  FileArchive,
  FileUp,
  Folder,
  FolderGit2,
  FolderUp,
  LoaderCircle,
  UploadCloud,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState } from "react";

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
import {
  type FolderUploadResolution,
  folderUploadCreatesRepository,
  normalizeUploadPath,
  resolveFolderUploadConflicts,
  type UploadTreeEntry,
} from "@/features/dashboard/folder-upload-conflicts";
import type { FolderZipWorkerResponse } from "@/features/dashboard/folder-zip-messages";
import {
  UploadProgressPanel,
  type UploadProgressSession,
} from "@/features/dashboard/upload-progress-panel";
import {
  getUploadSelectionError,
  MAX_UPLOAD_BYTES,
  prepareFolderUploadSelection,
} from "@/features/dashboard/upload-selection-policy";
import { uploadEncryptedSelections } from "@/features/vault/encrypted-upload";
import { getVaultDownloadPlan } from "@/features/vault/vault-api";
import { useVault } from "@/features/vault/vault-provider";

type UploadSelection = {
  file: File;
  relativePath: string;
};

type PendingFolderUpload = {
  files: UploadSelection[];
  archiveName: string;
  totalBytes: number;
  ignoredFiles: number;
};

type PendingReplacementUpload = {
  files: UploadSelection[];
  folderName: string;
  createRepository: boolean;
  ignoredFiles: number;
  resolution: FolderUploadResolution;
};

type QueuedUpload = {
  files: UploadSelection[];
  createRepository: boolean;
  ignoredFiles: number;
  resolution?: FolderUploadResolution;
  replacementConfirmed: boolean;
};

type QueuedVaultAction =
  | { kind: "upload"; upload: QueuedUpload }
  | { kind: "prepare-folder"; upload: QueuedUpload };

type CompressionProgress = {
  processedBytes: number;
  totalBytes: number;
  currentPath: string;
};

type UploadActivity = "idle" | "preparing" | "uploading" | "compressing";

type UploadPlan = {
  uploadId: string;
  rootFolderId: string | null;
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

type UploadPartUrl = UploadUrl & {
  partNumber: number;
};

type UploadCompletion = {
  status:
    | "initializing"
    | "pending"
    | "completing"
    | "aborting"
    | "completed"
    | "aborted";
  fileId: string;
  location: string;
  pollUrl: string;
  retryAfterSeconds: number;
};

type UploadPanelProps = {
  csrfToken?: string;
  shareToken?: string;
  replacementFileId?: string;
  e2eeMode: "off" | "migrate" | "required";
  folderZipPromptEnabled: boolean;
  parentFolderId?: string | null;
  surface?: "files" | "repositories" | "shared";
};

type CreatedRepository = {
  id: string;
};

type UploadChildrenPage = {
  entries: Array<{
    id: string;
    name: string;
    entryType: "file" | "folder";
    e2eeState: "legacy" | "staged" | "encrypted";
  }>;
  nextCursor: string | null;
  hasMore: boolean;
};

const MULTIPART_CONCURRENCY = 4;
const MULTIPART_PRESIGN_BATCH_SIZE = 8;
const LOCAL_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const UPLOAD_RETRY_COUNT = 3;
const UPLOAD_FINALIZATION_TIMEOUT_MS = 45_000;
const UPLOAD_TREE_PAGE_SIZE = 100;
const UPLOAD_TREE_DECRYPT_CONCURRENCY = 8;

export function UploadPanel(props: UploadPanelProps) {
  const controller = useUploadPanelController(props);
  return <UploadPanelView {...controller} />;
}

function useUploadPanelController({
  csrfToken,
  shareToken,
  replacementFileId,
  e2eeMode,
  folderZipPromptEnabled,
  parentFolderId,
  surface = "shared",
}: UploadPanelProps) {
  const router = useRouter();
  const vault = useVault();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipWorkerRef = useRef<Worker | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const preparationAbortRef = useRef<AbortController | null>(null);
  const activeUploadRequests = useStableSet<XMLHttpRequest>();
  const queuedVaultActionRef = useRef<QueuedVaultAction | null>(null);
  const [isPreparingSelection, setIsPreparingSelection] = useState(false);
  const [preparingMessage, setPreparingMessage] = useState(
    "Preparing selected files",
  );
  const [isUploading, setIsUploading] = useState(false);
  const [uploadSession, setUploadSession] =
    useState<UploadProgressSession | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pendingFolderUpload, setPendingFolderUpload] =
    useState<PendingFolderUpload | null>(null);
  const [pendingReplacementUpload, setPendingReplacementUpload] =
    useState<PendingReplacementUpload | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [compressionError, setCompressionError] = useState<string | null>(null);
  const [compressionProgress, setCompressionProgress] =
    useState<CompressionProgress>({
      processedBytes: 0,
      totalBytes: 0,
      currentPath: "",
    });
  const activity: UploadActivity = isPreparingSelection
    ? "preparing"
    : isUploading
      ? "uploading"
      : isCompressing
        ? "compressing"
        : "idle";
  const isBusy = activity !== "idle";
  const requestAuthHeaders: Record<string, string> = shareToken
    ? { "X-Aeralyth-Share-Token": shareToken }
    : csrfToken
      ? { "X-CSRF-Token": csrfToken }
      : {};

  useEffect(() => {
    return () => {
      zipWorkerRef.current?.terminate();
      uploadAbortRef.current?.abort();
      preparationAbortRef.current?.abort();
      for (const request of activeUploadRequests) {
        request.abort();
      }
      activeUploadRequests.clear();
    };
  }, [activeUploadRequests]);

  const resumeQueuedVaultAction = useEffectEvent(
    (queued: QueuedVaultAction) => {
      if (queued.kind === "prepare-folder") {
        void prepareFolderUpload(
          queued.upload.files,
          queued.upload.createRepository,
          queued.upload.ignoredFiles,
          queued.upload.replacementConfirmed,
        );
        return;
      }
      submitFiles(
        queued.upload.files,
        queued.upload.createRepository,
        queued.upload.ignoredFiles,
        queued.upload.resolution,
        queued.upload.replacementConfirmed,
      );
    },
  );

  useEffect(() => {
    const queued = queuedVaultActionRef.current;
    if (e2eeMode === "off" || vault.state !== "unlocked" || !queued) {
      return;
    }
    queuedVaultActionRef.current = null;
    resumeQueuedVaultAction(queued);
  }, [e2eeMode, vault.state]);

  function submitFiles(
    files: UploadSelection[],
    createRepository = false,
    ignoredFiles = 0,
    resolution?: FolderUploadResolution,
    replacementConfirmed = false,
  ) {
    if (files.length === 0 || isUploading) {
      return;
    }

    const selectionError = getUploadSelectionError(
      files,
      Boolean(replacementFileId),
    );
    if (selectionError) {
      setUploadError(selectionError);
      return;
    }

    if (e2eeMode !== "off" && vault.state !== "unlocked") {
      queuedVaultActionRef.current = {
        kind: resolution ? "prepare-folder" : "upload",
        upload: {
          files,
          createRepository,
          ignoredFiles,
          resolution,
          replacementConfirmed,
        },
      };
      vault.requestUnlock();
      return;
    }

    setUploadError(null);
    setIsUploading(true);
    setUploadSession(createUploadProgressSession(files, ignoredFiles));
    void uploadSelections(files, createRepository, resolution);
  }

  async function uploadSelections(
    files: UploadSelection[],
    createRepository: boolean,
    resolution?: FolderUploadResolution,
  ) {
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    const uploadedByPart = new Map<string, number>();
    const uploadedByFile = new Map<number, number>();
    let uploadedBytes = 0;
    let activeFileIndex: number | null = null;

    const startFile = (fileIndex: number) => {
      activeFileIndex = fileIndex;
      setUploadSession((current) =>
        current?.status === "uploading"
          ? {
              ...current,
              activeFileIndex: fileIndex,
              activeFileUploadedBytes: uploadedByFile.get(fileIndex) ?? 0,
              updatedAt: Date.now(),
            }
          : current,
      );
    };
    const reportProgress = (fileIndex: number, key: string, loaded: number) => {
      const previousPartBytes = uploadedByPart.get(key) ?? 0;
      const delta = Math.max(0, loaded - previousPartBytes);
      uploadedByPart.set(key, loaded);
      uploadedBytes += delta;
      const fileBytes = (uploadedByFile.get(fileIndex) ?? 0) + delta;
      uploadedByFile.set(fileIndex, fileBytes);
      setUploadSession((current) =>
        current?.status === "uploading"
          ? {
              ...current,
              uploadedBytes: Math.min(current.totalBytes, uploadedBytes),
              activeFileIndex: fileIndex,
              activeFileUploadedBytes: Math.min(
                current.items[fileIndex]?.sizeBytes ?? fileBytes,
                fileBytes,
              ),
              updatedAt: Date.now(),
            }
          : current,
      );
    };
    const completeFile = (fileIndex: number) => {
      const fileSize = files[fileIndex]?.file.size ?? 0;
      const recordedBytes = uploadedByFile.get(fileIndex) ?? 0;
      uploadedBytes += Math.max(0, fileSize - recordedBytes);
      uploadedByFile.set(fileIndex, fileSize);
      activeFileIndex = null;
      setUploadSession((current) =>
        current?.status === "uploading"
          ? {
              ...current,
              uploadedBytes: Math.min(current.totalBytes, uploadedBytes),
              completedFiles: Math.max(current.completedFiles, fileIndex + 1),
              activeFileIndex: null,
              activeFileUploadedBytes: 0,
              updatedAt: Date.now(),
            }
          : current,
      );
    };

    try {
      if (e2eeMode !== "off") {
        if (!csrfToken) {
          throw new Error("The encrypted upload session is unavailable.");
        }
        if (!vault.client) {
          throw new Error("The encrypted vault worker is not available.");
        }
        if (parentFolderId) {
          await vault.openNode(parentFolderId);
        }
        const encryptedUpload = await uploadEncryptedSelections({
          selections: files,
          parentFolderId: parentFolderId ?? null,
          resolution,
          csrfToken,
          client: vault.client,
          signal: controller.signal,
          onFileStart: startFile,
          onFileComplete: completeFile,
          onProgress: (
            processedBytes,
            encryptedTotalBytes,
            fileIndex,
            fileProcessedBytes,
          ) => {
            uploadedBytes = processedBytes;
            uploadedByFile.set(fileIndex, fileProcessedBytes);
            setUploadSession((current) =>
              current?.status === "uploading"
                ? {
                    ...current,
                    totalBytes: encryptedTotalBytes,
                    uploadedBytes: Math.min(
                      encryptedTotalBytes,
                      processedBytes,
                    ),
                    activeFileIndex: fileIndex,
                    activeFileUploadedBytes: fileProcessedBytes,
                    updatedAt: Date.now(),
                  }
                : current,
            );
          },
        });
        await finishSuccessfulUpload(
          encryptedUpload.rootFolderId,
          createRepository,
          controller.signal,
        );
        return;
      }

      let rootFolderId: string | null = null;
      for (const [fileIndex, selection] of files.entries()) {
        if (controller.signal.aborted) {
          throw new DOMException("Upload canceled", "AbortError");
        }

        startFile(fileIndex);

        // Legacy uploads are deliberately serialized so per-file multipart
        // concurrency cannot multiply memory and network pressure.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const uploadedRootFolderId = await uploadSelection(
          selection,
          fileIndex,
          resolution,
          controller.signal,
          (key, loaded) => reportProgress(fileIndex, key, loaded),
        );
        rootFolderId ??= uploadedRootFolderId;
        completeFile(fileIndex);
      }

      await finishSuccessfulUpload(
        rootFolderId,
        createRepository,
        controller.signal,
      );
    } catch (uploadFailure) {
      uploadAbortRef.current = null;

      if (controller.signal.aborted || isAbortError(uploadFailure)) {
        setIsUploading(false);
        setUploadSession(null);
        return;
      }

      finishUploadWithError(
        uploadFailure instanceof Error && uploadFailure.message
          ? uploadFailure.message
          : "Upload failed. Check the backend and try again.",
        activeFileIndex,
      );
    }
  }

  async function finishSuccessfulUpload(
    rootFolderId: string | null,
    createRepository: boolean,
    signal: AbortSignal,
  ) {
    let repositoryId: string | null = null;
    if (createRepository) {
      if (!csrfToken) {
        throw new Error("The repository session is unavailable.");
      }
      if (!rootFolderId) {
        throw new Error(
          "The folder was uploaded, but its repository root could not be identified.",
        );
      }
      const repository = await requestJson<CreatedRepository>(
        "/api/repositories",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({ rootFolderId }),
          signal,
        },
      );
      repositoryId = repository.id;
    }

    setIsUploading(false);
    setUploadSession(null);
    uploadAbortRef.current = null;
    if (repositoryId) {
      router.push(`/repositories/${encodeURIComponent(repositoryId)}`);
    } else {
      router.refresh();
    }
  }

  async function uploadSelection(
    selection: UploadSelection,
    fileIndex: number,
    resolution: FolderUploadResolution | undefined,
    signal: AbortSignal,
    reportProgress: (key: string, loaded: number) => void,
  ) {
    if (selection.file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`${selection.file.name} exceeds the 2 GB upload limit.`);
    }

    const plan = await requestJson<UploadPlan>("/api/files/uploads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...requestAuthHeaders,
      },
      body: JSON.stringify({
        name: selection.file.name,
        relativePath: selection.relativePath,
        sizeBytes: selection.file.size,
        mimeType: selection.file.type || null,
        parentId: parentFolderId ?? null,
        replacementFileId:
          replacementFileId ??
          resolution?.replacementFiles.get(
            normalizeUploadPath(selection.relativePath),
          )?.id ??
          null,
      }),
      signal,
    });
    let completionStarted = false;

    try {
      const parts: UploadedPart[] = [];

      if (plan.mode === "multipart") {
        const partSizeBytes = plan.partSizeBytes;
        if (!partSizeBytes) {
          throw new Error(
            "The storage service returned an invalid multipart plan.",
          );
        }

        const partCount = Math.ceil(selection.file.size / partSizeBytes);
        const uploadParts = Array.from({ length: partCount }, (_, index) => ({
          partNumber: index + 1,
        }));
        const existingParts = new Map(
          plan.existingParts.map((part) => [part.partNumber, part]),
        );
        for (
          let batchStart = 0;
          batchStart < uploadParts.length;
          batchStart += MULTIPART_PRESIGN_BATCH_SIZE
        ) {
          if (signal.aborted) {
            throw new DOMException("Upload canceled", "AbortError");
          }
          const batch = uploadParts.slice(
            batchStart,
            batchStart + MULTIPART_PRESIGN_BATCH_SIZE,
          );
          const prepared = await mapWithConcurrency(
            batch,
            MULTIPART_CONCURRENCY,
            async (part) => {
              const start = (part.partNumber - 1) * partSizeBytes;
              const end = Math.min(start + partSizeBytes, selection.file.size);
              const blob = selection.file.slice(start, end, "");
              const checksumSha256 = await sha256Base64(blob);
              const existingPart = existingParts.get(part.partNumber);
              const completed =
                existingPart?.checksumSha256 === checksumSha256 &&
                existingPart.etag
                  ? {
                      partNumber: part.partNumber,
                      etag: existingPart.etag,
                      checksumSha256,
                    }
                  : null;
              if (completed) {
                reportProgress(`${fileIndex}:${part.partNumber}`, blob.size);
              }
              return { ...part, blob, checksumSha256, completed };
            },
          );
          const pending = prepared.filter((part) => !part.completed);
          const signedParts =
            pending.length === 0
              ? []
              : await requestJson<{ parts: UploadPartUrl[] }>(
                  `/api/files/uploads/${encodeURIComponent(plan.uploadId)}/parts`,
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      ...requestAuthHeaders,
                    },
                    body: JSON.stringify({
                      parts: pending.map((part) => ({
                        partNumber: part.partNumber,
                        checksumSha256: part.checksumSha256,
                      })),
                    }),
                    signal,
                  },
                ).then((response) => response.parts);
          const signedByPart = new Map(
            signedParts.map((part) => [part.partNumber, part]),
          );
          if (signedByPart.size !== pending.length) {
            throw new Error(
              "The storage service returned an incomplete multipart batch.",
            );
          }
          const uploaded = await mapWithConcurrency(
            prepared,
            MULTIPART_CONCURRENCY,
            async (part): Promise<UploadedPart> => {
              if (part.completed) return part.completed;
              const signedPart = signedByPart.get(part.partNumber);
              if (!signedPart || signedPart.contentLength !== part.blob.size) {
                throw new Error(
                  "The storage service returned an invalid signed part length.",
                );
              }
              const progressKey = `${fileIndex}:${part.partNumber}`;
              const response = await putBlobWithRetry(
                signedPart.url,
                part.blob,
                { "x-amz-checksum-sha256": part.checksumSha256 },
                signal,
                activeUploadRequests,
                (loaded) => reportProgress(progressKey, loaded),
              );
              const etag = response.getResponseHeader("ETag")?.trim();
              if (!etag) {
                throw new Error(
                  "The storage service did not expose the multipart ETag header.",
                );
              }
              return {
                partNumber: part.partNumber,
                etag,
                checksumSha256: part.checksumSha256,
              };
            },
          );
          parts.push(...uploaded);
        }
        parts.sort((left, right) => left.partNumber - right.partNumber);
      } else {
        const checksumSha256 =
          plan.mode === "single" ? await sha256Base64(selection.file) : null;
        const signedUpload =
          plan.mode === "single"
            ? await requestJson<UploadUrl>(
                `/api/files/uploads/${encodeURIComponent(plan.uploadId)}/content-url`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    ...requestAuthHeaders,
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

        if (plan.mode === "local") {
          await putLocalBlobWithRetry(
            uploadUrl,
            selection.file,
            {
              "Content-Type": plan.contentType,
              ...requestAuthHeaders,
            },
            signal,
            activeUploadRequests,
            (chunkIndex, loaded) =>
              reportProgress(`${fileIndex}:local:${chunkIndex}`, loaded),
          );
        } else {
          await putBlobWithRetry(
            uploadUrl,
            selection.file,
            {
              "Content-Type": plan.contentType,
              ...(checksumSha256
                ? { "x-amz-checksum-sha256": checksumSha256 }
                : {}),
            },
            signal,
            activeUploadRequests,
            (loaded) => reportProgress(`${fileIndex}:single`, loaded),
          );
        }
      }

      completionStarted = true;
      await completeUploadWithPolling(
        `/api/files/uploads/${encodeURIComponent(plan.uploadId)}/complete`,
        { parts },
        requestAuthHeaders,
        signal,
      );
    } catch (error) {
      if (signal.aborted || (!completionStarted && plan.mode !== "multipart")) {
        await fetch(`/api/files/uploads/${encodeURIComponent(plan.uploadId)}`, {
          method: "DELETE",
          headers: requestAuthHeaders,
        }).catch(() => undefined);
      }
      throw error;
    }

    return plan.rootFolderId;
  }

  function finishUploadWithError(
    message: string,
    activeFileIndex: number | null,
  ) {
    setIsUploading(false);
    setUploadSession((current) =>
      current
        ? {
            ...current,
            activeFileIndex,
            activeFileUploadedBytes:
              activeFileIndex === null ? 0 : current.activeFileUploadedBytes,
            status: "failed",
            error: message,
            updatedAt: Date.now(),
          }
        : current,
    );
  }

  async function handleSelection(files: UploadSelection[]) {
    if (files.length === 0 || isBusy) {
      return;
    }

    setUploadError(null);

    const folderSelection = isFolderSelection(files);
    if (replacementFileId && folderSelection) {
      setUploadError("Choose one file, not a folder, for this replacement.");
      return;
    }

    let uploadFiles = files;
    let ignoredFiles = 0;
    const createRepository = folderUploadCreatesRepository(surface);
    if (folderSelection) {
      setPreparingMessage("Applying .gitignore");
      setIsPreparingSelection(true);
      try {
        const prepared = await prepareFolderUploadSelection(files);
        uploadFiles = prepared.files;
        ignoredFiles = prepared.ignoredFiles;
        if (prepared.error) {
          setIsPreparingSelection(false);
          setUploadError(prepared.error);
          return;
        }
      } catch (error) {
        setIsPreparingSelection(false);
        setUploadError(
          error instanceof Error && error.message
            ? error.message
            : "The .gitignore rules could not be applied.",
        );
        return;
      }
      setIsPreparingSelection(false);

      if (uploadFiles.length === 0) {
        setUploadError(
          "Every file in this folder is excluded by its .gitignore rules or Git metadata filtering.",
        );
        return;
      }
    }

    if (createRepository) {
      if (!folderSelection) {
        setUploadError("Choose a project folder to create a repository.");
        return;
      }
      queueFolderOrUpload(uploadFiles, ignoredFiles, createRepository);
      return;
    }

    queueFolderOrUpload(uploadFiles, ignoredFiles);
  }

  function queueFolderOrUpload(
    files: UploadSelection[],
    ignoredFiles = 0,
    createRepository = false,
  ) {
    if (folderZipPromptEnabled && isFolderSelection(files)) {
      setCompressionError(null);
      setPendingFolderUpload({
        files,
        archiveName: getFolderArchiveName(files),
        totalBytes: files.reduce(
          (total, selection) => total + selection.file.size,
          0,
        ),
        ignoredFiles,
      });
      return;
    }

    if (isFolderSelection(files) && !shareToken) {
      void prepareFolderUpload(files, createRepository, ignoredFiles);
      return;
    }

    submitFiles(files, createRepository, ignoredFiles);
  }

  async function prepareFolderUpload(
    files: UploadSelection[],
    createRepository: boolean,
    ignoredFiles: number,
    replacementConfirmed = false,
  ) {
    if (e2eeMode !== "off" && vault.state !== "unlocked") {
      queuedVaultActionRef.current = {
        kind: "prepare-folder",
        upload: {
          files,
          createRepository,
          ignoredFiles,
          replacementConfirmed,
        },
      };
      vault.requestUnlock();
      return;
    }

    preparationAbortRef.current?.abort();
    const controller = new AbortController();
    preparationAbortRef.current = controller;
    setPreparingMessage("Checking existing files");
    setIsPreparingSelection(true);
    setUploadError(null);

    try {
      if (e2eeMode !== "off" && parentFolderId) {
        await vault.openNode(parentFolderId);
      }
      const resolution = await resolveFolderUploadConflicts({
        relativePaths: files.map(({ relativePath }) => relativePath),
        parentFolderId: parentFolderId ?? null,
        loadChildren: (folderId) =>
          loadUploadTreeChildren(folderId, controller.signal),
      });
      assertEncryptedResolutionReady(resolution);

      if (resolution.conflictPaths.length > 0 && !replacementConfirmed) {
        setPendingReplacementUpload({
          files,
          folderName: getFolderSelectionName(files),
          createRepository,
          ignoredFiles,
          resolution,
        });
        return;
      }

      submitFiles(
        files,
        createRepository,
        ignoredFiles,
        resolution,
        replacementConfirmed,
      );
    } catch (error) {
      if (!isAbortError(error)) {
        setUploadError(
          error instanceof Error && error.message
            ? error.message
            : "Existing files could not be checked. Try the upload again.",
        );
      }
    } finally {
      if (preparationAbortRef.current === controller) {
        preparationAbortRef.current = null;
      }
      setIsPreparingSelection(false);
    }
  }

  async function loadUploadTreeChildren(
    folderId: string | null,
    signal: AbortSignal,
  ): Promise<UploadTreeEntry[]> {
    const listed: UploadChildrenPage["entries"] = [];
    let cursor: string | null = null;

    do {
      const search = new URLSearchParams({
        view: "files",
        sort: "name",
        direction: "asc",
        limit: String(UPLOAD_TREE_PAGE_SIZE),
        ...(folderId ? { folder: folderId } : {}),
        ...(cursor ? { cursor } : {}),
      });
      // Pagination is sequential because each cursor is issued by the previous page.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const page = await requestJson<UploadChildrenPage>(
        `/api/files?${search}`,
        {
          signal,
        },
      );
      listed.push(...page.entries);
      cursor = page.hasMore ? page.nextCursor : null;
      if (page.hasMore && !cursor) {
        throw new Error("The existing folder listing could not be continued.");
      }
    } while (cursor);

    return mapWithConcurrency(
      listed,
      UPLOAD_TREE_DECRYPT_CONCURRENCY,
      async (entry): Promise<UploadTreeEntry> => {
        if (entry.e2eeState !== "encrypted") {
          return entry;
        }
        if (!vault.client) {
          throw new Error("Unlock the vault before checking existing files.");
        }
        const plan = await getVaultDownloadPlan(entry.id, signal);
        const opened = await vault.client.openPlan(plan);
        if (opened.manifest.entryType !== entry.entryType) {
          throw new Error("An encrypted file record has an invalid type.");
        }
        return {
          ...entry,
          name: opened.manifest.name,
          generationNumber: plan.generationNumber,
          recordVersion: plan.recordVersion,
          recordHash: plan.recordHash,
        };
      },
    );
  }

  function assertEncryptedResolutionReady(resolution: FolderUploadResolution) {
    if (e2eeMode === "off") return;
    const matched = [
      ...resolution.existingFolders.values(),
      ...resolution.replacementFiles.values(),
    ];
    if (matched.some(({ e2eeState }) => e2eeState !== "encrypted")) {
      throw new Error(
        "This existing folder is still being encrypted. Wait for vault migration to finish, then upload it again.",
      );
    }
  }

  function confirmReplacementUpload() {
    if (!pendingReplacementUpload) return;
    const pending = pendingReplacementUpload;
    setPendingReplacementUpload(null);
    submitFiles(
      pending.files,
      pending.createRepository,
      pending.ignoredFiles,
      pending.resolution,
      true,
    );
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []).map((file) => ({
      file,
      relativePath: getBrowserRelativePath(file),
    }));

    event.currentTarget.value = "";
    void handleSelection(files);
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
          submitFiles(
            [
              {
                file: archiveFile,
                relativePath: archiveFile.name,
              },
            ],
            false,
            pendingFolderUpload.ignoredFiles,
          );
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
    const ignoredFiles = pendingFolderUpload.ignoredFiles;
    setPendingFolderUpload(null);
    void prepareFolderUpload(files, false, ignoredFiles);
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
    for (const request of activeUploadRequests) {
      request.abort();
    }
    activeUploadRequests.clear();
  }

  return {
    uploadError,
    activity,
    preparingMessage,
    uploadSession,
    fileInputRef,
    folderInputRef,
    handleFileChange,
    pendingFolderUpload,
    pendingReplacementUpload,
    compressionError,
    compressionProgress,
    closePendingFolderUpload: () => setPendingFolderUpload(null),
    closePendingReplacementUpload: () => setPendingReplacementUpload(null),
    confirmReplacementUpload,
    uploadPendingFolder,
    startFolderCompression,
    cancelCompression,
    cancelUpload,
    dismissUploadSession: () => setUploadSession(null),
    replacementFileId,
    surface,
  };
}

function UploadPanelView({
  uploadError,
  activity,
  preparingMessage,
  uploadSession,
  fileInputRef,
  folderInputRef,
  handleFileChange,
  pendingFolderUpload,
  pendingReplacementUpload,
  compressionError,
  compressionProgress,
  closePendingFolderUpload,
  closePendingReplacementUpload,
  confirmReplacementUpload,
  uploadPendingFolder,
  startFolderCompression,
  cancelCompression,
  cancelUpload,
  dismissUploadSession,
  replacementFileId,
  surface,
}: ReturnType<typeof useUploadPanelController>) {
  const isBusy = activity !== "idle";
  const isCompressing = activity === "compressing";

  return (
    <div className="flex min-w-0 flex-col items-end gap-2 sm:flex-row sm:items-center">
      {uploadError ? (
        <div
          role="alert"
          className="flex max-w-sm items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          <CircleAlert
            className="mt-0.5 size-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="leading-4">{uploadError}</span>
        </div>
      ) : null}

      {activity === "preparing" ? (
        <div className="flex min-h-9 items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle
            className="size-4 animate-spin text-primary"
            aria-hidden="true"
          />
          <span role="status">{preparingMessage}</span>
        </div>
      ) : replacementFileId ? (
        <Button
          type="button"
          disabled={isBusy}
          className="rounded-full"
          onClick={() => fileInputRef.current?.click()}
        >
          <FileUp className="size-4" aria-hidden="true" />
          Replace file
        </Button>
      ) : surface === "repositories" ? (
        <Button
          type="button"
          variant="outline"
          disabled={isBusy}
          className="rounded-full"
          onClick={() => folderInputRef.current?.click()}
        >
          <FolderGit2 className="size-4" aria-hidden="true" />
          Import repository
        </Button>
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
            <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
              <FileUp className="size-4" aria-hidden="true" />
              Upload files
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => folderInputRef.current?.click()}>
              <FolderUp className="size-4" aria-hidden="true" />
              Upload folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {surface === "repositories" ? null : (
        <input
          ref={fileInputRef}
          type="file"
          aria-label={
            replacementFileId
              ? "Choose replacement file"
              : "Choose files to upload"
          }
          multiple={!replacementFileId}
          disabled={isBusy}
          className="sr-only"
          tabIndex={-1}
          onChange={handleFileChange}
        />
      )}
      {replacementFileId ? null : (
        <input
          ref={folderInputRef}
          type="file"
          aria-label={
            surface === "repositories"
              ? "Choose a project folder to import"
              : "Choose a folder to upload"
          }
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
      )}

      {uploadSession ? (
        <div className="pointer-events-none fixed inset-x-4 bottom-4 z-40 flex justify-end sm:right-6 sm:left-auto sm:bottom-6">
          <div className="pointer-events-auto">
            <UploadProgressPanel
              key={uploadSession.status}
              session={uploadSession}
              onCancel={cancelUpload}
              onDismiss={dismissUploadSession}
            />
          </div>
        </div>
      ) : null}

      {pendingReplacementUpload ? (
        <FolderReplacementDialog
          pendingUpload={pendingReplacementUpload}
          onClose={closePendingReplacementUpload}
          onReplace={confirmReplacementUpload}
        />
      ) : null}

      {pendingFolderUpload ? (
        <FolderUploadDecisionDialog
          pendingUpload={pendingFolderUpload}
          isCompressing={isCompressing}
          compressionError={compressionError}
          compressionProgress={compressionProgress}
          onClose={closePendingFolderUpload}
          onUploadFolder={uploadPendingFolder}
          onCreateZip={startFolderCompression}
          onCancelCompression={cancelCompression}
        />
      ) : null}
    </div>
  );
}

function FolderReplacementDialog({
  pendingUpload,
  onClose,
  onReplace,
}: {
  pendingUpload: PendingReplacementUpload;
  onClose: () => void;
  onReplace: () => void;
}) {
  const conflictCount = pendingUpload.resolution.conflictPaths.length;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Replace {conflictCount.toLocaleString()} existing{" "}
            {conflictCount === 1 ? "file" : "files"}?
          </DialogTitle>
          <DialogDescription>
            In “{pendingUpload.folderName}”, matching files will be replaced and
            new files will be added. Everything else will stay unchanged.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            className="rounded-md"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="button" className="rounded-md" onClick={onReplace}>
            Replace and upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
              <Progress
                value={progress}
                aria-label="ZIP compression progress"
              />
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
  authHeaders: Record<string, string>,
  signal: AbortSignal,
) {
  const deadline = Date.now() + UPLOAD_FINALIZATION_TIMEOUT_MS;
  let completion = await requestUploadCompletion(completeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
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
      headers: authHeaders,
      signal,
    });
    delayMs = Math.min(
      5_000,
      Math.max(
        delayMs * 1.5,
        completionRetryDelay(completion.retryAfterSeconds),
      ),
    );
  }
}

async function requestUploadCompletion(
  input: string,
  init: RequestInit,
): Promise<UploadCompletion> {
  const response = await fetch(input, init);
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    if (contentType.includes("application/json")) {
      const failure = (await response.json()) as Partial<UploadCompletion>;
      throw new Error(
        failure.status === "aborting" || failure.status === "aborted"
          ? "Upload finalization failed and the stored data is being cleaned up."
          : `Upload finalization failed (${response.status}).`,
      );
    }
    const message = (await response.text()).trim();
    throw new Error(
      message || `Upload finalization failed (${response.status}).`,
    );
  }
  if (!contentType.includes("application/json")) {
    throw new Error(`Upload finalization failed (${response.status}).`);
  }

  const completion = (await response.json()) as Partial<UploadCompletion>;

  if (
    typeof completion.status !== "string" ||
    typeof completion.pollUrl !== "string" ||
    typeof completion.retryAfterSeconds !== "number"
  ) {
    throw new Error(
      "The storage service returned an invalid completion status.",
    );
  }

  return completion as UploadCompletion;
}

function completionRetryDelay(retryAfterSeconds: number) {
  return Math.min(5_000, Math.max(500, retryAfterSeconds * 1_000));
}

async function sha256Base64(blob: Blob) {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "This browser cannot verify upload integrity with SHA-256.",
    );
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

async function putLocalBlobWithRetry(
  url: string,
  file: File,
  headers: Record<string, string>,
  signal: AbortSignal,
  activeRequests: Set<XMLHttpRequest>,
  onProgress: (chunkIndex: number, loaded: number) => void,
) {
  const chunkCount = Math.max(
    1,
    Math.ceil(file.size / LOCAL_UPLOAD_CHUNK_BYTES),
  );

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * LOCAL_UPLOAD_CHUNK_BYTES;
    const end = Math.min(file.size, start + LOCAL_UPLOAD_CHUNK_BYTES);
    const chunk = file.slice(start, end, file.type);

    // Local chunks are serialized so the backend can append and retry them
    // without buffering the complete object in Next.js.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await putBlobWithRetry(
      url,
      chunk,
      {
        ...headers,
        "X-Aeralyth-Upload-Length": String(chunk.size),
        "X-Aeralyth-Upload-Offset": String(start),
      },
      signal,
      activeRequests,
      (loaded) => onProgress(chunkIndex, loaded),
    );
  }
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

      const responseMessage = getObjectUploadFailureMessage(
        request.responseText,
      );
      reject(
        new Error(
          responseMessage
            ? `Object upload failed (${request.status}): ${responseMessage}`
            : `Object upload failed (${request.status}).`,
        ),
      );
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

function getObjectUploadFailureMessage(responseText: string) {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: unknown;
      message?: unknown;
    };
    const message =
      typeof parsed.message === "string"
        ? parsed.message
        : typeof parsed.error === "string"
          ? parsed.error
          : "";
    if (message) {
      return message.slice(0, 300);
    }
  } catch {
    // Plain-text proxy and storage errors are already suitable for display.
  }

  return trimmed.replace(/\s+/g, " ").slice(0, 300);
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
  const roots = new Set<string>();
  for (const path of normalizedPaths) {
    if (!path.includes("/")) continue;
    const root = path.split("/", 1)[0];
    if (root) roots.add(root);
  }
  const fallbackName = `folder-upload-${new Date().toISOString().slice(0, 10)}`;
  const rootName =
    !hasTopLevelFile && roots.size === 1 ? Array.from(roots)[0] : fallbackName;
  const safeName = rootName
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows archive names must exclude ASCII control characters.
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  const archiveBaseName = (safeName || fallbackName).replace(/\.zip$/i, "");

  return `${archiveBaseName}.zip`;
}

function useStableSet<T>(): Set<T> {
  const ref = useRef<Set<T> | null>(null);
  if (ref.current === null) {
    ref.current = new Set<T>();
  }
  return ref.current;
}

function createUploadProgressSession(
  files: UploadSelection[],
  ignoredFiles: number,
): UploadProgressSession {
  const now = Date.now();
  const items = files.map(({ file, relativePath }) => ({
    name: file.name,
    path: relativePath.replaceAll("\\", "/") || file.name,
    sizeBytes: file.size,
  }));

  return {
    items,
    ignoredFiles,
    totalBytes: items.reduce((total, item) => total + item.sizeBytes, 0),
    uploadedBytes: 0,
    completedFiles: 0,
    activeFileIndex: null,
    activeFileUploadedBytes: 0,
    startedAt: now,
    updatedAt: now,
    status: "uploading",
    error: null,
  };
}

function getFolderSelectionName(files: UploadSelection[]) {
  const roots = new Set<string>();
  for (const { relativePath } of files) {
    const root = normalizeUploadPath(relativePath).split("/", 1)[0];
    if (root) roots.add(root);
  }
  return roots.size === 1
    ? (roots.values().next().value ?? "Selected folder")
    : "Selected folder";
}

function formatFolderSelectionSummary(pendingUpload: PendingFolderUpload) {
  const fileCount =
    pendingUpload.files.length === 1
      ? "1 file"
      : `${String(pendingUpload.files.length)} files`;

  const ignoredSummary =
    pendingUpload.ignoredFiles > 0
      ? ` · ${formatIgnoredFiles(pendingUpload.ignoredFiles)} skipped`
      : "";

  return `${fileCount} · ${formatUploadBytes(pendingUpload.totalBytes)}${ignoredSummary}`;
}

function formatIgnoredFiles(fileCount: number) {
  return `${fileCount.toLocaleString()} ${fileCount === 1 ? "file" : "files"}`;
}

function formatCompressionProgress(progress: CompressionProgress) {
  return `${formatUploadBytes(progress.processedBytes)} of ${formatUploadBytes(progress.totalBytes)} processed`;
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

  return `${formattedSize} ${units[unitIndex]}`;
}
