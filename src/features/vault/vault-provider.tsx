"use client";

import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
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
import type { VaultManifest } from "@/features/vault/protocol";
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
import {
  normalizeVaultAutoLockMinutes,
  VAULT_AUTO_LOCK_CHANGE_EVENT,
} from "@/features/vault/vault-preferences";

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
  openNode(nodeId: string): Promise<VaultManifest>;
};

const VaultContext = createContext<VaultContextValue | null>(null);
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
  const lockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<VaultState>(
    enabled ? (vaultConfigured ? "locked" : "setup") : "off",
  );
  // Setup can transition this value locally before server props refresh.
  // react-doctor-disable-next-line react-doctor/no-derived-useState
  const [configured, setConfigured] = useState(vaultConfigured);
  const [activeAutoLockMinutes, setActiveAutoLockMinutes] = useState(() =>
    normalizeVaultAutoLockMinutes(autoLockMinutes),
  );
  const [dialogOpen, setDialogOpen] = useState(enabled);
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

  const scheduleLock = useCallback(() => {
    if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
    if (state !== "unlocked") return;
    lockTimerRef.current = setTimeout(
      () => {
        void clientRef.current?.lock().finally(() => {
          setState("locked");
          setMode("unlock");
        });
      },
      activeAutoLockMinutes * 60 * 1000,
    );
  }, [activeAutoLockMinutes, state]);

  const lock = useCallback(async () => {
    if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
    await clientRef.current?.lock();
    if (enabled) {
      setState(configured ? "locked" : "setup");
      setMode(configured ? "unlock" : "setup");
    }
  }, [configured, enabled]);

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

  const scheduleLockForActivity = useEffectEvent(() => scheduleLock());
  const lockForLifecycle = useEffectEvent(() => {
    void lock();
  });

  useEffect(() => {
    if (!enabled) return;
    const activity = () => scheduleLockForActivity();
    const lifecycleLock = () => lockForLifecycle();
    window.addEventListener("pointerdown", activity, { passive: true });
    window.addEventListener("keydown", activity);
    window.addEventListener("pagehide", lifecycleLock);
    scheduleLockForActivity();
    return () => {
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
      window.removeEventListener("pagehide", lifecycleLock);
      if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
    };
  }, [enabled]);

  useEffect(() => {
    return () => {
      void clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  const requestUnlock = useCallback(() => {
    if (!enabled || state === "unlocked") return;
    setMode(configured ? "unlock" : "setup");
    setDialogOpen(true);
  }, [configured, enabled, state]);

  const openNode = useCallback(
    async (nodeId: string): Promise<VaultManifest> => {
      if (state !== "unlocked") {
        requestUnlock();
        throw new VaultWorkerError("Unlock the vault first.", "VAULT_LOCKED");
      }
      const client = getClient();
      const plan = await getVaultDownloadPlan(nodeId);
      try {
        return (await client.openPlan(plan)).manifest;
      } catch (failure) {
        const parentId = getRequiredParentId(failure);
        if (!parentId) throw failure;
        await openNode(parentId);
        return (await client.openPlan(plan)).manifest;
      }
    },
    [getClient, requestUnlock, state],
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
        await setupVault(csrfToken, setup.payload);
        setConfigured(true);
        setNewRecoveryCode(setup.recoveryCode);
        setRecoveryConfirmed(false);
        setState("unlocked");
      } else if (mode === "unlock") {
        const material = await getUnlockMaterial();
        await client.unlock(password, material);
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
        await rewrapVault(csrfToken, recovered.payload);
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
    }),
    [enabled, lock, openNode, requestUnlock, state],
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

export function useVault(): VaultContextValue {
  const value = useContext(VaultContext);
  if (!value) throw new Error("useVault must be used inside VaultProvider.");
  return value;
}
