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
import {
  useRealtimeActivity,
  useRealtimeMutation,
} from "@/features/realtime/realtime-provider";
import { mutateFileTree } from "@/features/vault/vault-api";

/**
 * A repository is its root folder, so deleting it moves that folder to Trash.
 * Restoring the folder from Trash brings the repository back.
 */
export function RepositoryDeleteDialog({
  rootFolderId,
  repositoryName,
  csrfToken,
  disabled,
}: {
  rootFolderId: string;
  repositoryName: string;
  csrfToken: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const beginRealtimeMutation = useRealtimeMutation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useRealtimeActivity(busy);

  async function remove(): Promise<void> {
    setBusy(true);
    setError(null);
    const endRealtimeMutation = beginRealtimeMutation();
    try {
      await mutateFileTree(rootFolderId, "trash", csrfToken);
      setOpen(false);
      router.replace("/repositories");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The repository could not be deleted.",
      );
    } finally {
      endRealtimeMutation();
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
          variant="destructive"
          disabled={disabled}
          aria-label={`Delete ${repositoryName}`}
          title="Delete repository"
        >
          <Trash2 className="size-4" aria-hidden="true" />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Trash2 className="size-7 text-destructive" aria-hidden="true" />
          </AlertDialogMedia>
          <AlertDialogTitle>Delete {repositoryName}?</AlertDialogTitle>
          <AlertDialogDescription>
            The repository folder and all of its files will be moved to Trash.
            Restore the folder from Trash to bring the repository back.
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
            Delete repository
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
