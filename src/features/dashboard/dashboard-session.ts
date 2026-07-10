import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import { getAuthState, getCsrfState } from "@/lib/api";

export const getDashboardSession = cache(async () => {
  const [authState, csrfState] = await Promise.all([
    getAuthState(),
    getCsrfState(),
  ]);

  if (authState.status === "unavailable") {
    redirect("/login?error=backend");
  }

  if (authState.status === "anonymous") {
    redirect("/login");
  }

  if (csrfState.status === "unauthorized") {
    redirect("/login");
  }

  if (csrfState.status === "unavailable") {
    redirect("/login?error=backend");
  }

  return {
    csrfToken: csrfState.token,
    currentUser: authState.user,
  };
});
