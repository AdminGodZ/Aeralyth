import type { Metadata } from "next";
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
  searchParams?: Promise<{
    file?: string;
    invite?: string;
    user?: string;
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

  const [query, csrfState, adminUsersState, filesState] = await Promise.all([
    searchParams,
    getCsrfState(),
    section.key === "users" ? getAdminUsersState() : Promise.resolve(undefined),
    getFilesState(getFileView(section.key) ?? "files"),
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
      adminUsersState={adminUsersState}
      filesState={filesState}
      fileMessage={query?.file}
      userMessage={query?.user}
      inviteMessage={query?.invite}
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
