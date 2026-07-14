"use client";

import {
  Check,
  Fingerprint,
  LoaderCircle,
  RotateCcw,
  Share2,
  ShieldAlert,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

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
import {
  fromBase64Url,
  randomPrefixedId,
  type VaultPublicIdentity,
} from "@/features/vault/protocol";
import {
  abortVaultEpochRotation,
  beginVaultEpochRotation,
  createVaultShare,
  getOwnedVaultShares,
  getPendingVaultEpochRotation,
  getVaultIdentity,
  getVaultSharePlan,
  publishVaultEpochRotation,
  trustVaultIdentity,
  type VaultEpochRotationPlan,
  type VaultOwnedShare,
} from "@/features/vault/vault-api";
import { useVault } from "@/features/vault/vault-provider";

export function VaultShareDialog({
  open,
  onOpenChange,
  nodeId,
  nodeName,
  currentUserId,
  csrfToken,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  nodeId: string;
  nodeName: string;
  currentUserId: string;
  csrfToken: string;
}) {
  const vault = useVault();
  const [username, setUsername] = useState("");
  const [identity, setIdentity] = useState<VaultPublicIdentity | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ownedShares, setOwnedShares] = useState<VaultOwnedShare[]>([]);

  useEffect(() => {
    if (!open) return;
    let canceled = false;
    void getOwnedVaultShares()
      .then((shares) => {
        if (!canceled)
          setOwnedShares(shares.filter((share) => share.rootNodeId === nodeId));
      })
      .catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, [nodeId, open]);

  async function lookup(): Promise<void> {
    setBusy(true);
    setError(null);
    setIdentity(null);
    setConfirmed(false);
    try {
      setIdentity(await getVaultIdentity(username.trim()));
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The recipient was not found.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function share(): Promise<void> {
    if (!identity || !confirmed || !vault.client) return;
    setBusy(true);
    setError(null);
    try {
      if (identity.trustStatus !== "accepted") {
        await trustVaultIdentity(csrfToken, identity);
      }
      const plan = await getVaultSharePlan(nodeId);
      for (const node of plan.nodes) await vault.openNode(node.nodeId);
      const shareId = randomPrefixedId("shr_");
      const material = await vault.client.createShareMaterial({
        shareId,
        rootNodeId: nodeId,
        senderId: currentUserId,
        recipient: identity,
        nodes: plan.nodes,
      });
      await createVaultShare(csrfToken, {
        shareId,
        rootNodeId: nodeId,
        recipientId: identity.userId,
        recipientKeyVersion: identity.keyVersion,
        ...material,
      });
      const shares = await getOwnedVaultShares();
      setOwnedShares(shares.filter((share) => share.rootNodeId === nodeId));
      setComplete(true);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The encrypted share could not be created.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function revoke(
    share: VaultOwnedShare,
    recipientId: string,
  ): Promise<void> {
    if (!vault.client) return;
    setBusy(true);
    setError(null);
    let pendingEpoch: number | null = null;
    try {
      const plan = await beginVaultEpochRotation(
        csrfToken,
        share.shareId,
        recipientId,
      );
      pendingEpoch = plan.pendingEpoch;
      await completeRotation(share, plan);
    } catch (failure) {
      if (pendingEpoch !== null) {
        await abortVaultEpochRotation(
          csrfToken,
          share.shareId,
          pendingEpoch,
        ).catch(() => undefined);
      }
      setError(
        failure instanceof Error
          ? failure.message
          : "The recipient could not be revoked.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function resumeRotation(share: VaultOwnedShare): Promise<void> {
    if (!vault.client) return;
    setBusy(true);
    setError(null);
    try {
      const plan = await getPendingVaultEpochRotation(share.shareId);
      await completeRotation(share, plan);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The pending revocation could not be resumed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function cancelRotation(share: VaultOwnedShare): Promise<void> {
    if (share.pendingEpoch === null) return;
    setBusy(true);
    setError(null);
    try {
      await abortVaultEpochRotation(
        csrfToken,
        share.shareId,
        share.pendingEpoch,
      );
      await refreshOwnedShares();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The pending revocation could not be canceled.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function completeRotation(
    share: VaultOwnedShare,
    plan: VaultEpochRotationPlan,
  ): Promise<void> {
    if (!vault.client) throw new Error("Unlock the vault first.");
    for (const node of plan.nodes) await vault.openNode(node.nodeId);
    const material = await vault.client.rotateShareMaterial({
      shareId: share.shareId,
      rootNodeId: nodeId,
      senderId: currentUserId,
      epoch: plan.pendingEpoch,
      recordVersion: plan.recordVersion,
      previousRecordHash: plan.previousRecordHash,
      recipients: plan.retainedRecipients,
      nodes: plan.nodes,
    });
    await publishVaultEpochRotation(
      csrfToken,
      share.shareId,
      plan.pendingEpoch,
      {
        fenceSnapshotHash: plan.fenceSnapshotHash,
        ...material,
      },
    );
    await refreshOwnedShares();
  }

  async function refreshOwnedShares(): Promise<void> {
    const shares = await getOwnedVaultShares();
    setOwnedShares(shares.filter((entry) => entry.rootNodeId === nodeId));
  }

  function close(next: boolean): void {
    if (busy) return;
    onOpenChange(next);
    if (!next) {
      setUsername("");
      setIdentity(null);
      setConfirmed(false);
      setComplete(false);
      setError(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="size-5 text-primary" aria-hidden="true" />
            Share encrypted item
          </DialogTitle>
          <DialogDescription>
            Give read access to {nodeName}. Existing downloaded copies cannot be
            revoked.
          </DialogDescription>
        </DialogHeader>

        {complete ? (
          <>
            <Alert>
              <Check className="size-4" aria-hidden="true" />
              <AlertTitle>Encrypted share created</AlertTitle>
              <AlertDescription>
                The recipient received only the current share-epoch key, not
                your node keys.
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button type="button" onClick={() => close(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            {ownedShares.some((share) => share.recipients.length > 0) ? (
              <div className="space-y-2">
                <Label>People with access</Label>
                {ownedShares.some((share) => share.status === "rotating") ? (
                  <Alert>
                    <RotateCcw className="size-4" aria-hidden="true" />
                    <AlertTitle>Revocation pending</AlertTitle>
                    <AlertDescription>
                      Finish the key rotation to revoke future access, or cancel
                      it to restore uploads.
                    </AlertDescription>
                  </Alert>
                ) : null}
                <div className="divide-y rounded-md border">
                  {ownedShares.flatMap((share) =>
                    share.recipients.map((recipient) => (
                      <div
                        key={`${share.shareId}-${recipient.userId}`}
                        className="flex items-center justify-between gap-3 px-3 py-2"
                      >
                        <span className="truncate text-sm font-medium">
                          {recipient.username}
                        </span>
                        {share.status === "rotating" &&
                        share.pendingRevokedRecipientId === recipient.userId ? (
                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void resumeRotation(share)}
                            >
                              <RotateCcw
                                className="size-4"
                                aria-hidden="true"
                              />
                              Resume
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              disabled={busy}
                              onClick={() => void cancelRotation(share)}
                              aria-label="Cancel pending revocation"
                              title="Cancel pending revocation"
                            >
                              <X className="size-4" aria-hidden="true" />
                            </Button>
                          </div>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            disabled={busy || share.status === "rotating"}
                            onClick={() => void revoke(share, recipient.userId)}
                          >
                            Revoke
                          </Button>
                        )}
                      </div>
                    )),
                  )}
                </div>
              </div>
            ) : null}
            <form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void lookup();
              }}
            >
              <div className="min-w-0 flex-1 space-y-2">
                <Label htmlFor="vault-share-username">Recipient username</Label>
                <Input
                  id="vault-share-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="off"
                  required
                />
              </div>
              <Button
                type="submit"
                variant="secondary"
                disabled={busy || !username.trim()}
              >
                {busy ? (
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  "Find"
                )}
              </Button>
            </form>

            {identity ? (
              <div className="space-y-3 rounded-md border p-4">
                <div className="flex items-start gap-3">
                  <Fingerprint
                    className="mt-0.5 size-5 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="font-medium">{identity.username}</p>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                      {formatFingerprint(identity.fingerprintSha256)}
                    </p>
                  </div>
                </div>
                {identity.trustStatus === "changed" ? (
                  <Alert variant="destructive">
                    <ShieldAlert className="size-4" aria-hidden="true" />
                    <AlertTitle>Identity key changed</AlertTitle>
                    <AlertDescription>
                      Verify this fingerprint with the recipient through another
                      channel before continuing.
                    </AlertDescription>
                  </Alert>
                ) : null}
                <label className="flex cursor-pointer items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-primary"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  <span>
                    I verified this fingerprint belongs to the intended
                    recipient.
                  </span>
                </label>
              </div>
            ) : null}

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
                onClick={() => close(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void share()}
                disabled={busy || !identity || !confirmed}
              >
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function formatFingerprint(value: string): string {
  try {
    const hex = Array.from(fromBase64Url(value), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return hex.match(/.{1,4}/gu)?.join(" ") ?? hex;
  } catch {
    return value;
  }
}
