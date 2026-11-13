"use client";

import {
  ChevronDown,
  CircleAlert,
  FileArchive,
  FileUp,
  Folder,
  FolderUp,
  UploadCloud,
  X,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { GhostLoader } from "@/components/ghost-mascot";
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
  normalizeUploadPath,
  resolveFolderUploadConflicts,
  type UploadTreeEntry,
} from "@/features/dashboard/folder-upload-conflicts";
import type { FolderZipWorkerResponse } from "@/features/dashboard/folder-zip-messages";
import {
  type LegacyFolderManifest,
  legacyUploadTarget,
  needsLegacyFolderManifest,
  resolveLegacyFolderManifest,
} from "@/features/dashboard/legacy-folder-manifest";
import { scheduleLegacyUploads } from "@/features/dashboard/legacy-upload-scheduler";
import { sha256BlobBase64 } from "@/features/dashboard/upload-checksum-client";
import { UploadExclusionReviewDialog } from "@/features/dashboard/upload-exclusion-review-dialog";
import {
  UploadProgressPanel,
  type UploadProgressSession,
} from "@/features/dashboard/upload-progress-panel";
import {
  finalizeFolderUploadSelection,
  getUploadSelectionError,
  MAX_UPLOAD_BYTES,
  type PreparedFolderUploadSelection,
  prepareFolderUploadSelection,
} from "@/features/dashboard/upload-selection-policy";
import {
  useRealtimeActivity,
  useRealtimeRefresh,
} from "@/features/realtime/realtime-provider";
import { createAnimationFrameProgressCoalescer } from "@/features/uploads/progress-coalescer";
import {
  getUploadFailureMessage,
  runUploadWithRetry,
  UploadRequestError,
  waitForUploadRetry,
} from "@/features/uploads/upload-retry";
import {
  mapWithConcurrency,
  WeightedSemaphore,
} from "@/features/vault/bounded-async";
import { uploadEncryptedSelections } from "@/features/vault/encrypted-upload";
import type { VaultMetadataReference } from "@/features/vault/protocol";
import {
  getVaultDownloadPlan,
  getVaultMetadataPlans,
} from "@/features/vault/vault-api";
import { useVault } from "@/features/vault/vault-provider";
import { FOLDER_ZIP_WORKER_URL } from "@/generated/worker-assets";
import { isAbortError } from "@/lib/abort";

type UploadSelection = {
  file: File;
  relativePath: string;
};

type PendingUploadExclusionReview = {
  prepared: PreparedFolderUploadSelection<UploadSelection>;
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
  ignoredFiles: number;
  resolution: FolderUploadResolution;
};

type QueuedUpload = {
  files: UploadSelection[];
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
};

type UploadChildrenPage = {
  entries: Array<{
    id: string;
    name: string;
    entryType: "file" | "folder";
    e2eeState: "legacy" | "staged" | "encrypted";
    parentId?: string | null;
    vaultRecordVersion?: number | null;
    vaultRecordHash?: string | null;
    vaultGenerationId?: string | null;
  }>;
  nextCursor: string | null;
  hasMore: boolean;
};

