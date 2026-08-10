"use client";

import { Check, LoaderCircle, Pencil, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

const MAX_DESCRIPTION_LENGTH = 350;

export function RepositoryDescription({
  repositoryId,
  initialDescription,
  csrfToken,
}: {
  repositoryId: string;
  initialDescription: string | null;
  csrfToken: string;
}) {
  const router = useRouter();
  const [description, setDescription] = useState(initialDescription ?? "");
  const [draft, setDraft] = useState(description);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveDescription() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/repositories/${encodeURIComponent(repositoryId)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({ description: draft }),
        },
      );
      if (!response.ok) {
        const message = (await response.text()).trim();
        throw new Error(
          message ||
            `Repository description update failed (${response.status}).`,
        );
      }
      const updated = (await response.json()) as { description?: unknown };
      if (
        typeof updated.description !== "string" &&
        updated.description !== null
      ) {
        throw new Error("The updated repository response is invalid.");
      }
      const nextDescription = updated.description ?? "";
      setDescription(nextDescription);
      setDraft(nextDescription);
      setEditing(false);
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The repository description could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }

  function cancelEditing() {
    setDraft(description);
    setError(null);
    setEditing(false);
  }

  return (
    <section>
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h2 className="font-display text-base font-semibold">About</h2>
        {!editing ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Edit repository description"
            title="Edit repository description"
            onClick={() => setEditing(true)}
          >
            <Pencil className="size-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {editing ? (
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void saveDescription();
          }}
        >
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            maxLength={MAX_DESCRIPTION_LENGTH}
            rows={4}
            aria-label="Repository description"
            aria-describedby="repository-description-count repository-description-error"
            disabled={busy}
            placeholder="Describe this repository…"
            className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-5 outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary disabled:opacity-60"
          />
          <div className="flex items-center justify-between gap-3">
            <span
              id="repository-description-count"
              className="text-xs tabular-nums text-muted-foreground"
            >
              {draft.length}/{MAX_DESCRIPTION_LENGTH}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={cancelEditing}
                disabled={busy}
              >
                <X className="size-3.5" aria-hidden="true" />
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" aria-hidden="true" />
                )}
                Save
              </Button>
            </div>
          </div>
          <p
            id="repository-description-error"
            className="text-xs text-destructive"
            aria-live="polite"
          >
            {error}
          </p>
        </form>
      ) : (
        <p
          className={
            description
              ? "mt-3 text-sm leading-6"
              : "mt-3 text-sm leading-6 text-muted-foreground"
          }
        >
          {description || "No description provided."}
        </p>
      )}
    </section>
  );
}
