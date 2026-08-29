"use client";

import { ArrowRight, KeyRound, LoaderCircle } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { randomBytes, toBase64Url } from "@/features/vault/protocol";
import { VaultCryptoClient } from "@/features/vault/vault-client";

export function OnePasswordInvitationForm({
  token,
  username,
}: {
  token: string;
  username: string;
}) {
  const clientRef = useRef<VaultCryptoClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      void clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get("password") ?? "");
    const confirmation = String(data.get("password_confirmation") ?? "");
    const passwordBytes = new TextEncoder().encode(password).byteLength;

    if (password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }
    if (passwordBytes < 12 || passwordBytes > 128) {
      setError("Use a password between 12 and 128 bytes.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const salt = toBase64Url(randomBytes(16));
      if (!clientRef.current) clientRef.current = new VaultCryptoClient();
      const client = clientRef.current;
      const credential = await client.deriveAuthCredential(
        username,
        password,
        salt,
      );
      const response = await fetch(
        `/api/invitations/${encodeURIComponent(token)}/accept-one-password`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credential, salt }),
        },
      );
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          response.status === 409
            ? "This invitation can no longer be accepted."
            : detail || "The account could not be created.",
        );
      }
      const result: { username: string } = await response.json();
      window.location.assign(
        `/login?username=${encodeURIComponent(result.username)}`,
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The account could not be created.",
      );
      setBusy(false);
    }
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Account setup failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
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
            minLength={12}
            maxLength={128}
            required
            autoFocus
            disabled={busy}
            className="h-11 pl-10"
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="password-confirmation">Confirm password</Label>
        <Input
          id="password-confirmation"
          name="password_confirmation"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
          disabled={busy}
          className="h-11"
        />
      </div>
      <p className="text-sm text-muted-foreground">
        This password signs you in and unlocks your encrypted files on this
        device.
      </p>
      <Button type="submit" size="lg" className="w-full" disabled={busy}>
        {busy ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <ArrowRight className="size-4" aria-hidden="true" />
        )}
        {busy ? "Creating account..." : "Create account"}
      </Button>
    </form>
  );
}