const MULTIPART_CONCURRENCY = 4;
const MULTIPART_PRESIGN_BATCH_SIZE = 8;
const LOCAL_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const UPLOAD_FINALIZATION_TIMEOUT_MS = 45_000;
const UPLOAD_LIST_REFRESH_WAIT_MS = 10_000;
const UPLOAD_TREE_PAGE_SIZE = 100;
const UPLOAD_TREE_DECRYPT_CONCURRENCY = 8;
const UPLOAD_REPLACEMENT_PLAN_BATCH_SIZE = 100;

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
}: UploadPanelProps) {
  const refreshRoute = useRealtimeRefresh();
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
  const [pendingUploadExclusionReview, setPendingUploadExclusionReview] =
    useState<PendingUploadExclusionReview | null>(null);
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
  useRealtimeActivity(
    isBusy ||
      pendingUploadExclusionReview !== null ||
      pendingFolderUpload !== null ||
      pendingReplacementUpload !== null,
  );
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
          queued.upload.ignoredFiles,
          queued.upload.replacementConfirmed,
        );
        return;
      }
      submitFiles(
        queued.upload.files,
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
    void uploadSelections(files, resolution);
  }

  async function uploadSelections(
    files: UploadSelection[],
    resolution?: FolderUploadResolution,
  ) {
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    const uploadedByPart = new Map<string, number>();
    const uploadedByFile = new Map<number, number>();
    const completedFileIndexes = new Set<number>();
    const activeFileIndexes = new Set<number>();
    let uploadedBytes = 0;
    let activeFileIndex: number | null = null;
    let failedFileIndex: number | null = null;

    // Snapshots are taken when a frame is delivered, not for every transition
    // it replaces: copying the file-index sets is linear in the selection.
    const progressPublisher = createAnimationFrameProgressCoalescer(
      (
        takeSnapshot: () => {
          activeFileIndex: number | null;
          activeFileUploadedBytes: number;
          completedFiles: number;
          completedFileIndexes: number[];
          activeFileIndexes: number[];
          totalBytes?: number;
          uploadedBytes: number;
        },
      ) => {
        const snapshot = takeSnapshot();
        setUploadSession((current) =>
          current?.status === "uploading"
            ? {
                ...current,
                ...(snapshot.totalBytes === undefined
                  ? {}
                  : { totalBytes: snapshot.totalBytes }),
                uploadedBytes: Math.min(
                  snapshot.totalBytes ?? current.totalBytes,
                  snapshot.uploadedBytes,
                ),
                completedFiles: snapshot.completedFiles,
                completedFileIndexes: snapshot.completedFileIndexes,
                activeFileIndexes: snapshot.activeFileIndexes,
                activeFileIndex: snapshot.activeFileIndex,
                activeFileUploadedBytes: snapshot.activeFileUploadedBytes,
                updatedAt: Date.now(),
              }
            : current,
        );
      },
    );
    let publishedTotalBytes: number | undefined;
    const takeProgressSnapshot = () => {
      const fileBytes =
        activeFileIndex === null
          ? 0
          : (uploadedByFile.get(activeFileIndex) ?? 0);
      return {
        activeFileIndex,
        activeFileUploadedBytes:
          activeFileIndex === null
            ? 0
            : Math.min(
                files[activeFileIndex]?.file.size ?? fileBytes,
                fileBytes,
              ),
        completedFiles: completedFileIndexes.size,
        completedFileIndexes: Array.from(completedFileIndexes),
        activeFileIndexes: Array.from(activeFileIndexes),
        totalBytes: publishedTotalBytes,
        uploadedBytes,
      };
    };
    const publishProgress = (immediate = false, totalBytes?: number) => {
      publishedTotalBytes = totalBytes ?? publishedTotalBytes;
      progressPublisher.publish(takeProgressSnapshot, immediate);
    };

    // File transitions arrive far faster than frames once small files publish
    // in batches, so they share the coalesced progress frame.
    const startFile = (fileIndex: number) => {
      activeFileIndexes.add(fileIndex);
      activeFileIndex = fileIndex;
      publishProgress();
    };
    const reportProgress = (fileIndex: number, key: string, loaded: number) => {
      activeFileIndex = fileIndex;
      const previousPartBytes = uploadedByPart.get(key) ?? 0;
      const nextPartBytes = Math.max(previousPartBytes, loaded);
      const delta = nextPartBytes - previousPartBytes;
      uploadedByPart.set(key, nextPartBytes);
      uploadedBytes += delta;
      const fileBytes = (uploadedByFile.get(fileIndex) ?? 0) + delta;
      uploadedByFile.set(fileIndex, fileBytes);
      publishProgress();
    };
    const completeFile = (fileIndex: number) => {
      const fileSize = files[fileIndex]?.file.size ?? 0;
      const recordedBytes = uploadedByFile.get(fileIndex) ?? 0;
      uploadedBytes += Math.max(0, fileSize - recordedBytes);
      uploadedByFile.set(fileIndex, fileSize);
      completedFileIndexes.add(fileIndex);
      activeFileIndexes.delete(fileIndex);
      if (activeFileIndex === fileIndex) {
        activeFileIndex = Array.from(activeFileIndexes).at(-1) ?? null;
      }
      publishProgress();
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
        await uploadEncryptedSelections({
          selections: files,
          parentFolderId: parentFolderId ?? null,
          resolution,
          csrfToken,
          client: vault.client,
          signal: controller.signal,
          onFileStart: startFile,
          onFileComplete: completeFile,
          onFileError: (fileIndex) => {
            failedFileIndex = fileIndex;
          },
          onProgress: (
            processedBytes,
            encryptedTotalBytes,
            fileIndex,
            fileProcessedBytes,
          ) => {
            activeFileIndex = fileIndex;
            uploadedBytes = processedBytes;
            uploadedByFile.set(fileIndex, fileProcessedBytes);
            publishProgress(false, encryptedTotalBytes);
          },
        });
        progressPublisher.flush();
        await finishSuccessfulUpload(controller.signal);
        return;
      }

      const relativePaths = files.map(({ relativePath }) => relativePath);
      const folderManifest = needsLegacyFolderManifest(relativePaths)
        ? await resolveLegacyFolderManifest(
            relativePaths,
            (batchRelativePaths) =>
              requestJson<LegacyFolderManifest>("/api/files/folder-manifests", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...requestAuthHeaders,
                },
                body: JSON.stringify({
                  relativePaths: batchRelativePaths,
                  parentId: parentFolderId ?? null,
                }),
                signal: controller.signal,
              }),
          )
        : null;
      const multipartSlots = new WeightedSemaphore(MULTIPART_CONCURRENCY);
      await scheduleLegacyUploads(
        Array.from(files.entries()),
        controller.signal,
        ([, selection]) => selection.file.size,
        async ([fileIndex, selection], signal) => {
          startFile(fileIndex);
          let uploadedRootFolderId: string | null;
          try {
            uploadedRootFolderId = await uploadSelection(
              selection,
              fileIndex,
              resolution,
              folderManifest?.parentIds[fileIndex],
              signal,
              multipartSlots,
              (key, loaded) => reportProgress(fileIndex, key, loaded),
            );
          } catch (error) {
            if (!signal.aborted) failedFileIndex ??= fileIndex;
            throw error;
          }
          completeFile(fileIndex);
          return uploadedRootFolderId;
        },
      );
      progressPublisher.flush();
      await finishSuccessfulUpload(controller.signal);
    } catch (uploadFailure) {
      uploadAbortRef.current = null;

      if (controller.signal.aborted || isAbortError(uploadFailure)) {
        setIsUploading(false);
        setUploadSession(null);
        return;
      }

      activeFileIndex = failedFileIndex ?? activeFileIndex;
      publishProgress(true);
      finishUploadWithError(
        getUploadFailureMessage(uploadFailure),
        activeFileIndex,
      );
    } finally {
      progressPublisher.cancel();
    }
  }

  async function finishSuccessfulUpload(signal: AbortSignal) {
    // The upload is committed, so this refresh will include it. Keep the
    // finalizing panel up until the list shows it instead of leaving a gap.
    await waitForListRefresh(
      refreshRoute([{ scope: "files", folderIds: [parentFolderId ?? ""] }]),
      signal,
    );
    setIsUploading(false);
    setUploadSession(null);
    uploadAbortRef.current = null;
  }

  async function uploadSelection(
    selection: UploadSelection,
    fileIndex: number,
    resolution: FolderUploadResolution | undefined,
    resolvedParentId: string | null | undefined,
    signal: AbortSignal,
    multipartSlots: WeightedSemaphore,
    reportProgress: (key: string, loaded: number) => void,
  ) {
    if (selection.file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`${selection.file.name} exceeds the 2 GB upload limit.`);
    }

    const target = legacyUploadTarget({
      relativePath: selection.relativePath,
      fileName: selection.file.name,
      baseParentId: parentFolderId ?? null,
      resolvedParentId,
    });
    const plan = await requestJson<UploadPlan>("/api/files/uploads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...requestAuthHeaders,
      },
      body: JSON.stringify({
        name: selection.file.name,
        relativePath: target.relativePath,
        sizeBytes: selection.file.size,
        mimeType: selection.file.type || null,
        parentId: target.parentId,
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
          // Batches stay sequential to cap hashing blobs, signed URLs, and uploads in memory.
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          const prepared = await mapWithConcurrency(
            batch,
            MULTIPART_CONCURRENCY,
            async (part) => {
              const start = (part.partNumber - 1) * partSizeBytes;
              const end = Math.min(start + partSizeBytes, selection.file.size);
              const blob = selection.file.slice(start, end, "");
              const checksumSha256 = await sha256BlobBase64(blob, signal);
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
              const releasePartSlot = await multipartSlots.acquire(1, signal);
              let response: XMLHttpRequest;
              try {
                response = await putBlobWithRetry(
                  signedPart.url,
                  part.blob,
                  { "x-amz-checksum-sha256": part.checksumSha256 },
                  signal,
                  activeUploadRequests,
                  (loaded) => reportProgress(progressKey, loaded),
                  async () => {
                    const refreshed = await requestLegacySignedUploadUrl(
                      `/api/files/uploads/${encodeURIComponent(plan.uploadId)}/parts/${part.partNumber}`,
                      part.checksumSha256,
                      requestAuthHeaders,
                      signal,
                    );
                    assertSignedUploadLength(refreshed, part.blob.size);
                    return refreshed.url;
                  },
                );
              } finally {
                releasePartSlot();
              }
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
          plan.mode === "single"
            ? await sha256BlobBase64(selection.file, signal)
            : null;
        const signedUpload =
          plan.mode === "single"
            ? await requestLegacySignedUploadUrl(
                `/api/files/uploads/${encodeURIComponent(plan.uploadId)}/content-url`,
                checksumSha256 as string,
                requestAuthHeaders,
                signal,
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
            async () => {
              const refreshed = await requestLegacySignedUploadUrl(
                `/api/files/uploads/${encodeURIComponent(plan.uploadId)}/content-url`,
                checksumSha256 as string,
                requestAuthHeaders,
                signal,
              );
              assertSignedUploadLength(refreshed, selection.file.size);
              return refreshed.url;
            },
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
      if (signal.aborted || !completionStarted) {
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

    if (folderSelection) {
      setPreparingMessage("Checking upload exclusions");
      setIsPreparingSelection(true);
      let prepared: PreparedFolderUploadSelection<UploadSelection>;
      try {
        prepared = await prepareFolderUploadSelection(files);
      } catch (error) {
        setUploadError(
          error instanceof Error && error.message
            ? error.message
            : "The upload exclusion rules could not be read.",
        );
        return;
      } finally {
        setIsPreparingSelection(false);
      }

      if (prepared.error) {
        setUploadError(prepared.error);
        return;
      }

      if (prepared.reviewItems.length > 0) {
        setPendingUploadExclusionReview({ prepared });
        return;
      }

      if (prepared.files.length === 0) {
        setUploadError("No uploadable files remain in this folder.");
        return;
      }

      queueFolderOrUpload(prepared.files);
      return;
    }

    queueFolderOrUpload(files);
  }

  function confirmUploadExclusionReview(selectedFiles: UploadSelection[]) {
    if (!pendingUploadExclusionReview) return;

    const finalized = finalizeFolderUploadSelection(
      pendingUploadExclusionReview.prepared,
      selectedFiles,
    );
    if (finalized.error) {
      setUploadError(finalized.error);
      return;
    }

    setPendingUploadExclusionReview(null);
    queueFolderOrUpload(finalized.files, finalized.ignoredFiles);
  }

  function queueFolderOrUpload(files: UploadSelection[], ignoredFiles = 0) {
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
      void prepareFolderUpload(files, ignoredFiles);
      return;
    }

    submitFiles(files, ignoredFiles);
  }

  async function prepareFolderUpload(
    files: UploadSelection[],
    ignoredFiles: number,
    replacementConfirmed = false,
  ) {
    if (e2eeMode !== "off" && vault.state !== "unlocked") {
      queuedVaultActionRef.current = {
        kind: "prepare-folder",
        upload: {
          files,
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
      if (e2eeMode !== "off") {
        await loadReplacementGenerations(resolution, controller.signal);
      }

      if (resolution.conflictPaths.length > 0 && !replacementConfirmed) {
        setPendingReplacementUpload({
          files,
          folderName: getFolderSelectionName(files),
          ignoredFiles,
          resolution,
        });
        return;
      }

      submitFiles(files, ignoredFiles, resolution, replacementConfirmed);
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

    if (!vault.client && listed.some(isEncryptedListing)) {
      throw new Error("Unlock the vault before checking existing files.");
    }
    // Names come from the signed records the listing already identifies, one
    // batched metadata request per hundred entries and none for cached ones.
    const references = listed.flatMap((entry) => {
      const reference = uploadTreeMetadataReference(entry);
      return reference ? [reference] : [];
    });
    const manifests = new Map(
      (references.length > 0
        ? await vault.resolveMetadata(references, { signal })
        : []
      ).map((result) => [result.nodeId, result]),
    );

    return mapWithConcurrency(
      listed,
      UPLOAD_TREE_DECRYPT_CONCURRENCY,
      async (entry): Promise<UploadTreeEntry> => {
        if (entry.e2eeState !== "encrypted") {
          return entry;
        }
        const resolved = manifests.get(entry.id);
        if (resolved) {
          if (resolved.status !== "ready") {
            throw new Error(
              "An existing encrypted item could not be read. Refresh the page, then upload the folder again.",
            );
          }
          if (resolved.manifest.entryType !== entry.entryType) {
            throw new Error("An encrypted file record has an invalid type.");
          }
          return {
            id: entry.id,
            entryType: entry.entryType,
            e2eeState: entry.e2eeState,
            name: resolved.manifest.name,
            recordVersion: entry.vaultRecordVersion as number,
            recordHash: resolved.recordHash,
          };
        }
        // A listing without record identifiers still resolves entry by entry.
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

  /**
   * A replacement continues the generation of the file it replaces. Only the
   * matched files need that number, so it is read for them in batches after
   * the conflicts are known instead of once per listed entry.
   */
  async function loadReplacementGenerations(
    resolution: FolderUploadResolution,
    signal: AbortSignal,
  ) {
    const pending = Array.from(resolution.replacementFiles.values()).filter(
      (file) =>
        file.e2eeState === "encrypted" && file.generationNumber === undefined,
    );
    if (pending.length === 0) return;
    if (!csrfToken) {
      throw new Error("The encrypted upload session is unavailable.");
    }
    const byId = new Map(pending.map((file) => [file.id, file]));
    for (
      let offset = 0;
      offset < pending.length;
      offset += UPLOAD_REPLACEMENT_PLAN_BATCH_SIZE
    ) {
      const nodeIds = pending
        .slice(offset, offset + UPLOAD_REPLACEMENT_PLAN_BATCH_SIZE)
        .map((file) => file.id);
      let continuation: number | undefined;
      do {
        // Each continuation is issued by the previous page of the same batch.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const page = await getVaultMetadataPlans(
          csrfToken,
          nodeIds,
          continuation,
          signal,
        );
        for (const plan of page.plans) {
          const file = byId.get(plan.nodeId);
          if (!file) continue;
          if (
            plan.recordHash !== file.recordHash ||
            plan.recordVersion !== file.recordVersion
          ) {
            throw new Error(
              `“${file.name}” changed while the upload was being prepared. Upload the folder again.`,
            );
          }
          file.generationNumber = plan.generationNumber;
        }
        if (
          page.continuation !== undefined &&
          (!Number.isSafeInteger(page.continuation) ||
            page.continuation <= (continuation ?? -1))
        ) {
          throw new Error("The existing file listing could not be continued.");
        }
        continuation = page.continuation;
      } while (continuation !== undefined);
    }
    // getEncryptedReplacementVersion rejects any file still left without one.
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
    submitFiles(pending.files, pending.ignoredFiles, pending.resolution, true);
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
      worker = new Worker(FOLDER_ZIP_WORKER_URL, {
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
    const failZipWorker = () => {
      if (zipWorkerRef.current !== worker) return;
      worker.terminate();
      zipWorkerRef.current = null;
      setIsCompressing(false);
      setCompressionError(
        "The ZIP worker could not run. Upload the folder without compression, or reload the application and select the folder again.",
      );
    };
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      failZipWorker();
    });
    worker.addEventListener("messageerror", failZipWorker);
    try {
      worker.postMessage({
        type: "compress",
        compressionMode: "speed",
        sources: pendingFolderUpload.files.map(({ file, relativePath }) => ({
          file,
          path: relativePath,
        })),
      });
    } catch {
      failZipWorker();
    }
  }

  function uploadPendingFolder() {
    if (!pendingFolderUpload || isCompressing) {
      return;
    }

    const files = pendingFolderUpload.files;
    const ignoredFiles = pendingFolderUpload.ignoredFiles;
    setPendingFolderUpload(null);
    void prepareFolderUpload(files, ignoredFiles);
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
    pendingUploadExclusionReview,
    pendingFolderUpload,
    pendingReplacementUpload,
    compressionError,
    compressionProgress,
    closePendingUploadExclusionReview: () =>
      setPendingUploadExclusionReview(null),
    closePendingFolderUpload: () => setPendingFolderUpload(null),
    closePendingReplacementUpload: () => setPendingReplacementUpload(null),
    confirmReplacementUpload,
    confirmUploadExclusionReview,
    uploadPendingFolder,
    startFolderCompression,
    cancelCompression,
    cancelUpload,
    dismissUploadSession: () => setUploadSession(null),
    replacementFileId,
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
  pendingUploadExclusionReview,
  pendingFolderUpload,
  pendingReplacementUpload,
  compressionError,
  compressionProgress,
  closePendingUploadExclusionReview,
  closePendingFolderUpload,
  closePendingReplacementUpload,
  confirmReplacementUpload,
  confirmUploadExclusionReview,
  uploadPendingFolder,
  startFolderCompression,
  cancelCompression,
  cancelUpload,
  dismissUploadSession,
  replacementFileId,
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
        <GhostLoader label={preparingMessage} />
      ) : replacementFileId ? (
        <Button
          type="button"
          disabled={isBusy}
          onClick={() => fileInputRef.current?.click()}
        >
          <FileUp className="size-4" aria-hidden="true" />
          Replace file
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" disabled={isBusy}>
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
      {replacementFileId ? null : (
        <input
          ref={folderInputRef}
          type="file"
          aria-label="Choose a folder to upload"
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

      {pendingUploadExclusionReview ? (
        <UploadExclusionReviewDialog
          items={pendingUploadExclusionReview.prepared.reviewItems}
          autoIncludedFiles={pendingUploadExclusionReview.prepared.files}
          gitIgnoreFileCount={
            pendingUploadExclusionReview.prepared.gitIgnoreFileCount
          }
          onClose={closePendingUploadExclusionReview}
          onContinue={confirmUploadExclusionReview}
        />
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
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={onReplace}>
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
              <Button type="button" variant="secondary" onClick={onClose}>
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

    await waitForUploadRetry(delayMs, signal);
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

/** A hidden tab or slow route must not hold the finished upload panel open. */
function waitForListRefresh(
  refresh: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Upload canceled", "AbortError"));
      return;
    }
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Upload canceled", "AbortError"));
    };
    const timeout = setTimeout(finish, UPLOAD_LIST_REFRESH_WAIT_MS);
    signal.addEventListener("abort", abort, { once: true });
    void refresh.then(finish);
  });
}

async function putBlobWithRetry(
  url: string,
  blob: Blob,
  headers: Record<string, string>,
  signal: AbortSignal,
  activeRequests: Set<XMLHttpRequest>,
  onProgress: (loaded: number) => void,
  refreshUrl?: () => Promise<string>,
) {
  return runUploadWithRetry({
    initialUrl: url,
    onAttemptStart: () => onProgress(0),
    refreshUrl,
    request: (candidateUrl) =>
      putBlobOnce(
        candidateUrl,
        blob,
        headers,
        signal,
        activeRequests,
        onProgress,
      ),
    signal,
  });
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
        new UploadRequestError({
          message: responseMessage
            ? `Object upload failed (${request.status}): ${responseMessage}`
            : `Object upload failed (${request.status}).`,
          networkFailure: request.status === 0,
          responseBody: request.responseText,
          retryAfter: request.getResponseHeader("Retry-After"),
          status: request.status || null,
        }),
      );
    });
    request.addEventListener("error", () => {
      cleanup();
      reject(
        new UploadRequestError({
          message: "The storage service could not be reached.",
          networkFailure: true,
        }),
      );
    });
    request.addEventListener("abort", () => {
      cleanup();
      reject(new DOMException("Upload canceled", "AbortError"));
    });
    signal.addEventListener("abort", abortRequest, { once: true });
    request.send(blob);
  });
}

function isEncryptedListing(entry: UploadChildrenPage["entries"][number]) {
  return entry.e2eeState === "encrypted";
}

function uploadTreeMetadataReference(
  entry: UploadChildrenPage["entries"][number],
): VaultMetadataReference | null {
  if (
    entry.e2eeState !== "encrypted" ||
    !(typeof entry.parentId === "string" || entry.parentId === null) ||
    typeof entry.vaultRecordVersion !== "number" ||
    typeof entry.vaultRecordHash !== "string" ||
    typeof entry.vaultGenerationId !== "string"
  ) {
    return null;
  }
  return {
    nodeId: entry.id,
    parentId: entry.parentId,
    recordVersion: entry.vaultRecordVersion,
    recordHash: entry.vaultRecordHash,
    generationId: entry.vaultGenerationId,
  };
}

function requestLegacySignedUploadUrl(
  path: string,
  checksumSha256: string,
  authHeaders: Record<string, string>,
  signal: AbortSignal,
) {
  return requestJson<UploadUrl>(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({ checksumSha256 }),
    signal,
  });
}

function assertSignedUploadLength(upload: UploadUrl, expectedBytes: number) {
  if (upload.contentLength !== expectedBytes) {
    throw new Error(
      "The storage service returned an invalid signed upload length.",
    );
  }
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
    completedFileIndexes: [],
    activeFileIndexes: [],
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
      ? ` · ${formatIgnoredFiles(pendingUpload.ignoredFiles)} excluded`
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
