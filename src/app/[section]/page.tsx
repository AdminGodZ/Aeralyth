import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { DashboardShell } from "@/features/dashboard/dashboard-shell";
import { getDashboardSection } from "@/features/dashboard/config";
import {
  type FileSort,
  type FileSortDirection,
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
    sort?: string;
    direction?: string;
    token?: string;
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
  const { direction, folder, sort, token } = await searchParams;
  const sidebarCollapsed =
    (await cookies()).get("aeralyth_sidebar_collapsed")?.value === "1";
  const section = getDashboardSection(sectionKey);

  if (!section) {
    notFound();
  }

  const requestedFileSort = normalizeFileSort(sort);
  const fileSort = requestedFileSort ?? getDefaultFileSort(section.key);
  const fileSortDirection = normalizeFileSortDirection(
    requestedFileSort ? direction : undefined,
    fileSort,
  );
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
      fileSort,
      fileSortDirection,
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
      invitationToken={section.key === "users" ? token?.trim() : undefined}
      adminUsersState={adminUsersState}
      filesState={filesState}
      fileSort={fileSort}
      fileSortDirection={fileSortDirection}
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

function normalizeFileSort(value?: string): FileSort | undefined {
  if (value === "name" || value === "size" || value === "updated") {
    return value;
  }

  return undefined;
}

function getDefaultFileSort(sectionKey: string): FileSort | undefined {
  const view = getFileView(sectionKey);

  if (!view) {
    return undefined;
  }

  return view === "files" ? "name" : "updated";
}

function normalizeFileSortDirection(
  value: string | undefined,
  sort: FileSort | undefined,
): FileSortDirection | undefined {
  if (!sort) {
    return undefined;
  }

  if (value === "asc" || value === "desc") {
    return value;
  }

  return sort === "name" ? "asc" : "desc";
}
