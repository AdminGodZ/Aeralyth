"use client";

import { preconnect } from "react-dom";

import { useVault } from "@/features/vault/vault-provider";

/**
 * Opens the connection to the bucket once transfers become possible, so the
 * first upload or download does not also pay for DNS, TCP and TLS. Bucket
 * requests are CORS fetches and XHRs without credentials, which use the
 * anonymous connection pool.
 */
export function StoragePreconnect({ origin }: { origin: string | null }) {
  const { state } = useVault();
  if (origin && (state === "unlocked" || state === "off")) {
    preconnect(origin, { crossOrigin: "anonymous" });
  }
  return null;
}
