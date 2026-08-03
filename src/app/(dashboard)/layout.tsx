import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { getDashboardSession } from "@/features/dashboard/dashboard-session";
import { DashboardFrame } from "@/features/dashboard/dashboard-shell";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const [{ csrfToken, currentUser }, cookieStore] = await Promise.all([
    getDashboardSession(),
    cookies(),
  ]);
  const initialSidebarCollapsed =
    cookieStore.get("aeralyth_sidebar_collapsed")?.value === "1";

  return (
    <DashboardFrame
      currentUser={currentUser}
      csrfToken={csrfToken}
      initialSidebarCollapsed={initialSidebarCollapsed}
    >
      {children}
    </DashboardFrame>
  );
}
