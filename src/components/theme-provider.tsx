"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type * as React from "react";
import { useCspNonce } from "@/components/csp-nonce-provider";

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  const nonce = useCspNonce();
  return (
    <NextThemesProvider {...props} nonce={nonce}>
      {children}
    </NextThemesProvider>
  );
}
