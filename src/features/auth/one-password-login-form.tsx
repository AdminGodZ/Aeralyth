"use client";

import {
  ArrowRight,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Mail,
  ShieldCheck,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { ONE_PASSWORD_AUTH_VERSION } from "@/features/auth/account-password";
import {
  type AccountLoginResult,
  enrollOnePassword,
  getAccountAuthInfo,
  loginAccount,
} from "@/features/auth/auth-api";
import type { VaultUnlockMaterial } from "@/features/vault/protocol";
import {
  getUnlockMaterial,
  rewrapVault,
  rewrapVaultPassword,
  setupVault,
} from "@/features/vault/vault-api";
import {
  VaultCryptoClient,
  VaultWorkerError,
} from "@/features/vault/vault-client";
import { persistVaultResumeSession } from "@/features/vault/vault-resume-client";
import { vaultSessionStorage } from "@/features/vault/vault-session";
import { cn } from "@/lib/utils";

type PendingMigration = {
  authVersion: number;
  authSalt: string;
  credential: string;
  login: AccountLoginResult;
  material: VaultUnlockMaterial;
  password: string;
};

type PendingNavigation = {
  next: string;
  recoveryCode: string;
};

export function OnePasswordLoginForm({
  backendUnavailable,
  initialUsername,
  nextPath,
}: {
  backendUnavailable: boolean;
  initialUsername?: string;
  nextPath?: string;
}) {
  const clientRef = useRef<VaultCryptoClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingMigration, setPendingMigration] =
    useState<PendingMigration | null>(null);
  const [migrationMode, setMigrationMode] = useState<"password" | "recovery">(
    "password",
  );
  const [migrationSecret, setMigrationSecret] = useState("");
  const [pendingNavigation, setPendingNavigation] =
    useState<PendingNavigation | null>(null);
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);

  useEffect(() => {
    return () => {
      void clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  function getClient() {
    if (!clientRef.current) clientRef.current = new VaultCryptoClient();
    return clientRef.current;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const username = String(data.get("username") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const remember = data.get("remember") !== null;
    setBusy(true);
    setError(null);

    try {
      const client = getClient();
      const authInfo = await getAccountAuthInfo(username);
      const credential = await client.deriveAuthCredential(
        username,
        password,
        authInfo.salt,
      );
      const login = await loginAccount({
        username,
        ...(authInfo.authVersion === ONE_PASSWORD_AUTH_VERSION
          ? { credential }
          : { legacyPassword: password }),
        remember,
        ...(nextPath ? { next: nextPath } : {}),
      });

      if (login.user.e2eeMode === "off") {
        await finishAccountMigration({
          authVersion: authInfo.authVersion,
          authSalt: authInfo.salt,
          credential,
          login,
          password,
        });
        navigate(login.next);
        return;
      }

      if (!login.user.vaultConfigured) {
        const setup = await client.setup(password);
        const created = await setupVault(login.csrfToken, setup.payload);
        await persistLoginVaultSession(client, login, created.vaultVersion);
        await finishAccountMigration({
          authVersion: authInfo.authVersion,
          authSalt: authInfo.salt,
          credential,
          login,
          password,
        });
        setPendingNavigation({
          next: login.next,
          recoveryCode: setup.recoveryCode,
        });
        return;
      }

      const material = await getUnlockMaterial();
      try {
        const unlocked = await client.unlock(password, material);
        await persistLoginVaultSession(client, login, unlocked.vaultVersion);
        await finishAccountMigration({
          authVersion: authInfo.authVersion,
          authSalt: authInfo.salt,
          credential,
          login,
          password,
        });
        navigate(login.next);
      } catch (failure) {
        if (
          failure instanceof VaultWorkerError &&
          failure.code === "INVALID_PASSWORD"
        ) {
          setPendingMigration({
            authVersion: authInfo.authVersion,
            authSalt: authInfo.salt,
            credential,
            login,
            material,
            password,
          });
          setMigrationSecret("");
          return;
        }
        throw failure;
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function migrateVault(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingMigration || busy) return;
    setBusy(true);
    setError(null);
    try {
      const client = getClient();
      if (migrationMode === "password") {
        const payload = await client.rewrapPassword(
          migrationSecret,
          pendingMigration.password,
          pendingMigration.material,
        );
        const rewrapped = await rewrapVaultPassword(
          pendingMigration.login.csrfToken,
          payload,
        );
        await persistLoginVaultSession(
          client,
          pendingMigration.login,
          rewrapped.vaultVersion,
        );
        await finishAccountMigration(pendingMigration);
        navigate(pendingMigration.login.next);
      } else {
        const recovered = await client.recover(
          migrationSecret,
          pendingMigration.password,
          pendingMigration.material,
        );
        const rewrapped = await rewrapVault(
          pendingMigration.login.csrfToken,
          recovered.payload,
        );
        await persistLoginVaultSession(
          client,
          pendingMigration.login,
          rewrapped.vaultVersion,
        );
        await finishAccountMigration(pendingMigration);
        setPendingNavigation({
          next: pendingMigration.login.next,
          recoveryCode: recovered.recoveryCode,
        });
        setPendingMigration(null);
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The vault migration failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function finishAccountMigration(
    pending: Omit<PendingMigration, "material"> & {
      material?: VaultUnlockMaterial;
    },
  ) {
    if (pending.authVersion === ONE_PASSWORD_AUTH_VERSION) return;
    await enrollOnePassword(pending.login.csrfToken, {
      currentPassword: pending.password,
      credential: pending.credential,
      salt: pending.authSalt,
    });
  }

  return (
    <>
      {error && !pendingMigration ? (
        <Alert variant="destructive" className="mb-5">
          <AlertTitle>Sign in failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <form className="space-y-5" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor="username" className="text-foreground">
            Username
          </Label>
          <div className="group/input relative overflow-hidden rounded-2xl">
            <Mail
              className="pointer-events-none absolute left-4 top-1/2 z-20 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              defaultValue={initialUsername}
              placeholder="john.doe"
              required
              disabled={busy || backendUnavailable}
              className="h-12 rounded-2xl border-white/[0.07] bg-background/20 pl-11 pr-4 text-base shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] backdrop-blur-md focus-visible:border-white/[0.07] focus-visible:ring-0"
            />
            <InputShimmer />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="password" className="text-foreground">
            Password
          </Label>
          <div className="group/input relative overflow-hidden rounded-2xl">
            <LockKeyhole
              className="pointer-events-none absolute left-4 top-1/2 z-20 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Enter your password..."
              required
              disabled={busy || backendUnavailable}
              className="h-12 rounded-2xl border-white/[0.07] bg-background/20 pl-11 pr-4 text-base shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] backdrop-blur-md focus-visible:border-white/[0.07] focus-visible:ring-0"
            />
            <InputShimmer />
          </div>
        </div>

        <div className="group/field flex items-center gap-3">
          <Checkbox
            id="remember"
            name="remember"
            disabled={busy || backendUnavailable}
            className="size-5 rounded-[5px] border-white/[0.07] bg-background/20 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] backdrop-blur-md"
          />
          <Label
            htmlFor="remember"
            className="text-sm font-normal text-muted-foreground"
          >
            Keep me signed in
          </Label>
        </div>

        <Button
          type="submit"
          size="lg"
          disabled={busy || backendUnavailable}
          className="h-12 w-full rounded-full bg-primary/85 text-base shadow-[0_16px_40px_color-mix(in_srgb,var(--primary)_18%,transparent)] hover:bg-primary/95"
        >
          {busy ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <ArrowRight className="size-4" aria-hidden="true" />
          )}
          {busy ? "Unlocking..." : "Sign in"}
        </Button>
      </form>

      <Dialog open={pendingMigration !== null}>
        <DialogContent
          showCloseButton={false}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <form className="contents" onSubmit={migrateVault}>
            <DialogHeader>
              <DialogTitle>Connect your encrypted vault</DialogTitle>
              <DialogDescription>
                Aeralyth now uses your account password to unlock files. Enter
                your previous vault password once to update the encrypted key.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <Label htmlFor="vault-migration-secret">
                {migrationMode === "password"
                  ? "Previous vault password"
                  : "Recovery key"}
              </Label>
              <Input
                id="vault-migration-secret"
                type={migrationMode === "password" ? "password" : "text"}
                value={migrationSecret}
                onChange={(event) => setMigrationSecret(event.target.value)}
                autoComplete={
                  migrationMode === "password" ? "current-password" : "off"
                }
                required
                disabled={busy}
                autoFocus
              />
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              <Button
                type="button"
                variant="link"
                className="h-auto w-fit px-0"
                disabled={busy}
                onClick={() => {
                  setMigrationMode((mode) =>
                    mode === "password" ? "recovery" : "password",
                  );
                  setMigrationSecret("");
                  setError(null);
                }}
              >
                {migrationMode === "password"
                  ? "Use recovery key"
                  : "Use previous vault password"}
              </Button>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy || !migrationSecret}>
                {busy ? (
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <KeyRound className="size-4" aria-hidden="true" />
                )}
                {busy ? "Updating..." : "Update and continue"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingNavigation !== null}>
        <DialogContent
          showCloseButton={false}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Store your recovery key</DialogTitle>
            <DialogDescription>
              This key is shown once. It restores encrypted files if you forget
              your account password.
            </DialogDescription>
          </DialogHeader>
          <code className="block break-all rounded-lg border bg-muted p-4 text-sm">
            {pendingNavigation?.recoveryCode}
          </code>
          <div className="flex items-start gap-3 text-sm">
            <Checkbox
              checked={recoveryConfirmed}
              onCheckedChange={(checked) =>
                setRecoveryConfirmed(checked === true)
              }
            />
            <span>I stored this recovery key outside Aeralyth.</span>
          </div>
          <DialogFooter>
            <Button
              type="button"
              disabled={!recoveryConfirmed}
              onClick={() => {
                if (pendingNavigation) navigate(pendingNavigation.next);
              }}
            >
              <ShieldCheck className="size-4" aria-hidden="true" />
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function InputShimmer() {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-y-0 left-0 z-10 w-[170%] rounded-2xl",
        "bg-[linear-gradient(100deg,transparent_0%,rgb(255_255_255/0.025)_18%,rgb(255_255_255/0.13)_46%,rgb(255_255_255/0.055)_66%,transparent_100%)]",
        "opacity-0 group-focus-within/input:animate-[input-shimmer-sweep_820ms_ease-out]",
      )}
    />
  );
}

async function persistLoginVaultSession(
  client: VaultCryptoClient,
  login: AccountLoginResult,
  vaultVersion: number,
) {
  await persistVaultResumeSession(
    client,
    login.csrfToken,
    login.user.vaultAutoLockMinutes,
    vaultVersion,
    vaultSessionStorage(login.user.vaultAutoLockMinutes) ??
      window.sessionStorage,
  );
}

function navigate(next: string) {
  window.location.assign(next);
}
