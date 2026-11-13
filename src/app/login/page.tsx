import { CircleAlert, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LedMatrixBackground } from "@/components/led-matrix-background";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { popupSurfaceClassName } from "@/components/ui/popup-surface";
import { LoginCard } from "@/features/auth/login-card";
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
    <main className="dark login-page relative isolate min-h-dvh w-full overflow-hidden bg-black text-foreground">
      <LedMatrixBackground />
      {loginAlertMessage ? (
        <Alert
          className={cn(
            popupSurfaceClassName,
            "fixed left-1/2 top-5 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-full px-5 py-3 shadow-[0_24px_80px_rgb(0_0_0/0.2)] ring-0",
            loginAlertIsError
              ? "border-destructive/40 text-destructive"
              : "border-white/15 text-foreground",
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
                loginAlertIsError ? "text-destructive" : "text-foreground",
              )}
            >
              {loginAlertMessage}
            </AlertDescription>
          </div>
        </Alert>
      ) : null}
      <div className="relative z-10 mx-auto grid min-h-dvh w-full max-w-6xl items-center px-5 py-10 sm:px-8">
        <section className="grid flex-1 items-center gap-10 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(360px,420px)] lg:items-stretch">
          <div className="hidden max-w-xl flex-col lg:flex">
            {/* The background lights the Aeralyth mark inside this space. */}
            <div data-led-anchor className="h-72 w-full xl:h-80" />

            <h1 className="mt-8 text-5xl font-semibold leading-[1.05] tracking-tight">
              Private cloud access
            </h1>
            <p className="mt-5 max-w-md text-lg leading-7 text-muted-foreground">
              Your secure space for files, storage, and private Aeralyth
              workspace access.
            </p>
          </div>

          <div className="w-full max-w-md justify-self-center lg:flex lg:justify-self-end">
            <LoginCard>
              <div className="px-7 pt-10 pb-6 text-center sm:px-9">
                <h2 className="text-3xl font-semibold tracking-tight">
                  Welcome back
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Sign in to your account
                </p>
              </div>

              <div className="px-7 pb-9 sm:px-9">
                <OnePasswordLoginForm
                  backendUnavailable={backendUnavailable}
                  initialUsername={username}
                  nextPath={nextPath ?? undefined}
                />
              </div>
            </LoginCard>
          </div>
        </section>
      </div>
    </main>
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
