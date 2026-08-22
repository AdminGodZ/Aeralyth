"use client";

import { LoaderCircle, LockKeyhole, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { migrateEncryptedNode } from "@/features/vault/encrypted-upload";
import {
  claimVaultMigration,
  getVaultStatus,
  type VaultStatus,
} from "@/features/vault/vault-api";
import { useVault } from "@/features/vault/vault-provider";

export function VaultMigrationControl({ csrfToken }: { csrfToken: string }) {
  const vault = useVault();
  const router = useRouter();
  const abortRef = useRef<AbortController | null>(null);
  const [migration, setMigration] = useState<VaultStatus["migration"] | null>(
    null,
  );
  const queuedRef = useRef(false);
  const [running, setRunning] = useState(false);
  const [currentName, setCurrentName] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const runMigration = useCallback(async (): Promise<void> => {
    if (abortRef.current || !vault.client) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    setProgress(0);
    try {
      while (!controller.signal.aborted) {
        const claim = await claimVaultMigration(csrfToken, controller.signal);
        setMigration(claim.migration);
        if (!claim.node) break;
        setCurrentName(claim.node.name);
        setProgress(0);
        if (claim.node.parentId) await vault.openNode(claim.node.parentId);
        await migrateEncryptedNode({
          node: claim.node,
          csrfToken,
          client: vault.client,
          signal: controller.signal,
          onProgress: (processed, total) =>
            setProgress(
              total === 0 ? 100 : Math.min(100, (processed / total) * 100),
            ),
        });
        const status = await getVaultStatus(controller.signal);
        setMigration(status.migration);
      }
      const status = await getVaultStatus(controller.signal);
      setMigration(status.migration);
      // abortRef permits only this controller to own migration completion state.
      // react-doctor-disable-next-line react-doctor/no-unowned-async-error-clear
      setCurrentName(null);
      setProgress(100);
      router.refresh();
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(
          failure instanceof Error
            ? failure.message
            : "The encrypted migration stopped unexpectedly.",
        );
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }, [csrfToken, router, vault]);

  useEffect(() => {
    const controller = new AbortController();
    void getVaultStatus(controller.signal)
      .then((status) => setMigration(status.migration))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (queuedRef.current && vault.state === "unlocked") {
      queuedRef.current = false;
      void runMigration();
    }
  }, [runMigration, vault.state]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function start(): void {
    if (vault.state !== "unlocked") {
      queuedRef.current = true;
      vault.requestUnlock();
      return;
    }
    void runMigration();
  }

  const remaining = migration
    ? migration.legacyNodes + migration.incompleteNodes
    : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">Encrypt existing files</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Legacy objects are streamed through this browser and replaced only
            after ciphertext verification.
          </p>
        </div>
        <Button
          type="button"
          onClick={start}
          disabled={running || remaining === 0}
        >
          {running ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : remaining === 0 ? (
            <ShieldCheck className="size-4" aria-hidden="true" />
          ) : (
            <LockKeyhole className="size-4" aria-hidden="true" />
          )}
          {running
            ? "Migrating..."
            : remaining === 0
              ? "Migration complete"
              : "Start migration"}
        </Button>
      </div>
      {running ? (
        <div className="space-y-2" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span className="truncate">
              {currentName ?? "Preparing next item"}
            </span>
            <span>{Math.round(progress)}%</span>
          </div>
          <Progress value={progress} />
        </div>
      ) : null}
      {migration &&
      migration.incompleteNodes > 0 &&
      migration.legacyNodes === 0 ? (
        <p className="text-xs text-muted-foreground">
          Encryption is complete. Old plaintext objects are still being removed
          by the storage worker.
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Migration paused</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
