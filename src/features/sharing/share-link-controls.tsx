"use client";

import { LoaderCircle, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { UploadPanel } from "@/features/dashboard/upload-panel";
import { VaultProvider } from "@/features/vault/vault-provider";

export function ShareEditorUpload({
  token,
  parentFolderId,
  replacementFileId,
}: {
  token: string;
  parentFolderId?: string | null;
  replacementFileId?: string;
}) {
  return (
    <VaultProvider
      csrfToken=""
      e2eeMode="off"
      vaultConfigured={false}
      autoLockMinutes={15}
    >
      <UploadPanel
        shareToken={token}
        replacementFileId={replacementFileId}
        e2eeMode="off"
        parentFolderId={parentFolderId}
        folderZipPromptEnabled={false}
      />
    </VaultProvider>
  );
}

export function SharedEntryDeleteButton({
  token,
  entryId,
  entryName,
  entryType,
}: {
  token: string;
  entryId: string;
  entryName: string;
  entryType: "file" | "folder";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        "/api/share-links/access/" +
          encodeURIComponent(token) +
          "/files/" +
          encodeURIComponent(entryId),
        {
          method: "DELETE",
          headers: { "X-Aeralyth-Share-Token": token },
        },
      );
      if (!response.ok) {
        const message = (await response.text()).trim();
        throw new Error(message || "The item could not be removed.");
      }
      setOpen(false);
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The item could not be removed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) setOpen(nextOpen);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-destructive hover:text-destructive"
          aria-label={`Remove ${entryName}`}
          title={`Remove ${entryName}`}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Trash2 className="size-7 text-destructive" aria-hidden="true" />
          </AlertDialogMedia>
          <AlertDialogTitle>Remove {entryName}?</AlertDialogTitle>
          <AlertDialogDescription>
            {entryType === "folder"
              ? "This folder and its contents will be moved to the owner's trash."
              : "This file will be moved to the owner's trash."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              void remove();
            }}
          >
            {busy ? (
              <LoaderCircle
                className="size-4 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Trash2 className="size-4" aria-hidden="true" />
            )}
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
