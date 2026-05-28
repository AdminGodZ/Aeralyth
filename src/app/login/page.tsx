import {
  ArrowRight,
  HardDrive,
  LockKeyhole,
  Mail,
  ShieldCheck,
} from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";

import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Login | Aeralyth",
  description: "Sign in to Aeralyth.",
};

async function requestSignIn() {
  "use server";
}

export default function LoginPage() {
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto grid min-h-dvh w-full max-w-6xl items-center px-5 py-10 sm:px-8">
        <section className="grid flex-1 items-center gap-10 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(360px,420px)]">
          <div className="hidden max-w-xl lg:block">
            <div className="mb-6 flex size-14 items-center justify-center rounded-md border bg-card">
              <Image
                src="/Aeralyth_transparent.png"
                alt="Aeralyth logo"
                width={48}
                height={48}
                priority
                className="size-12 object-contain"
              />
            </div>
            <h1 className="font-display text-5xl font-semibold leading-tight">
              Private cloud access
            </h1>
            <p className="mt-5 max-w-lg text-base leading-7 text-muted-foreground">
              Sign in to manage files, storage, and access from your Aeralyth
              workspace.
            </p>

            <div className="mt-10 grid gap-4 text-sm">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-md border bg-card">
                  <ShieldCheck
                    className="size-4 text-primary"
                    aria-hidden="true"
                  />
                </span>
                <span className="text-muted-foreground">
                  Protected self-hosted sessions
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-md border bg-card">
                  <HardDrive
                    className="size-4 text-primary"
                    aria-hidden="true"
                  />
                </span>
                <span className="text-muted-foreground">
                  Direct access to your storage
                </span>
              </div>
            </div>
          </div>

          <div className="w-full max-w-md justify-self-center lg:justify-self-end">
            <div className="rounded-md border bg-card p-6 shadow-sm sm:p-8">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-primary">
                    Welcome back
                  </p>
                  <h2 className="mt-2 font-display text-3xl font-semibold">
                    Sign in
                  </h2>
                </div>
                <ThemeToggle className="shrink-0" />
              </div>

              <form action={requestSignIn} className="mt-8 space-y-5">
                <div className="space-y-2">
                  <label htmlFor="email" className="text-sm font-medium">
                    Email
                  </label>
                  <div className="relative">
                    <Mail
                      className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <input
                      id="email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      placeholder="name@example.com"
                      required
                      className="h-11 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label htmlFor="password" className="text-sm font-medium">
                    Password
                  </label>
                  <div className="relative">
                    <LockKeyhole
                      className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <input
                      id="password"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      placeholder="Password"
                      required
                      className="h-11 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25"
                    />
                  </div>
                </div>

                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    name="remember"
                    type="checkbox"
                    className="size-4 rounded border border-input accent-primary"
                  />
                  Keep me signed in
                </label>

                <Button
                  type="submit"
                  size="lg"
                  className="h-11 w-full rounded-md text-sm"
                >
                  Sign in
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Button>
              </form>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
