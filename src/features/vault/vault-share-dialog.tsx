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
import { useEffect, useRef, useState } from "react";
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
import { useRealtimeActivity } from "@/features/realtime/realtime-provider";
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
  getVaultSharePreparationPlans,
  publishVaultEpochRotation,
  trustVaultIdentity,
  type VaultEpochRotationPlan,
  type VaultOwnedShare,
} from "@/features/vault/vault-api";
import { useVault } from "@/features/vault/vault-provider";

type VaultShareDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  nodeId: string;
  nodeName: string;
  currentUserId: string;
  csrfToken: string;
};

export function VaultShareDialog(props: VaultShareDialogProps) {
  const controller = useVaultShareDialogController(props);
  return <VaultShareDialogView {...controller} />;
}

function useVaultShareDialogController({
  open,
  onOpenChange,
  nodeId,
  nodeName,
  currentUserId,
  csrfToken,
}: VaultShareDialogProps) {
  const vault = useVault();
  const [username, setUsername] = useState("");
  const [identity, setIdentity] = useState<VaultPublicIdentity | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sharePreparationProgress, setSharePreparationProgress] = useState<{
    completedNodes: number;
    totalNodes: number;
  } | null>(null);
  useRealtimeActivity(busy);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ownedShares, setOwnedShares] = useState<VaultOwnedShare[]>([]);
  const sharesCursorRef = useRef<string | null>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const activeBusyRequestRef = useRef<number | null>(null);
  const shareRequestRef = useRef(0);
  const [hasMoreShares, setHasMoreShares] = useState(false);
  const [loadingMoreShares, setLoadingMoreShares] = useState(false);

  function beginBusyRequest(): number | null {
    if (activeBusyRequestRef.current !== null) return null;
    if (loadMoreControllerRef.current) {
      loadMoreControllerRef.current.abort();
      loadMoreControllerRef.current = null;
      setLoadingMoreShares(false);
    }
    const requestId = ++shareRequestRef.current;
    activeBusyRequestRef.current = requestId;
    setBusy(true);
    return requestId;
  }

  function finishBusyRequest(requestId: number, clearProgress = false): void {
    if (
      shareRequestRef.current !== requestId ||
      activeBusyRequestRef.current !== requestId
    ) {
      return;
    }
    activeBusyRequestRef.current = null;
    if (clearProgress) setSharePreparationProgress(null);
    setBusy(false);
  }

  useEffect(() => {
    if (!open) return;
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    setLoadingMoreShares(false);
    const controller = new AbortController();
    void getOwnedVaultShares(nodeId, undefined, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setOwnedShares(page.shares);
          sharesCursorRef.current = page.nextCursor;
          setHasMoreShares(page.hasMore);
        }
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      loadMoreControllerRef.current?.abort();
      loadMoreControllerRef.current = null;
      shareRequestRef.current += 1;
      activeBusyRequestRef.current = null;
      setBusy(false);
      setSharePreparationProgress(null);
    };
  }, [nodeId, open]);

  async function lookup(): Promise<void> {
    const requestId = beginBusyRequest();
    if (requestId === null) return;
    setSharePreparationProgress(null);
    setError(null);
    setIdentity(null);
    setConfirmed(false);
    try {
      const nextIdentity = await getVaultIdentity(username.trim());
      if (shareRequestRef.current !== requestId) return;
      setIdentity(nextIdentity);
    } catch (failure) {
      if (shareRequestRef.current === requestId) {
        setError(
          failure instanceof Error
            ? failure.message
            : "The recipient was not found.",
        );
      }
    } finally {
      // This helper resets the loading state only for the request owned by this finally.
      // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally
      finishBusyRequest(requestId);
    }
  }

  async function share(): Promise<void> {
    if (!identity || !confirmed || !vault.client) return;
    const requestId = beginBusyRequest();
    if (requestId === null) return;
    setError(null);
    try {
      if (identity.trustStatus !== "accepted") {
        await trustVaultIdentity(csrfToken, identity);
        if (shareRequestRef.current !== requestId) return;
      }
      const plan = await getVaultSharePlan(nodeId);
      if (shareRequestRef.current !== requestId) return;
      const plans = await getVaultSharePreparationPlans(csrfToken, plan.nodes);
      if (shareRequestRef.current !== requestId) return;
      setSharePreparationProgress({
        completedNodes: 0,
        totalNodes: plan.nodes.length,
      });
      const shareId = randomPrefixedId("shr_");
      const material = await vault.client.createShareMaterial(
        {
          shareId,
          rootNodeId: nodeId,
          senderId: currentUserId,
          recipient: identity,
          nodes: plan.nodes,
          plans,
        },
        {
          onProgress(progress) {
            if (shareRequestRef.current === requestId) {
              setSharePreparationProgress(progress);
            }
          },
        },
      );
      if (shareRequestRef.current !== requestId) return;
      await createVaultShare(csrfToken, {
        shareId,
        rootNodeId: nodeId,
        recipientId: identity.userId,
        recipientKeyVersion: identity.keyVersion,
        ...material,
      });
      if (shareRequestRef.current !== requestId) return;
      await refreshOwnedShares(requestId);
      if (shareRequestRef.current !== requestId) return;
      setComplete(true);
    } catch (failure) {
      if (shareRequestRef.current === requestId) {
        setError(
          failure instanceof Error
            ? failure.message
            : "The encrypted share could not be created.",
        );
      }
    } finally {
      // This helper resets the loading state only for the request owned by this finally.
      // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally
      finishBusyRequest(requestId, true);
    }
  }

  async function revoke(
    share: VaultOwnedShare,
    recipientId: string,
  ): Promise<void> {
    if (!vault.client) return;
    const requestId = beginBusyRequest();
    if (requestId === null) return;
    setSharePreparationProgress(null);
    setError(null);
    let pendingEpoch: number | null = null;
    try {
      const plan = await beginVaultEpochRotation(
        csrfToken,
        share.shareId,
        recipientId,
      );
      pendingEpoch = plan.pendingEpoch;
      await completeRotation(share, plan, requestId);
    } catch (failure) {
      if (pendingEpoch !== null) {
        await abortVaultEpochRotation(
          csrfToken,
          share.shareId,
          pendingEpoch,
        ).catch(() => undefined);
      }
      if (shareRequestRef.current === requestId) {
        setError(
          failure instanceof Error
            ? failure.message
            : "The recipient could not be revoked.",
        );
      }
    } finally {
      // This helper resets the loading state only for the request owned by this finally.
      // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally
      finishBusyRequest(requestId, true);
    }
  }

  async function resumeRotation(share: VaultOwnedShare): Promise<void> {
    if (!vault.client) return;
    const requestId = beginBusyRequest();
    if (requestId === null) return;
    setSharePreparationProgress(null);
    setError(null);
    try {
      const plan = await getPendingVaultEpochRotation(share.shareId);
      await completeRotation(share, plan, requestId);
    } catch (failure) {
      if (shareRequestRef.current === requestId) {
        setError(
          failure instanceof Error
            ? failure.message
            : "The pending revocation could not be resumed.",
        );
      }
    } finally {
      // This helper resets the loading state only for the request owned by this finally.
      // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally
      finishBusyRequest(requestId, true);
    }
  }

  async function cancelRotation(share: VaultOwnedShare): Promise<void> {
    if (share.pendingEpoch === null) return;
    const requestId = beginBusyRequest();
    if (requestId === null) return;
    setError(null);
    try {
      await abortVaultEpochRotation(
        csrfToken,
        share.shareId,
        share.pendingEpoch,
      );
      await refreshOwnedShares(requestId);
    } catch (failure) {
      if (shareRequestRef.current === requestId) {
        setError(
          failure instanceof Error
            ? failure.message
            : "The pending revocation could not be canceled.",
        );
      }
    } finally {
      // This helper resets the loading state only for the request owned by this finally.
      // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally
      finishBusyRequest(requestId);
    }
  }

  async function completeRotation(
    share: VaultOwnedShare,
    plan: VaultEpochRotationPlan,
    requestId: number,
  ): Promise<void> {
    if (!vault.client) throw new Error("Unlock the vault first.");
    const plans = await getVaultSharePreparationPlans(csrfToken, plan.nodes);
    if (shareRequestRef.current === requestId) {
      setSharePreparationProgress({
        completedNodes: 0,
        totalNodes: plan.nodes.length,
      });
    }
    const material = await vault.client.rotateShareMaterial(
      {
        shareId: share.shareId,
        rootNodeId: nodeId,
        senderId: currentUserId,
        epoch: plan.pendingEpoch,
        recordVersion: plan.recordVersion,
        previousRecordHash: plan.previousRecordHash,
        recipients: plan.retainedRecipients,
        nodes: plan.nodes,
        plans,
      },
      {
        onProgress(progress) {
          if (shareRequestRef.current === requestId) {
            setSharePreparationProgress(progress);
          }
        },
      },
    );
    await publishVaultEpochRotation(
      csrfToken,
      share.shareId,
      plan.pendingEpoch,
      {
        fenceSnapshotHash: plan.fenceSnapshotHash,
        ...material,
      },
    );
    await refreshOwnedShares(requestId);
  }

  async function refreshOwnedShares(shareRequestId?: number): Promise<void> {
    const page = await getOwnedVaultShares(nodeId);
    if (
      shareRequestId !== undefined &&
      shareRequestRef.current !== shareRequestId
    ) {
      return;
    }
    setOwnedShares(page.shares);
    sharesCursorRef.current = page.nextCursor;
    setHasMoreShares(page.hasMore);
  }

  async function loadMoreShares(): Promise<void> {
    const cursor = sharesCursorRef.current;
    if (busy || !cursor || loadMoreControllerRef.current) return;
    const requestId = shareRequestRef.current;
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;
    setLoadingMoreShares(true);
    setError(null);
    try {
      const page = await getOwnedVaultShares(nodeId, cursor, controller.signal);
      if (controller.signal.aborted || shareRequestRef.current !== requestId) {
        return;
      }
      setOwnedShares((current) => [
        ...current,
        ...page.shares.filter(
          (share) => !current.some((entry) => entry.shareId === share.shareId),
        ),
      ]);
      sharesCursorRef.current = page.nextCursor;
      setHasMoreShares(page.hasMore);
    } catch (failure) {
      if (!controller.signal.aborted && shareRequestRef.current === requestId) {
        setError(
          failure instanceof Error
            ? failure.message
            : "More encrypted shares could not be loaded.",
        );
      }
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
      }
      if (shareRequestRef.current === requestId) {
        // The controller ref blocks every newer load-more request until this finally runs.
        // react-doctor-disable-next-line react-doctor/no-unowned-async-error-clear, react-doctor/no-loading-flag-reset-outside-finally
        setLoadingMoreShares(false);
      }
    }
  }

  function close(next: boolean): void {
    if (busy) return;
    onOpenChange(next);
    if (!next) {
      loadMoreControllerRef.current?.abort();
      loadMoreControllerRef.current = null;
      shareRequestRef.current += 1;
      setUsername("");
      setIdentity(null);
      setConfirmed(false);
      setComplete(false);
      setError(null);
      setSharePreparationProgress(null);
      setLoadingMoreShares(false);
    }
  }

  return {
    open,
    nodeName,
    username,
    setUsername,
    identity,
    confirmed,
    setConfirmed,
    busy,
    sharePreparationProgress,
    complete,
    error,
    ownedShares,
    hasMoreShares,
    loadingMoreShares,
    loadMoreShares,
    lookup,
    share,
    revoke,
    resumeRotation,
    cancelRotation,
    close,
  };
}

function VaultShareDialogView({
  open,
  nodeName,
  username,
  setUsername,
  identity,
  confirmed,
  setConfirmed,
  busy,
  sharePreparationProgress,
  complete,
  error,
  ownedShares,
  hasMoreShares,
  loadingMoreShares,
  loadMoreShares,
  lookup,
  share,
  revoke,
  resumeRotation,
  cancelRotation,
  close,
}: ReturnType<typeof useVaultShareDialogController>) {
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
            {hasMoreShares ? (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={busy || loadingMoreShares}
                onClick={() => void loadMoreShares()}
              >
                {loadingMoreShares ? (
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : null}
                Load more people
              </Button>
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
                  disabled={busy}
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

            {busy && sharePreparationProgress ? (
              <p
                className="text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                Preparing encrypted wrappers{" "}
                {sharePreparationProgress.completedNodes}/
                {sharePreparationProgress.totalNodes}
              </p>
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
