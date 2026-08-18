"use client";

import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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
import { isVaultNodeId } from "@/features/vault/node-id";
import type {
  VaultDownloadPlan,
  VaultManifest,
  VaultMetadataReference,
} from "@/features/vault/protocol";
import { enqueueShareDirectorySync } from "@/features/vault/share-directory-sync";
import {
  getUnlockMaterial,
  getVaultDownloadPlan,
  rewrapVault,
  setupVault,
} from "@/features/vault/vault-api";
import {
  VaultCryptoClient,
  VaultWorkerError,
} from "@/features/vault/vault-client";
import type { VaultMetadataOpenResult } from "@/features/vault/vault-messages";
import {
  type VaultMetadataResolutionOptions,
  VaultMetadataResolver,
} from "@/features/vault/vault-metadata-resolver";
import {
  normalizeVaultAutoLockMinutes,
  VAULT_AUTO_LOCK_CHANGE_EVENT,
} from "@/features/vault/vault-preferences";
import {
  clearVaultResumeMarker,
  createVaultResumeMarker,
  readVaultResumeMarker,
  type VaultResumeMarker,
  writeVaultResumeMarker,
} from "@/features/vault/vault-session";

type VaultState =
  | "off"
  | "setup"
  | "locked"
  | "unlocking"
  | "unlocked"
  | "unsupported";

type VaultDialogMode = "setup" | "unlock" | "recover";

type VaultContextValue = {
  enabled: boolean;
  state: VaultState;
  client: VaultCryptoClient | null;
  requestUnlock(): void;
  lock(): Promise<void>;
  openNode(
    nodeId: string,
    plan?: VaultDownloadPlan,
    signal?: AbortSignal,
  ): Promise<VaultManifest>;
  resolveMetadata(
    references: VaultMetadataReference[],
    options?: VaultMetadataResolutionOptions,
  ): Promise<VaultMetadataOpenResult[]>;
  prefetchFolderMetadata(
    folderId: string,
    view: "files" | "shared",
  ): Promise<void>;
  rememberFolderMetadata(
    folderId: string | null,
    view: "files" | "shared",
    references: VaultMetadataReference[],
  ): void;
};

export const VAULT_LOCKING_EVENT = "aeralyth:vault-locking";

const VAULT_RESUME_RECORD_GRACE_MS = 5_000;
const VAULT_RESUME_PERSIST_INTERVAL_MS = 1_000;

const VaultContext = createContext<VaultContextValue | null>(null);

function vaultSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function VaultProvider({
  children,
  csrfToken,
  e2eeMode,
  vaultConfigured,
  autoLockMinutes,
}: {
  children: ReactNode;
  csrfToken: string;
  e2eeMode: "off" | "migrate" | "required";
  vaultConfigured: boolean;
  autoLockMinutes: number;
}) {
  const enabled = e2eeMode !== "off";
  const clientRef = useRef<VaultCryptoClient | null>(null);
  const nodeOpenFlightsRef = useRef(new Map<string, Promise<VaultManifest>>());
  const [metadataResolver] = useState(() => new VaultMetadataResolver());
  const lockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockDeadlineRef = useRef(0);
  const resumeSessionIdRef = useRef<string | null>(null);
  const persistedResumeExpirationRef = useRef(0);
  const [state, setState] = useState<VaultState>(
    enabled ? (vaultConfigured ? "unlocking" : "setup") : "off",
  );
  // Setup can transition this value locally before server props refresh.
  // react-doctor-disable-next-line react-doctor/no-derived-useState
  const [configured, setConfigured] = useState(vaultConfigured);
  const [activeAutoLockMinutes, setActiveAutoLockMinutes] = useState(() =>
    normalizeVaultAutoLockMinutes(autoLockMinutes),
  );
  const [dialogOpen, setDialogOpen] = useState(enabled && !vaultConfigured);
  const [mode, setMode] = useState<VaultDialogMode>(
    vaultConfigured ? "unlock" : "setup",
  );
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [recoveryCodeInput, setRecoveryCodeInput] = useState("");
  const [newRecoveryCode, setNewRecoveryCode] = useState<string | null>(null);
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getClient = useCallback(() => {
    if (!clientRef.current) clientRef.current = new VaultCryptoClient();
    return clientRef.current;
  }, []);

  const beginVaultResumeSession = useCallback(
    async (client: VaultCryptoClient, vaultVersion: number): Promise<void> => {
      const storage = vaultSessionStorage();
      if (!storage) return;
      const expiresAt = Date.now() + activeAutoLockMinutes * 60 * 1_000;
      const marker = createVaultResumeMarker(expiresAt);
      if (!writeVaultResumeMarker(storage, marker)) return;

      try {
        await client.persistSession(
          marker.sessionId,
          csrfToken,
          expiresAt + VAULT_RESUME_RECORD_GRACE_MS,
          vaultVersion,
        );
        resumeSessionIdRef.current = marker.sessionId;
        persistedResumeExpirationRef.current = expiresAt;
        lockDeadlineRef.current = expiresAt;
      } catch {
        clearVaultResumeMarker(storage);
      }
    },
    [activeAutoLockMinutes, csrfToken],
  );

  const lock = useCallback(async () => {
    if (lockTimerRef.current) {
      clearTimeout(lockTimerRef.current);
      lockTimerRef.current = null;
    }
    lockDeadlineRef.current = 0;
    resumeSessionIdRef.current = null;
    persistedResumeExpirationRef.current = 0;
    const storage = vaultSessionStorage();
    if (storage) clearVaultResumeMarker(storage);
    if (enabled) {
      window.dispatchEvent(new Event(VAULT_LOCKING_EVENT));
      setState(configured ? "locked" : "setup");
      setMode(configured ? "unlock" : "setup");
    }
    metadataResolver.clear();
    nodeOpenFlightsRef.current.clear();
    await clientRef.current?.lock();
  }, [configured, enabled, metadataResolver]);

  useEffect(() => {
    setActiveAutoLockMinutes(normalizeVaultAutoLockMinutes(autoLockMinutes));
  }, [autoLockMinutes]);

  useEffect(() => {
    const updateAutoLock = (event: Event) => {
      const minutes = (event as CustomEvent<number>).detail;
      setActiveAutoLockMinutes(normalizeVaultAutoLockMinutes(minutes));
    };
    window.addEventListener(VAULT_AUTO_LOCK_CHANGE_EVENT, updateAutoLock);
    return () =>
      window.removeEventListener(VAULT_AUTO_LOCK_CHANGE_EVENT, updateAutoLock);
  }, []);

  useEffect(() => {
    if (!enabled || !vaultConfigured) return;
    const storage = vaultSessionStorage();
    const marker = storage ? readVaultResumeMarker(storage) : null;
    if (!marker) {
      setState("locked");
      setDialogOpen(true);
      return;
    }

    let cancelled = false;
    const restore = async () => {
      try {
        const client = getClient();
        const material = await getUnlockMaterial();
        const resumed = await client.resume(
          marker.sessionId,
          csrfToken,
          material,
        );
        if (cancelled) return;
        if (!resumed.resumed) {
          if (storage) clearVaultResumeMarker(storage);
          setState("locked");
          setDialogOpen(true);
          return;
        }

        resumeSessionIdRef.current = marker.sessionId;
        persistedResumeExpirationRef.current = Math.min(
          marker.expiresAt,
          resumed.expiresAt,
        );
        lockDeadlineRef.current = marker.expiresAt;
        setState("unlocked");
        setDialogOpen(false);
        enqueueShareDirectorySync({ csrfToken, client });
      } catch {
        if (cancelled) return;
        if (storage) clearVaultResumeMarker(storage);
        setState("locked");
        setDialogOpen(true);
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [csrfToken, enabled, getClient, vaultConfigured]);

  // The returned cleanup directly removes both listeners and clears the one
  // timeout that the activity callback is allowed to replace.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      if (lockTimerRef.current === timer) lockTimerRef.current = null;
      timer = null;
    };
    const scheduleLock = (resetExpiredDeadline = false) => {
      clearTimer();
      if (state !== "unlocked") return;
      const now = Date.now();
      if (
        !resetExpiredDeadline &&
        lockDeadlineRef.current > 0 &&
        now >= lockDeadlineRef.current
      ) {
        void lock();
        return;
      }

      const expiresAt = now + activeAutoLockMinutes * 60 * 1_000;
      lockDeadlineRef.current = expiresAt;
      const resumeSessionId = resumeSessionIdRef.current;
      const storage = vaultSessionStorage();
      if (resumeSessionId && storage) {
        const marker: VaultResumeMarker = {
          version: 1,
          sessionId: resumeSessionId,
          expiresAt,
        };
        writeVaultResumeMarker(storage, marker);
        if (
          expiresAt - persistedResumeExpirationRef.current >=
          VAULT_RESUME_PERSIST_INTERVAL_MS
        ) {
          persistedResumeExpirationRef.current = expiresAt;
          void clientRef.current
            ?.extendSession(
              resumeSessionId,
              expiresAt + VAULT_RESUME_RECORD_GRACE_MS,
            )
            .catch(() => {
              if (resumeSessionIdRef.current === resumeSessionId) {
                persistedResumeExpirationRef.current = 0;
              }
            });
        }
      }

      timer = setTimeout(
        () => {
          void lock();
        },
        Math.max(0, expiresAt - Date.now()),
      );
      lockTimerRef.current = timer;
    };
    const activity = () => scheduleLock();
    window.addEventListener("pointerdown", activity, { passive: true });
    window.addEventListener("keydown", activity);
    if (state === "unlocked") scheduleLock(true);
    return () => {
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
      if (timer) clearTimeout(timer);
      if (lockTimerRef.current === timer) lockTimerRef.current = null;
      timer = null;
    };
  }, [activeAutoLockMinutes, enabled, lock, state]);

  useEffect(() => {
    return () => {
      void clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  const requestUnlock = useCallback(() => {
    if (!enabled || state === "unlocked" || state === "unlocking") return;
    setMode(configured ? "unlock" : "setup");
    setDialogOpen(true);
  }, [configured, enabled, state]);

  const openNode = useCallback(
    (
      nodeId: string,
      plan?: VaultDownloadPlan,
      signal?: AbortSignal,
    ): Promise<VaultManifest> => {
      const flightKey = plan
        ? metadataCacheKey(nodeId, plan.recordHash)
        : nodeId;
      const existing = nodeOpenFlightsRef.current.get(flightKey);
      if (existing) return waitForVaultOperation(existing, signal);

      const operation = (async () => {
        if (state !== "unlocked") {
          requestUnlock();
          throw new VaultWorkerError("Unlock the vault first.", "VAULT_LOCKED");
        }
        const client = getClient();
        const nodePlan = plan ?? (await getVaultDownloadPlan(nodeId));
        let manifest: VaultManifest;
        try {
          manifest = (await client.openPlan(nodePlan)).manifest;
        } catch (failure) {
          const parentId = getRequiredParentId(failure);
          if (!parentId) throw failure;
          await openNode(parentId);
          manifest = (await client.openPlan(nodePlan)).manifest;
        }
        metadataResolver.remember({
          status: "ready",
          nodeId,
          recordHash: nodePlan.recordHash,
          manifest,
        });
        return manifest;
      })();
      nodeOpenFlightsRef.current.set(flightKey, operation);
      const clearFlight = () => {
        if (nodeOpenFlightsRef.current.get(flightKey) === operation) {
          nodeOpenFlightsRef.current.delete(flightKey);
        }
      };
      void operation.then(clearFlight, clearFlight);
      return waitForVaultOperation(operation, signal);
    },
    [getClient, metadataResolver, requestUnlock, state],
  );

  const resolveMetadata = useCallback(
    async (
      references: VaultMetadataReference[],
      options: VaultMetadataResolutionOptions = {},
    ): Promise<VaultMetadataOpenResult[]> => {
      if (state !== "unlocked") {
        requestUnlock();
        throw new VaultWorkerError("Unlock the vault first.", "VAULT_LOCKED");
      }
      return metadataResolver.resolve(
        references,
        {
          csrfToken,
          client: getClient(),
          openNode,
        },
        options,
      );
    },
    [csrfToken, getClient, metadataResolver, openNode, requestUnlock, state],
  );

  const prefetchFolderMetadata = useCallback(
    (folderId: string, view: "files" | "shared"): Promise<void> => {
      if (state !== "unlocked" || !isVaultNodeId(folderId)) {
        return Promise.resolve();
      }
      return metadataResolver.prefetchFolder(folderId, view, {
        csrfToken,
        client: getClient(),
        openNode,
      });
    },
    [csrfToken, getClient, metadataResolver, openNode, state],
  );

  const rememberFolderMetadata = useCallback(
    (
      folderId: string | null,
      view: "files" | "shared",
      references: VaultMetadataReference[],
    ): void => {
      if (state !== "unlocked") return;
      metadataResolver.rememberFolder(folderId, view, references);
    },
    [metadataResolver, state],
  );

  async function submit(): Promise<void> {
    setError(null);
    setBusy(true);
    setState("unlocking");
    try {
      const client = getClient();
      if (mode === "setup") {
        if (password !== passwordConfirmation) {
          throw new Error("The vault passwords do not match.");
        }
        const setup = await client.setup(password);
        const created = await setupVault(csrfToken, setup.payload);
        await beginVaultResumeSession(client, created.vaultVersion);
        setConfigured(true);
        setNewRecoveryCode(setup.recoveryCode);
        setRecoveryConfirmed(false);
        setState("unlocked");
      } else if (mode === "unlock") {
        const material = await getUnlockMaterial();
        const unlocked = await client.unlock(password, material);
        await beginVaultResumeSession(client, unlocked.vaultVersion);
        setState("unlocked");
        setDialogOpen(false);
      } else {
        if (password !== passwordConfirmation) {
          throw new Error("The new vault passwords do not match.");
        }
        const material = await getUnlockMaterial();
        const recovered = await client.recover(
          recoveryCodeInput,
          password,
          material,
        );
        const rewrapped = await rewrapVault(csrfToken, recovered.payload);
        await beginVaultResumeSession(client, rewrapped.vaultVersion);
        setNewRecoveryCode(recovered.recoveryCode);
        setRecoveryConfirmed(false);
        setState("unlocked");
      }
      enqueueShareDirectorySync({ csrfToken, client });
      setPassword("");
      setPasswordConfirmation("");
      setRecoveryCodeInput("");
    } catch (failure) {
      const message =
        failure instanceof Error
          ? failure.message
          : "The vault operation failed.";
      await clientRef.current?.lock().catch(() => undefined);
      setError(message);
      if (
        failure instanceof VaultWorkerError &&
        failure.code === "UNSUPPORTED_DEVICE"
      ) {
        setState("unsupported");
      } else {
        setState(configured || mode !== "setup" ? "locked" : "setup");
      }
    } finally {
      setBusy(false);
    }
  }

  function finishRecoveryConfirmation(): void {
    if (!recoveryConfirmed) return;
    setNewRecoveryCode(null);
    setDialogOpen(false);
  }

  const context = useMemo<VaultContextValue>(
    () => ({
      enabled,
      state,
      client: clientRef.current,
      requestUnlock,
      lock,
      openNode,
      resolveMetadata,
      prefetchFolderMetadata,
      rememberFolderMetadata,
    }),
    [
      enabled,
      lock,
      openNode,
      prefetchFolderMetadata,
      rememberFolderMetadata,
      requestUnlock,
      resolveMetadata,
      state,
    ],
  );

  return (
    <VaultProviderView
      context={context}
      dialogOpen={dialogOpen && enabled}
      canClose={state !== "setup" && !newRecoveryCode}
      newRecoveryCode={newRecoveryCode}
      recoveryConfirmed={recoveryConfirmed}
      onRecoveryConfirmedChange={setRecoveryConfirmed}
      onFinishRecoveryConfirmation={finishRecoveryConfirmation}
      onDialogOpenChange={(open) => {
        if (!busy && state !== "setup" && !newRecoveryCode) setDialogOpen(open);
      }}
      mode={mode}
      recoveryCodeInput={recoveryCodeInput}
      onRecoveryCodeInputChange={setRecoveryCodeInput}
      password={password}
      onPasswordChange={setPassword}
      passwordConfirmation={passwordConfirmation}
      onPasswordConfirmationChange={setPasswordConfirmation}
      error={error}
      configured={configured}
      busy={busy}
      onSwitchMode={() => {
        setError(null);
        setMode(mode === "recover" ? "unlock" : "recover");
      }}
      onSubmit={submit}
    >
      {children}
    </VaultProviderView>
  );
}

function VaultProviderView({
  children,
  context,
  dialogOpen,
  canClose,
  newRecoveryCode,
  recoveryConfirmed,
  onRecoveryConfirmedChange,
  onFinishRecoveryConfirmation,
  onDialogOpenChange,
  mode,
  recoveryCodeInput,
  onRecoveryCodeInputChange,
  password,
  onPasswordChange,
  passwordConfirmation,
  onPasswordConfirmationChange,
  error,
  configured,
  busy,
  onSwitchMode,
  onSubmit,
}: {
  children: ReactNode;
  context: VaultContextValue;
  dialogOpen: boolean;
  canClose: boolean;
  newRecoveryCode: string | null;
  recoveryConfirmed: boolean;
  onRecoveryConfirmedChange(value: boolean): void;
  onFinishRecoveryConfirmation(): void;
  onDialogOpenChange(open: boolean): void;
  mode: VaultDialogMode;
  recoveryCodeInput: string;
  onRecoveryCodeInputChange(value: string): void;
  password: string;
  onPasswordChange(value: string): void;
  passwordConfirmation: string;
  onPasswordConfirmationChange(value: string): void;
  error: string | null;
  configured: boolean;
  busy: boolean;
  onSwitchMode(): void;
  onSubmit(): Promise<void>;
}) {
  return (
    <VaultContext.Provider value={context}>
      {children}
      <Dialog open={dialogOpen} onOpenChange={onDialogOpenChange}>
        <DialogContent className="sm:max-w-md" showCloseButton={canClose}>
          {newRecoveryCode ? (
            <RecoveryKeyConfirmation
              recoveryCode={newRecoveryCode}
              confirmed={recoveryConfirmed}
              onConfirmedChange={onRecoveryConfirmedChange}
              onDone={onFinishRecoveryConfirmation}
            />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {mode === "setup" ? (
                    <ShieldCheck
                      className="size-5 text-primary"
                      aria-hidden="true"
                    />
                  ) : (
                    <LockKeyhole
                      className="size-5 text-primary"
                      aria-hidden="true"
                    />
                  )}
                  {mode === "setup"
                    ? "Create your encrypted vault"
                    : mode === "recover"
                      ? "Recover your encrypted vault"
                      : "Unlock your encrypted vault"}
                </DialogTitle>
                <DialogDescription>
                  {mode === "setup"
                    ? "Choose a separate vault password. Aeralyth cannot recover it without your recovery key."
                    : mode === "recover"
                      ? "Use your recovery key to replace the vault password and recovery key."
                      : "Your vault password is processed only in this browser."}
                </DialogDescription>
              </DialogHeader>

              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void onSubmit();
                }}
              >
                {mode === "recover" ? (
                  <div className="space-y-2">
                    <Label htmlFor="vault-recovery-code">Recovery key</Label>
                    <Input
                      id="vault-recovery-code"
                      value={recoveryCodeInput}
                      onChange={(event) =>
                        onRecoveryCodeInputChange(event.target.value)
                      }
                      autoComplete="off"
                      spellCheck={false}
                      required
                    />
                  </div>
                ) : null}
                <div className="space-y-2">
                  <Label htmlFor="vault-password">
                    {mode === "recover"
                      ? "New vault password"
                      : "Vault password"}
                  </Label>
                  <Input
                    id="vault-password"
                    type="password"
                    value={password}
                    onChange={(event) => onPasswordChange(event.target.value)}
                    autoComplete={
                      mode === "unlock" ? "current-password" : "new-password"
                    }
                    minLength={12}
                    required
                    autoFocus
                  />
                </div>
                {mode !== "unlock" ? (
                  <div className="space-y-2">
                    <Label htmlFor="vault-password-confirmation">
                      Confirm vault password
                    </Label>
                    <Input
                      id="vault-password-confirmation"
                      type="password"
                      value={passwordConfirmation}
                      onChange={(event) =>
                        onPasswordConfirmationChange(event.target.value)
                      }
                      autoComplete="new-password"
                      minLength={12}
                      required
                    />
                  </div>
                ) : null}
                {error ? (
                  <Alert variant="destructive">
                    <AlertTitle>Vault unavailable</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
                <DialogFooter className="sm:justify-between">
                  {configured ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={onSwitchMode}
                      disabled={busy}
                    >
                      <KeyRound className="size-4" aria-hidden="true" />
                      {mode === "recover" ? "Use password" : "Use recovery key"}
                    </Button>
                  ) : (
                    <span />
                  )}
                  <Button type="submit" disabled={busy}>
                    {busy
                      ? "Working..."
                      : mode === "setup"
                        ? "Create vault"
                        : mode === "recover"
                          ? "Recover vault"
                          : "Unlock"}
                  </Button>
                </DialogFooter>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>
    </VaultContext.Provider>
  );
}

function RecoveryKeyConfirmation({
  recoveryCode,
  confirmed,
  onConfirmedChange,
  onDone,
}: {
  recoveryCode: string;
  confirmed: boolean;
  onConfirmedChange(value: boolean): void;
  onDone(): void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Store your recovery key</DialogTitle>
        <DialogDescription>
          This key is shown once. It is the only recovery path if you forget the
          vault password.
        </DialogDescription>
      </DialogHeader>
      <div className="rounded-md border bg-muted/40 p-3 font-mono text-sm break-all select-all">
        {recoveryCode}
      </div>
      <label className="flex cursor-pointer items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-primary"
          checked={confirmed}
          onChange={(event) => onConfirmedChange(event.target.checked)}
        />
        <span>I stored this recovery key outside Aeralyth.</span>
      </label>
      <DialogFooter>
        <Button type="button" disabled={!confirmed} onClick={onDone}>
          Continue
        </Button>
      </DialogFooter>
    </>
  );
}

function getRequiredParentId(error: unknown): string | null {
  if (
    !(error instanceof VaultWorkerError) ||
    error.code !== "PARENT_KEY_REQUIRED"
  ) {
    return null;
  }
  const separator = error.message.lastIndexOf(":");
  const parentId = separator >= 0 ? error.message.slice(separator + 1) : "";
  return isVaultNodeId(parentId) ? parentId : null;
}

function metadataCacheKey(nodeId: string, recordHash: string): string {
  return `${nodeId}:${recordHash}`;
}

function waitForVaultOperation<Value>(
  operation: Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(vaultAbortReason(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(vaultAbortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (failure: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(failure);
      },
    );
  });
}

function vaultAbortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("The operation was aborted.", "AbortError")
  );
}

export function useVault(): VaultContextValue {
  const value = useContext(VaultContext);
  if (!value) throw new Error("useVault must be used inside VaultProvider.");
  return value;
}
