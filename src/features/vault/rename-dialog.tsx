"use client";

import { LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getItemNameError,
  normalizeItemName,
} from "@/features/vault/vault-rename";

export function RenameDialog({
  itemName,
  itemType,
  siblingNames,
  onRename,
  onClose,
}: {
  itemName: string;
  itemType: "file" | "folder";
  /** Names of the other items shown beside this one. */
  siblingNames: readonly string[];
  /** Resolves once the new name is saved; a rejection keeps the dialog open. */
  onRename(name: string): Promise<void>;
  onClose(): void;
}) {
  const [name, setName] = useState(itemName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Until the field is first edited or clicked, every focus selects the base
  // name, as file managers do. Focus traps that select the whole value on
  // their own refocus run first, so the selection is applied a frame later.
  const pristineRef = useRef(true);
  const selectBaseNameWhilePristine = () => {
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (pristineRef.current && input && document.activeElement === input) {
        selectBaseName(input, itemType);
      }
    });
  };

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const normalized = normalizeItemName(name);
    if (normalized === itemName) {
      onClose();
      return;
    }
    const validation =
      getItemNameError(name) ?? getSiblingConflict(normalized, siblingNames);
    if (validation) {
      setError(validation);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onRename(normalized);
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message
          ? failure.message
          : "The item could not be renamed.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        onOpenAutoFocus={(event) => {
          const input = inputRef.current;
          if (!input) return;
          event.preventDefault();
          input.focus();
        }}
      >
        <form className="grid gap-6" onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>
              Rename {itemType === "folder" ? "folder" : "file"}
            </DialogTitle>
            <DialogDescription className="truncate">
              {itemName}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="rename-item-name">New name</Label>
            <Input
              id="rename-item-name"
              value={name}
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "rename-item-error" : undefined}
              onChange={(event) => {
                pristineRef.current = false;
                setName(event.target.value);
                setError(null);
              }}
              ref={inputRef}
              onFocus={selectBaseNameWhilePristine}
              onPointerDown={() => {
                pristineRef.current = false;
              }}
              onKeyDown={() => {
                pristineRef.current = false;
              }}
            />
            {error ? (
              <p
                id="rename-item-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? (
                <LoaderCircle
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
              ) : null}
              {saving ? "Renaming…" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function getSiblingConflict(
  name: string,
  siblingNames: readonly string[],
): string | null {
  const wanted = name.toLocaleLowerCase();
  return siblingNames.some(
    (sibling) => normalizeItemName(sibling).toLocaleLowerCase() === wanted,
  )
    ? `An item named “${name}” is already here.`
    : null;
}

/** Selects a file's name without its extension, as file managers do. */
function selectBaseName(input: HTMLInputElement, itemType: "file" | "folder") {
  const { value } = input;
  const extensionStart = itemType === "file" ? value.lastIndexOf(".") : -1;
  input.setSelectionRange(
    0,
    extensionStart > 0 ? extensionStart : value.length,
  );
}
