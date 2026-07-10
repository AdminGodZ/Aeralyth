import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { DashboardPage } from "@/features/dashboard/dashboard-shell";
import { getDashboardSection } from "@/features/dashboard/config";
import { getDashboardSession } from "@/features/dashboard/dashboard-session";
import {
  type FileSort,
  type FileSortDirection,
  type FileView,
  type FilesState,
  getAdminUsersState,
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
  const dashboardSessionPromise = getDashboardSession();
  const adminUsersPromise =
    section.key === "users"
      ? getAdminUsersState()
      : Promise.resolve(undefined);
  const filesPromise = sectionNeedsFiles(section.key)
    ? getFilesState(
        getFileView(section.key) ?? "files",
        section.key === "files" ? folder?.trim() : undefined,
        fileSort,
        fileSortDirection,
      )
    : Promise.resolve<FilesState>({ status: "unavailable" });
  const [{ csrfToken, currentUser }, adminUsersState, filesState] =
    await Promise.all([
      dashboardSessionPromise,
      adminUsersPromise,
      filesPromise,
    ]);

  if (section.group === "system" && currentUser.role !== "admin") {
    notFound();
  }

  if (adminUsersState?.status === "unauthorized") {
    redirect("/login");
  }

  if (filesState.status === "unauthorized") {
    redirect("/login");
  }

  if (adminUsersState?.status === "forbidden") {
    notFound();
  }

  return (
    <DashboardPage
      sectionKey={section.key}
      currentUser={currentUser}
      csrfToken={csrfToken}
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

function sectionNeedsFiles(sectionKey: string) {
  return sectionKey === "storage" || getFileView(sectionKey) !== null;
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
