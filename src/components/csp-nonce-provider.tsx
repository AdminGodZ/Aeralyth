"use client";

import { setNonce } from "get-nonce";
import {
  createContext,
  type ReactNode,
  useContext,
  useInsertionEffect,
  useState,
} from "react";

const NonceContext = createContext<string | undefined>(undefined);

export function CspNonceProvider({
  nonce,
  children,
}: {
  nonce?: string;
  children: ReactNode;
}) {
  // Route refreshes carry a new request nonce, but the browser keeps the CSP
  // of its original document. Preserve that document's nonce until a full load.
  const [documentNonce] = useState(nonce);
  useInsertionEffect(() => {
    // react-remove-scroll inserts its styles in an effect via get-nonce.
    // Register before those effects, without sharing a nonce during SSR.
    setNonce(documentNonce ?? "");
    return () => setNonce("");
  }, [documentNonce]);

  return <NonceContext value={documentNonce}>{children}</NonceContext>;
}

export function useCspNonce(): string | undefined {
  return useContext(NonceContext);
}
