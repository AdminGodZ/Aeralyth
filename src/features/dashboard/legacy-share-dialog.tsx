"use client";

import { CircleCheck, LoaderCircle, Share2 } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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

type LegacyShareResponse = {
  recipientUsername: string;
};

export function LegacyShareDialog({
  open,
  onOpenChange,
  itemId,
  itemName,
  itemType,
  csrfToken,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  itemId: string;
  itemName: string;
  itemType: "file" | "folder";
  csrfToken: string;
}) {
  const [username, setUsername] = useState("");
  const [sharedWith, setSharedWith] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close(nextOpen: boolean): void {
    if (busy) return;
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setUsername("");
      setSharedWith(null);
      setError(null);
    }
  }

  async function share(): Promise<void> {
    const recipient = username.trim();
    if (!recipient) return;

    setBusy(true);
    setError(null);
    try {
      const result = await requestLegacyShare(itemId, recipient, csrfToken);
      setSharedWith(result.recipientUsername);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The item could not be shared.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="size-5 text-primary" aria-hidden="true" />
            Share {itemType}
          </DialogTitle>
          <DialogDescription>
            Give another Aeralyth user read access to {itemName}.
            {itemType === "folder"
              ? " They can browse and download its contents."
              : " They can download the shared file."}
          </DialogDescription>
        </DialogHeader>

        {sharedWith ? (
          <>
            <Alert>
              <CircleCheck className="size-4" aria-hidden="true" />
              <AlertTitle>Shared successfully</AlertTitle>
              <AlertDescription>
                {sharedWith} can now access {itemName}.
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button type="button" onClick={() => close(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void share();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="legacy-share-username">Recipient username</Label>
              <Input
                id="legacy-share-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="off"
                autoFocus
                required
              />
            </div>

            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Sharing failed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => close(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !username.trim()}>
                {busy ? (
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Share2 className="size-4" aria-hidden="true" />
                )}
                Share
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

async function requestLegacyShare(
  itemId: string,
  username: string,
  csrfToken: string,
): Promise<LegacyShareResponse> {
  const response = await fetch(
    `/api/files/${encodeURIComponent(itemId)}/share`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ username, csrf_token: csrfToken }),
    },
  );

  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new Error(message || "The item could not be shared.");
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as Partial<LegacyShareResponse>;
    if (typeof payload.recipientUsername === "string") {
      return { recipientUsername: payload.recipientUsername };
    }
    throw new Error("The share response was invalid.");
  }

  if (response.redirected) {
    const responseUrl = new URL(response.url);
    if (responseUrl.pathname === "/files") {
      const result = responseUrl.searchParams.get("file");
      if (result === "shared") return { recipientUsername: username };
      if (result === "share-invalid")
        throw new Error("Enter a valid username.");
      if (result === "share-user-missing") throw new Error("User not found.");
      if (result === "share-self") {
        throw new Error("You cannot share an item with yourself.");
      }
      if (result === "encrypted-share-required") {
        throw new Error("Encrypt this item before sharing it.");
      }
    }
  }

  throw new Error("The share endpoint returned an invalid response.");
}
