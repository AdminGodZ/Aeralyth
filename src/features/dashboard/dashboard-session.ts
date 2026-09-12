import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import { getSessionBootstrapState } from "@/lib/api";

export const getDashboardSession = cache(async () => {
  const session = await getSessionBootstrapState();

  if (session.status === "unavailable") {
    redirect("/login?error=backend");
  }

  if (session.status === "unauthorized") {
    redirect("/login");
  }

  return {
    csrfToken: session.csrfToken,
    currentUser: session.user,
    realtimeCursor: session.realtimeCursor,
  };
});
