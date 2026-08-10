"use client";

import {
  GitBranch,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Plus,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type FormEvent,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getRepositoryNameError,
  MAX_REPOSITORY_DESCRIPTION_LENGTH,
  MAX_REPOSITORY_NAME_LENGTH,
  normalizeRepositoryName,
} from "@/features/repositories/repository-creation";
import { createEncryptedFolder } from "@/features/vault/encrypted-upload";
import { useVault } from "@/features/vault/vault-provider";

type RepositoryDraft = {
  name: string;
  description: string;
};

type CreatedRepository = {
  id: string;
};

type NewRepositoryDialogProps = {
  ownerUsername: string;
  csrfToken: string;
  e2eeMode: "off" | "migrate" | "required";
};

export function NewRepositoryDialog(props: NewRepositoryDialogProps) {
  const controller = useNewRepositoryDialogController(props);
  return (
    <NewRepositoryDialogView
      ownerUsername={props.ownerUsername}
      {...controller}
    />
  );
}

function useNewRepositoryDialogController({
  csrfToken,
  e2eeMode,
}: NewRepositoryDialogProps) {
  const router = useRouter();
  const vault = useVault();
  const nameId = useId();
  const descriptionId = useId();
  const nameHelpId = useId();
  const nameErrorId = useId();
  const creationErrorId = useId();
  const queuedVaultCreationRef = useRef<RepositoryDraft | null>(null);
  const requestAbortRef = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [creationError, setCreationError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [awaitingVault, setAwaitingVault] = useState(false);

  useEffect(() => {
    return () => requestAbortRef.current?.abort();
  }, []);

  const continueQueuedCreation = useEffectEvent((draft: RepositoryDraft) => {
    void createRepository(draft);
  });

  useEffect(() => {
    const queued = queuedVaultCreationRef.current;
    if (e2eeMode === "off" || vault.state !== "unlocked" || !queued) {
      return;
    }
    queuedVaultCreationRef.current = null;
    continueQueuedCreation(queued);
  }, [e2eeMode, vault.state]);

  function resetForm() {
    queuedVaultCreationRef.current = null;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    setName("");
    setDescription("");
    setNameError(null);
    setCreationError(null);
    setAwaitingVault(false);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (busy) {
      return;
    }
    if (!nextOpen) {
      resetForm();
    }
    setOpen(nextOpen);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextNameError = getRepositoryNameError(name);
    setNameError(nextNameError);
    setCreationError(null);
    if (nextNameError) {
      return;
    }

    const draft = {
      name: normalizeRepositoryName(name),
      description: description.trim(),
    };
    if (e2eeMode !== "off" && vault.state !== "unlocked") {
      queuedVaultCreationRef.current = draft;
      setAwaitingVault(true);
      vault.requestUnlock();
      return;
    }
    void createRepository(draft);
  }

  async function createRepository(draft: RepositoryDraft) {
    if (e2eeMode !== "off" && (vault.state !== "unlocked" || !vault.client)) {
      queuedVaultCreationRef.current = draft;
      setAwaitingVault(true);
      vault.requestUnlock();
      return;
    }

    const controller = new AbortController();
    requestAbortRef.current?.abort();
    requestAbortRef.current = controller;
    setAwaitingVault(false);
    setBusy(true);
    setCreationError(null);

    try {
      let repository: CreatedRepository;
      if (e2eeMode === "off") {
        repository = await requestRepositoryCreation(
          "/api/repositories/empty",
          {
            name: draft.name,
            description: draft.description || null,
          },
          csrfToken,
          controller.signal,
        );
      } else {
        const vaultClient = vault.client;
        if (!vaultClient) {
          throw new Error("The encrypted vault worker is not available.");
        }
        const folder = await createEncryptedFolder({
          name: draft.name,
          csrfToken,
          client: vaultClient,
          signal: controller.signal,
        });
        repository = await requestRepositoryCreation(
          "/api/repositories",
          {
            rootFolderId: folder.nodeId,
            description: draft.description || null,
          },
          csrfToken,
          controller.signal,
        );
      }

      setOpen(false);
      router.push(`/repositories/${encodeURIComponent(repository.id)}`);
    } catch (failure) {
      if (controller.signal.aborted) {
        return;
      }
      setCreationError(
        failure instanceof Error
          ? failure.message
          : "The repository could not be created.",
      );
    } finally {
      if (requestAbortRef.current === controller) {
        requestAbortRef.current = null;
      }
      setBusy(false);
    }
  }

  function handleNameChange(nextName: string) {
    setName(nextName);
    if (nameError) {
      setNameError(getRepositoryNameError(nextName));
    }
  }

  function handleDescriptionChange(nextDescription: string) {
    setDescription(nextDescription);
  }

  return {
    open,
    name,
    description,
    nameError,
    creationError,
    busy,
    awaitingVault,
    nameId,
    descriptionId,
    nameHelpId,
    nameErrorId,
    creationErrorId,
    handleNameChange,
    handleDescriptionChange,
    handleOpenChange,
    handleSubmit,
  };
}

function NewRepositoryDialogView({
  ownerUsername,
  open,
  name,
  description,
  nameError,
  creationError,
  busy,
  awaitingVault,
  nameId,
  descriptionId,
  nameHelpId,
  nameErrorId,
  creationErrorId,
  handleNameChange,
  handleDescriptionChange,
  handleOpenChange,
  handleSubmit,
}: { ownerUsername: string } & ReturnType<
  typeof useNewRepositoryDialogController
>) {
  const fieldsDisabled = busy || awaitingVault;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" className="rounded-full">
          <Plus className="size-4" aria-hidden="true" />
          New repository
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl" showCloseButton={!busy}>
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>Create a new repository</DialogTitle>
            <DialogDescription>
              Start with an empty private repository. You can add files after it
              is created.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-5">
            <div className="grid gap-2">
              <Label htmlFor={nameId}>Repository name</Label>
              <div className="flex min-w-0 items-center rounded-md border bg-background focus-within:border-primary">
                <span className="shrink-0 border-r px-3 text-sm text-muted-foreground">
                  {ownerUsername} /
                </span>
                <Input
                  id={nameId}
                  value={name}
                  onChange={(event) =>
                    handleNameChange(event.currentTarget.value)
                  }
                  autoComplete="off"
                  autoFocus
                  required
                  maxLength={MAX_REPOSITORY_NAME_LENGTH}
                  disabled={fieldsDisabled}
                  aria-invalid={Boolean(nameError)}
                  aria-describedby={`${nameHelpId} ${nameErrorId}`}
                  placeholder="repository-name"
                  className="h-10 rounded-none border-0 bg-transparent px-3 focus-visible:border-transparent"
                />
              </div>
              <p id={nameHelpId} className="text-xs text-muted-foreground">
                Use letters, numbers, periods, hyphens, or underscores.
              </p>
              {nameError ? (
                <p id={nameErrorId} className="text-xs text-destructive">
                  {nameError}
                </p>
              ) : null}
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor={descriptionId}>Description</Label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {description.length}/{MAX_REPOSITORY_DESCRIPTION_LENGTH}
                </span>
              </div>
              <textarea
                id={descriptionId}
                value={description}
                onChange={(event) =>
                  handleDescriptionChange(event.currentTarget.value)
                }
                maxLength={MAX_REPOSITORY_DESCRIPTION_LENGTH}
                rows={3}
                disabled={fieldsDisabled}
                placeholder="What is this repository for? (optional)"
                className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-5 outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary disabled:opacity-60"
              />
            </div>

            <div className="grid gap-3 rounded-md border p-4">
              <div className="flex items-start gap-3">
                <LockKeyhole
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div>
                  <p className="font-medium">Private repository</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Repository access follows your private Aeralyth account.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3 border-t pt-3">
                <GitBranch
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div>
                  <p className="font-medium">Default branch</p>
                  <p className="mt-1 text-xs text-muted-foreground">main</p>
                </div>
              </div>
            </div>

            {creationError ? (
              <p
                id={creationErrorId}
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {creationError}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy}
              aria-describedby={creationError ? creationErrorId : undefined}
            >
              {busy ? (
                <LoaderCircle
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
              ) : awaitingVault ? (
                <KeyRound className="size-4" aria-hidden="true" />
              ) : (
                <Plus className="size-4" aria-hidden="true" />
              )}
              {busy
                ? "Creating repository…"
                : awaitingVault
                  ? "Unlock vault to continue"
                  : "Create repository"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

async function requestRepositoryCreation(
  endpoint: string,
  body: Record<string, string | null>,
  csrfToken: string,
  signal: AbortSignal,
): Promise<CreatedRepository> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new Error(
      message || `Repository creation failed (${response.status}).`,
    );
  }
  const repository = (await response.json()) as Partial<CreatedRepository>;
  if (typeof repository.id !== "string" || !repository.id) {
    throw new Error("The created repository response is invalid.");
  }
  return { id: repository.id };
}
