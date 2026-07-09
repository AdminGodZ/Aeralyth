import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { DashboardShell } from "@/features/dashboard/dashboard-shell";
import { getDashboardSection } from "@/features/dashboard/config";
import {
  type FileView,
  getAdminUsersState,
  getAuthState,
  getCsrfState,
  getFilesState,
} from "@/lib/api";

type SectionPageProps = {
  params: Promise<{
    section: string;
  }>;
  searchParams: Promise<{
    folder?: string;
  }>;
};

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: SectionPageProps): Promise<Metadata> {
  const { section: sectionKey } = await params;
  const section = getDashboardSection(sectionKey);

  if (!section) {
    return {};
  }

  return {
    title: section.title,
    description: section.subtitle,
  };
}

export default async function SectionPage({
  params,
  searchParams,
}: SectionPageProps) {
  const { section: sectionKey } = await params;
  const { folder } = await searchParams;
  const sidebarCollapsed =
    (await cookies()).get("aeralyth_sidebar_collapsed")?.value === "1";
  const section = getDashboardSection(sectionKey);

  if (!section) {
    notFound();
  }

  const authState = await getAuthState();

  if (authState.status === "unavailable") {
    redirect("/login?error=backend");
  }

  if (authState.status === "anonymous") {
    redirect("/login");
  }

  const user = authState.user;

  if (section.group === "system" && user.role !== "admin") {
    notFound();
  }

  const [csrfState, adminUsersState, filesState] = await Promise.all([
    getCsrfState(),
    section.key === "users" ? getAdminUsersState() : Promise.resolve(undefined),
    getFilesState(
      getFileView(section.key) ?? "files",
      section.key === "files" ? folder?.trim() : undefined,
    ),
  ]);

  if (csrfState.status === "unauthorized") {
    redirect("/login");
  }

  if (csrfState.status === "unavailable") {
    redirect("/login?error=backend");
  }

  if (adminUsersState?.status === "unauthorized") {
    redirect("/login");
  }

  if (filesState?.status === "unauthorized") {
    redirect("/login");
  }

  if (adminUsersState?.status === "forbidden") {
    notFound();
  }

  return (
    <DashboardShell
      sectionKey={section.key}
      currentUser={user}
      csrfToken={csrfState.token}
      initialSidebarCollapsed={sidebarCollapsed}
      adminUsersState={adminUsersState}
      filesState={filesState}
    />
  );
}

function getFileView(sectionKey: string): FileView | null {
  if (
    sectionKey === "files" ||
    sectionKey === "recent" ||
    sectionKey === "favorites" ||
    sectionKey === "shared" ||
    sectionKey === "trash"
  ) {
    return sectionKey;
  }
  return null;
}
