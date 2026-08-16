import {
  ArrowRight,
  CircleAlert,
  HardDrive,
  LockKeyhole,
  Mail,
  ShieldCheck,
} from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AeralythLogo } from "@/components/aeralyth-logo";
import { DottedSurface } from "@/components/dotted-surface";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { popupSurfaceClassName } from "@/components/ui/popup-surface";
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
    <main className="relative isolate min-h-dvh overflow-hidden bg-background text-foreground">
      <DottedSurface className="opacity-70" />
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
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute -top-10 left-1/2 z-0 size-full -translate-x-1/2 rounded-full",
          "bg-[radial-gradient(ellipse_at_center,--theme(--color-foreground/.1),transparent_50%)]",
          "blur-[30px]",
        )}
      />
      <div className="relative z-10 mx-auto grid min-h-dvh w-full max-w-6xl items-center px-5 py-10 sm:px-8">
        <section className="grid flex-1 items-center gap-10 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(360px,420px)] lg:items-stretch">
          <div className="relative hidden max-w-2xl lg:block">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -left-20 top-16 -z-10 size-72 rounded-full bg-primary/15 blur-3xl"
            />
            <Card className="relative isolate mb-9 flex size-20 items-center justify-center rounded-[1.75rem] border border-white/[0.07] bg-card/10 p-0 py-0 shadow-[0_20px_60px_rgb(0_0_0/0.2)] ring-0 backdrop-blur-md backdrop-saturate-150 dark:bg-card/12">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-[linear-gradient(145deg,--theme(--color-foreground/.16),transparent_36%,--theme(--color-primary/.16))]"
              />
              <AeralythLogo className="relative size-14 drop-shadow-[0_0_18px_rgb(48_136_240/0.32)]" />
            </Card>

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
            <Card className="h-full w-full justify-center gap-0 rounded-[2rem] border border-white/[0.07] bg-card/10 py-0 shadow-[0_24px_80px_rgb(0_0_0/0.2)] ring-0 backdrop-blur-md backdrop-saturate-150 dark:bg-card/12">
              <CardHeader className="items-center px-7 pt-8 pb-5 text-center sm:px-8 sm:pt-9">
                <CardTitle className="font-display text-4xl font-semibold tracking-normal text-foreground">
                  Welcome back
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  Sign in to your account
                </p>
              </CardHeader>

              <CardContent className="px-7 pb-7 sm:px-8 sm:pb-8">
                <form
                  action="/api/auth/login"
                  method="post"
                  className="space-y-5"
                >
                  {nextPath ? (
                    <input type="hidden" name="next" value={nextPath} />
                  ) : null}
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
                        defaultValue={username}
                        placeholder="john.doe"
                        required
                        aria-invalid={invalidCredentials}
                        className={cn(
                          "h-12 rounded-2xl bg-background/20 pl-11 pr-4 text-base shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] backdrop-blur-md focus-visible:ring-0",
                          invalidCredentials
                            ? "border-[#C90000]/50 focus-visible:border-[#C90000]/50"
                            : "border-white/[0.07] focus-visible:border-white/[0.07]",
                        )}
                      />
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-y-0 left-0 z-10 w-[170%] rounded-2xl bg-[linear-gradient(100deg,transparent_0%,rgb(255_255_255/0.025)_18%,rgb(255_255_255/0.13)_46%,rgb(255_255_255/0.055)_66%,transparent_100%)] opacity-0 group-focus-within/input:animate-[input-shimmer-sweep_820ms_ease-out]"
                      />
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
                        aria-invalid={invalidCredentials}
                        className={cn(
                          "h-12 rounded-2xl bg-background/20 pl-11 pr-4 text-base shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] backdrop-blur-md focus-visible:ring-0",
                          invalidCredentials
                            ? "border-[#C90000]/50 focus-visible:border-[#C90000]/50"
                            : "border-white/[0.07] focus-visible:border-white/[0.07]",
                        )}
                      />
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-y-0 left-0 z-10 w-[170%] rounded-2xl bg-[linear-gradient(100deg,transparent_0%,rgb(255_255_255/0.025)_18%,rgb(255_255_255/0.13)_46%,rgb(255_255_255/0.055)_66%,transparent_100%)] opacity-0 group-focus-within/input:animate-[input-shimmer-sweep_820ms_ease-out]"
                      />
                    </div>
                  </div>

                  <div className="group/field flex items-center gap-3">
                    <Checkbox
                      id="remember"
                      name="remember"
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
                    disabled={backendUnavailable}
                    className="h-12 w-full rounded-full bg-primary/85 text-base shadow-[0_16px_40px_color-mix(in_srgb,var(--primary)_18%,transparent)] hover:bg-primary/95"
                  >
                    Sign in
                    <ArrowRight
                      className="size-4 -translate-x-1 opacity-0 transition-[transform,opacity] group-hover/button:translate-x-0 group-hover/button:opacity-100"
                      aria-hidden="true"
                    />
                  </Button>
                </form>
              </CardContent>
            </Card>
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
