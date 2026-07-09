import { ArrowRight, CircleAlert, Clock3, KeyRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { AeralythLogo } from "@/components/aeralyth-logo";
import { DottedSurface } from "@/components/dotted-surface";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getInvitationState } from "@/lib/api";

export const metadata: Metadata = {
  title: "Accept invitation",
  description: "Set up your Aeralyth account.",
};

export const dynamic = "force-dynamic";

type InvitationPageProps = {
  params: Promise<{
    token: string;
  }>;
  searchParams: Promise<{
    error?: string;
  }>;
};

export default async function InvitationPage({
  params,
  searchParams,
}: InvitationPageProps) {
  const { token } = await params;
  const { error } = await searchParams;
  const invitationState = await getInvitationState(token);

  return (
    <main className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden bg-background px-5 py-10 text-foreground">
      <DottedSurface className="opacity-45" />
      <div className="relative z-10 w-full max-w-md">
        <Link
          href="/login"
          className="mx-auto mb-6 flex w-fit items-center gap-3"
        >
          <AeralythLogo className="size-11" />
          <span className="font-display text-2xl font-semibold">Aeralyth</span>
        </Link>

        {invitationState.status === "ready" ? (
          <Card className="gap-0 border bg-card/85 py-0 shadow-xl backdrop-blur-xl">
            <CardHeader className="border-b py-5">
              <CardTitle className="font-display text-2xl font-semibold">
                Set up your account
              </CardTitle>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  {invitationState.invitation.username}
                </span>
                <Badge variant="outline" className="capitalize">
                  {invitationState.invitation.role}
                </Badge>
                <span className="flex items-center gap-1">
                  <Clock3 className="size-3.5" aria-hidden="true" />
                  Expires {formatDate(invitationState.invitation.expiresAt)}
                </span>
              </div>
            </CardHeader>
            <CardContent className="py-6">
              {error ? (
                <Alert variant="destructive" className="mb-5">
                  <CircleAlert className="size-4" aria-hidden="true" />
                  <AlertTitle>Account setup failed</AlertTitle>
                  <AlertDescription>
                    {error === "weak-password"
                      ? "Use a password between 8 and 128 characters."
                      : "This invitation can no longer be accepted."}
                  </AlertDescription>
                </Alert>
              ) : null}

              <form
                action={`/api/invitations/${encodeURIComponent(token)}/accept`}
                method="post"
                className="space-y-5"
              >
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <div className="relative">
                    <KeyRound
                      className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      id="password"
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={128}
                      required
                      autoFocus
                      className="h-11 pl-10"
                    />
                  </div>
                </div>
                <Button type="submit" size="lg" className="w-full">
                  Create account
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Button>
              </form>
            </CardContent>
          </Card>
        ) : (
          <Card className="gap-0 border bg-card/85 py-0 text-center shadow-xl backdrop-blur-xl">
            <CardContent className="flex flex-col items-center py-10">
              <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <KeyRound className="size-5" aria-hidden="true" />
              </span>
              <h1 className="mt-5 font-display text-xl font-semibold">
                {invitationState.status === "invalid"
                  ? "Invitation unavailable"
                  : "Service unavailable"}
              </h1>
              <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                {invitationState.status === "invalid"
                  ? "This link has expired, was revoked, or has already been used."
                  : "The Aeralyth API could not be reached."}
              </p>
              <Button asChild variant="outline" className="mt-6">
                <Link href="/login">Return to login</Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}

function formatDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}
