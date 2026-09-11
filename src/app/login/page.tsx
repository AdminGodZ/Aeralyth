import { CircleAlert, HardDrive, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AeralythLogo } from "@/components/aeralyth-logo";
import { DarkGradientBg } from "@/components/dark-gradient-bg";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { popupSurfaceClassName } from "@/components/ui/popup-surface";
import { OnePasswordLoginForm } from "@/features/auth/one-password-login-form";
import { getAuthState } from "@/lib/api";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Login",
  description: "Sign in to Aeralyth.",
};

export const dynamic = "force-dynamic";

type LoginPageProps = {
  searchParams?: Promise<{
    error?: string;
    password?: string;
    username?: string;
    next?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const resolvedSearchParams = await searchParams;
  const error = resolvedSearchParams?.error;
  const username = resolvedSearchParams?.username;
  const nextPath = getSafeShareReturnPath(resolvedSearchParams?.next);
  const authState = await getAuthState();

  if (authState.status === "authenticated") {
    redirect(nextPath ?? "/files");
  }

  if (error === "backend" && authState.status !== "unavailable") {
    const cleanParams = new URLSearchParams({
      ...(username ? { username } : {}),
      ...(nextPath ? { next: nextPath } : {}),
    });
    redirect(cleanParams.size ? `/login?${cleanParams}` : "/login");
  }

  const invalidCredentials = error === "invalid";
  const backendUnavailable = authState.status === "unavailable";
  const passwordChanged = resolvedSearchParams?.password === "changed";
  const loginAlertMessage = backendUnavailable
    ? "Backend unavailable. Start the Actix API and try again."
    : invalidCredentials
      ? "Invalid username or password."
      : passwordChanged
        ? "Password changed. Sign in with your new password."
        : null;
  const loginAlertIsError = backendUnavailable || invalidCredentials;

  return (
    <DarkGradientBg as="main" className="login-page isolate text-foreground">
      {loginAlertMessage ? (
        <Alert
          className={cn(
            popupSurfaceClassName,
            "fixed left-1/2 top-5 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-full px-5 py-3 shadow-[0_24px_80px_rgb(0_0_0/0.2)] ring-0",
            loginAlertIsError
              ? "border-[#C90000]/30 text-[#C90000]"
              : "border-primary/30 text-primary",
          )}
        >
          <div className="flex items-center justify-center gap-2">
            {loginAlertIsError ? (
              <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
            ) : (
              <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
            )}
            <AlertDescription
              className={cn(
                "text-center leading-none",
                loginAlertIsError ? "text-[#C90000]" : "text-primary",
              )}
            >
              {loginAlertMessage}
            </AlertDescription>
          </div>
        </Alert>
      ) : null}
      <div className="mx-auto grid min-h-dvh w-full max-w-6xl items-center px-5 py-10 sm:px-8">
        <section className="grid flex-1 items-center gap-10 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(360px,420px)] lg:items-stretch">
          <div className="relative hidden max-w-2xl lg:block">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -left-20 top-16 -z-10 size-72 rounded-full bg-primary/15 blur-3xl"
            />
            <AeralythLogo className="relative mb-9 size-28" />

            <h1 className="max-w-3xl font-display text-6xl font-semibold leading-[1.02] tracking-normal">
              Private cloud access
            </h1>
            <p className="mt-6 max-w-xl text-xl leading-8 text-muted-foreground">
              Your secure space for files, storage, and private Aeralyth
              workspace access.
            </p>

            <div className="mt-11 grid max-w-xl gap-6 text-base">
              <div className="flex items-center gap-5">
                <span className="flex size-11 shrink-0 items-center justify-center text-primary">
                  <ShieldCheck className="size-5" aria-hidden="true" />
                </span>
                <span className="text-muted-foreground">
                  Protected self-hosted sessions
                </span>
              </div>
              <div className="flex items-center gap-5">
                <span className="flex size-11 shrink-0 items-center justify-center text-primary">
                  <HardDrive className="size-5" aria-hidden="true" />
                </span>
                <span className="text-muted-foreground">
                  Direct access to your storage
                </span>
              </div>
            </div>
          </div>

          <div className="w-full max-w-md justify-self-center lg:flex lg:justify-self-end">
            <Card className="h-full w-full justify-center gap-0 rounded-[2rem] border border-white/[0.08] bg-login-panel py-0 shadow-[0_24px_80px_rgb(0_0_0/0.2)] ring-0">
              <CardHeader className="items-center px-7 pt-8 pb-5 text-center sm:px-8 sm:pt-9">
                <CardTitle className="font-display text-4xl font-semibold tracking-normal text-foreground">
                  Welcome back
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  Sign in to your account
                </p>
              </CardHeader>

              <CardContent className="px-7 pb-7 sm:px-8 sm:pb-8">
                <OnePasswordLoginForm
                  backendUnavailable={backendUnavailable}
                  initialUsername={username}
                  nextPath={nextPath ?? undefined}
                />
              </CardContent>
            </Card>
          </div>
        </section>
      </div>
    </DarkGradientBg>
  );
}

function getSafeShareReturnPath(value?: string): string | null {
  const nextPath = value?.trim();
  if (
    !nextPath?.startsWith("/s/") ||
    nextPath.length > 512 ||
    /[\r\n#]/.test(nextPath)
  ) {
    return null;
  }
  return nextPath;
}
