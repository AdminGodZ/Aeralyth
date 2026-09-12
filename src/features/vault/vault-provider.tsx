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
import type { RealtimeChange } from "@/features/realtime/changes";
import { isVaultNodeId } from "@/features/vault/node-id";
import type {
  VaultDownloadPlan,
  VaultManifest,
  VaultMetadataReference,
} from "@/features/vault/protocol";
import {
  cancelShareDirectorySyncForLock,
  enqueueShareDirectorySync,
} from "@/features/vault/share-directory-sync";
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
  vaultAutoLockDeadline,
  vaultResumeRecordExpiration,
} from "@/features/vault/vault-preferences";
import { persistVaultResumeSession } from "@/features/vault/vault-resume-client";
import {
  clearVaultResumeMarker,
  clearVaultResumeMarkers,
  readVaultResumeMarker,
  type VaultResumeMarker,
  vaultSessionStorage,
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
  invalidateMetadata(changes: RealtimeChange[], reset: boolean): void;
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

const VAULT_RESUME_PERSIST_INTERVAL_MS = 1_000;

const VaultContext = createContext<VaultContextValue | null>(null);

type VaultProviderProps = {
  children: ReactNode;
  csrfToken: string;
  e2eeMode: "off" | "migrate" | "required";
  vaultConfigured: boolean;
  autoLockMinutes: number;
  onePasswordEnabled?: boolean;
};

export function VaultProvider({
  children,
  ...controllerProps
}: VaultProviderProps) {
  const controller = useVaultProviderController(controllerProps);
  return <VaultProviderView {...controller}>{children}</VaultProviderView>;
}

function useVaultProviderController({
  csrfToken,
  e2eeMode,
  vaultConfigured,
  autoLockMinutes,
  onePasswordEnabled = false,
}: Omit<VaultProviderProps, "children">) {
  const enabled = e2eeMode !== "off";
  const clientRef = useRef<VaultCryptoClient | null>(null);
  const nodeOpenFlightsRef = useRef(new Map<string, Promise<VaultManifest>>());
  const [metadataResolver] = useState(() => new VaultMetadataResolver());
  const lockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockDeadlineRef = useRef(0);
  const resumeSessionIdRef = useRef<string | null>(null);
  const submitVersionRef = useRef(0);
  const persistedResumeExpirationRef = useRef(0);
  const serverAutoLockMinutesRef = useRef(autoLockMinutes);
  serverAutoLockMinutesRef.current = autoLockMinutes;
  const [state, setState] = useState<VaultState>(
    enabled ? (vaultConfigured ? "unlocking" : "setup") : "off",
  );
  // Setup can transition this value locally before server props refresh.
  // react-doctor-disable-next-line react-doctor/no-derived-useState
  const [configured, setConfigured] = useState(vaultConfigured);
  const configuredRef = useRef(configured);
  configuredRef.current = configured;
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

  const getClient = useCallback(
    (allowCreate = false) => {
      // Old render callbacks can run before React commits the locked state. They
      // must never replace a failed worker while a background operation retries.
      if (!clientRef.current && !allowCreate)
        throw new VaultWorkerError("Unlock the vault first.", "VAULT_LOCKED");
      if (!clientRef.current) {
        const client = new VaultCryptoClient((failure) => {
          if (clientRef.current !== client) return;
          clientRef.current = null;
          if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
          lockTimerRef.current = null;
          lockDeadlineRef.current = 0;
          resumeSessionIdRef.current = null;
          persistedResumeExpirationRef.current = 0;
          clearVaultResumeMarkers();
          cancelShareDirectorySyncForLock();
          metadataResolver.clear();
          nodeOpenFlightsRef.current.clear();
          window.dispatchEvent(new Event(VAULT_LOCKING_EVENT));
          setState(configuredRef.current ? "locked" : "setup");
          setMode(configuredRef.current ? "unlock" : "setup");
          setError(failure.message);
          setBusy(false);
          setPassword("");
          setPasswordConfirmation("");
          setRecoveryCodeInput("");
          setDialogOpen(true);
        });
        clientRef.current = client;
      }
      return clientRef.current;
    },
    [metadataResolver],
  );

  const beginVaultResumeSession = useCallback(
    async (client: VaultCryptoClient, vaultVersion: number): Promise<void> => {
      const storage = vaultSessionStorage(activeAutoLockMinutes);
      if (!storage) return;
      try {
        const marker = await persistVaultResumeSession(
          client,
          csrfToken,
          activeAutoLockMinutes,
          vaultVersion,
          storage,
        );
        if (clientRef.current !== client) {
          if (readVaultResumeMarker(storage)?.sessionId === marker.sessionId)
            clearVaultResumeMarker(storage);
          throw new VaultWorkerError(
            "Unlock the vault again to recover.",
            "WORKER_UNAVAILABLE",
          );
        }
        resumeSessionIdRef.current = marker.sessionId;
        persistedResumeExpirationRef.current = marker.expiresAt;
        lockDeadlineRef.current = marker.expiresAt;
      } catch {
        if (clientRef.current === client) clearVaultResumeMarker(storage);
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
    clearVaultResumeMarkers();
    cancelShareDirectorySyncForLock();
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
    const storage = vaultSessionStorage(serverAutoLockMinutesRef.current);
    const marker = storage ? readVaultResumeMarker(storage) : null;
    if (!marker) {
      setState("locked");
      setDialogOpen(true);
      return;
    }

    let cancelled = false;
    const restore = async () => {
      let client: VaultCryptoClient | null = null;
      try {
        client = getClient(true);
        const material = await getUnlockMaterial();
        const resumed = await client.resume(
          marker.sessionId,
          csrfToken,
          material,
        );
        if (cancelled || clientRef.current !== client) return;
        if (!resumed.resumed) {
          if (storage) clearVaultResumeMarker(storage);
          setState("locked");
          setDialogOpen(true);
          return;
        }

        resumeSessionIdRef.current = marker.sessionId;
        persistedResumeExpirationRef.current = Math.min(
          marker.expiresAt || Number.POSITIVE_INFINITY,
          resumed.expiresAt || Number.POSITIVE_INFINITY,
        );
        if (marker.expiresAt === 0 && resumed.expiresAt === 0)
          persistedResumeExpirationRef.current = 0;
        lockDeadlineRef.current = marker.expiresAt;
        setState("unlocked");
        setDialogOpen(false);
        enqueueShareDirectorySync({ csrfToken, client });
      } catch {
        if (cancelled || (client && clientRef.current !== client)) return;
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
        activeAutoLockMinutes !== 0 &&
        !resetExpiredDeadline &&
        lockDeadlineRef.current > 0 &&
        now >= lockDeadlineRef.current
      ) {
        void lock();
        return;
      }

      const expiresAt = vaultAutoLockDeadline(activeAutoLockMinutes, now);
      lockDeadlineRef.current = expiresAt;
      const resumeSessionId = resumeSessionIdRef.current;
      const storage = vaultSessionStorage(activeAutoLockMinutes);
      if (resumeSessionId && storage) {
        const marker: VaultResumeMarker = {
          version: 1,
          sessionId: resumeSessionId,
          expiresAt,
        };
        writeVaultResumeMarker(storage, marker);
        const otherStorage = vaultSessionStorage(
          activeAutoLockMinutes === 0 ? 15 : 0,
        );
        if (otherStorage) clearVaultResumeMarker(otherStorage);
        if (
          (expiresAt === 0) !== (persistedResumeExpirationRef.current === 0) ||
          Math.abs(expiresAt - persistedResumeExpirationRef.current) >=
            VAULT_RESUME_PERSIST_INTERVAL_MS
        ) {
          persistedResumeExpirationRef.current = expiresAt;
          void clientRef.current
            ?.extendSession(
              resumeSessionId,
              vaultResumeRecordExpiration(expiresAt),
            )
            .catch(() => {
              if (resumeSessionIdRef.current === resumeSessionId) {
                persistedResumeExpirationRef.current = 0;
              }
            });
        }
      }

      if (activeAutoLockMinutes === 0) return;
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
      if (
        !clientRef.current ||
        state !== "unlocked" ||
        !isVaultNodeId(folderId)
      ) {
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

  const invalidateMetadata = useCallback(
    (changes: RealtimeChange[], reset: boolean) => {
      if (
        reset ||
        changes.some(({ scope }) => scope === "shared" || scope === "vault")
      ) {
        metadataResolver.clear();
        nodeOpenFlightsRef.current.clear();
        return;
      }
      for (const change of changes) {
        if (change.scope === "files")
          metadataResolver.invalidateFolders(change.folderIds);
      }
    },
    [metadataResolver],
  );

  async function submit(): Promise<void> {
    const version = ++submitVersionRef.current;
    let client: VaultCryptoClient | null = null;
    setError(null);
    setBusy(true);
    setState("unlocking");
    try {
      client = getClient(true);
      if (mode === "setup") {
        if (password !== passwordConfirmation) {
          throw new Error(
            onePasswordEnabled
              ? "The account passwords do not match."
              : "The vault passwords do not match.",
          );
        }
        const setup = await client.setup(password);
        const created = await setupVault(csrfToken, setup.payload);
        configuredRef.current = true;
        setConfigured(true);
        await beginVaultResumeSession(client, created.vaultVersion);
        if (clientRef.current !== client)
          throw new VaultWorkerError(
            "Unlock the vault again to recover.",
            "WORKER_UNAVAILABLE",
          );
        setNewRecoveryCode(setup.recoveryCode);
        setRecoveryConfirmed(false);
        setState("unlocked");
      } else if (mode === "unlock") {
        const material = await getUnlockMaterial();
        const unlocked = await client.unlock(password, material);
        await beginVaultResumeSession(client, unlocked.vaultVersion);
        if (clientRef.current !== client)
          throw new VaultWorkerError(
            "Unlock the vault again to recover.",
            "WORKER_UNAVAILABLE",
          );
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
        if (clientRef.current !== client)
          throw new VaultWorkerError(
            "Unlock the vault again to recover.",
            "WORKER_UNAVAILABLE",
          );
        setNewRecoveryCode(recovered.recoveryCode);
        setRecoveryConfirmed(false);
        setState("unlocked");
      }
      enqueueShareDirectorySync({ csrfToken, client });
      setPassword("");
      setPasswordConfirmation("");
      setRecoveryCodeInput("");
    } catch (failure) {
      if (submitVersionRef.current !== version) return;
      const message =
        onePasswordEnabled &&
        failure instanceof VaultWorkerError &&
        failure.code === "INVALID_PASSWORD"
          ? "The account password is incorrect."
          : failure instanceof Error
            ? failure.message
            : "The vault operation failed.";
      cancelShareDirectorySyncForLock();
      if (clientRef.current === client)
        await client?.lock().catch(() => undefined);
      setError(message);
      if (
        failure instanceof VaultWorkerError &&
        failure.code === "UNSUPPORTED_DEVICE"
      ) {
        setState("unsupported");
      } else {
        setState(
          configuredRef.current || mode !== "setup" ? "locked" : "setup",
        );
      }
    } finally {
      if (submitVersionRef.current === version) setBusy(false);
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
      invalidateMetadata,
      openNode,
      resolveMetadata,
      prefetchFolderMetadata,
      rememberFolderMetadata,
    }),
    [
      enabled,
      lock,
      invalidateMetadata,
      openNode,
      prefetchFolderMetadata,
      rememberFolderMetadata,
      requestUnlock,
      resolveMetadata,
      state,
    ],
  );

  function changeDialogOpen(open: boolean): void {
    if (!busy && state !== "setup" && !newRecoveryCode) setDialogOpen(open);
  }

  function switchMode(): void {
    if (onePasswordEnabled) return;
    setError(null);
    setMode(mode === "recover" ? "unlock" : "recover");
  }

  return {
    busy,
    canClose: state !== "setup" && !newRecoveryCode,
    configured,
    context,
    dialogOpen: dialogOpen && enabled,
    error,
    mode,
    newRecoveryCode,
    onePasswordEnabled,
    onDialogOpenChange: changeDialogOpen,
    onFinishRecoveryConfirmation: finishRecoveryConfirmation,
    onPasswordChange: setPassword,
    onPasswordConfirmationChange: setPasswordConfirmation,
    onRecoveryCodeInputChange: setRecoveryCodeInput,
    onRecoveryConfirmedChange: setRecoveryConfirmed,
    onSubmit: submit,
    onSwitchMode: switchMode,
    password,
    passwordConfirmation,
    recoveryCodeInput,
    recoveryConfirmed,
  };
}

function VaultProviderView({
  children,
  context,
  dialogOpen,
  canClose,
  newRecoveryCode,
  onePasswordEnabled,
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
  onePasswordEnabled: boolean;
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
              onePasswordEnabled={onePasswordEnabled}
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
                    ? onePasswordEnabled
                      ? "Protect encrypted files"
                      : "Create your encrypted vault"
                    : mode === "recover"
                      ? "Recover your encrypted vault"
                      : onePasswordEnabled
                        ? "Unlock encrypted files"
                        : "Unlock your encrypted vault"}
                </DialogTitle>
                <DialogDescription>
                  {mode === "setup"
                    ? onePasswordEnabled
                      ? "Your account password also unlocks encrypted files. Aeralyth cannot recover them without your recovery key."
                      : "Choose a separate vault password. Aeralyth cannot recover it without your recovery key."
                    : mode === "recover"
                      ? "Use your recovery key to replace the vault password and recovery key."
                      : onePasswordEnabled
                        ? "Your account password unlocks encrypted files only in this browser."
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
                      : onePasswordEnabled
                        ? "Account password"
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
                      {onePasswordEnabled
                        ? "Confirm account password"
                        : "Confirm vault password"}
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
                    <AlertTitle>
                      {onePasswordEnabled
                        ? "Encrypted files unavailable"
                        : "Vault unavailable"}
                    </AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
                <DialogFooter className="sm:justify-between">
                  {configured && !onePasswordEnabled ? (
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
                        ? onePasswordEnabled
                          ? "Protect files"
                          : "Create vault"
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
  onePasswordEnabled,
  confirmed,
  onConfirmedChange,
  onDone,
}: {
  recoveryCode: string;
  onePasswordEnabled: boolean;
  confirmed: boolean;
  onConfirmedChange(value: boolean): void;
  onDone(): void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Store your recovery key</DialogTitle>
        <DialogDescription>
          This key is shown once. It is the only recovery path if you forget the{" "}
          {onePasswordEnabled ? "account password" : "vault password"}.
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
