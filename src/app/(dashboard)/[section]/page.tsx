import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getDashboardSection } from "@/features/dashboard/config";
import { getDashboardSession } from "@/features/dashboard/dashboard-session";
import { DashboardPage } from "@/features/dashboard/dashboard-shell";
import {
  type FileSort,
  type FileSortDirection,
  type FilesState,
  type FileView,
  getAdminUsersState,
  getFilesState,
  getRepositoriesState,
  getStorageOverviewState,
  type RepositoriesState,
} from "@/lib/api";

type SectionPageProps = {
  params: Promise<{
    section: string;
  }>;
  searchParams: Promise<{
    folder?: string;
    sort?: string;
    direction?: string;
    cursor?: string;
    token?: string;
    q?: string;
    usersCursor?: string;
    invitationsCursor?: string;
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
  const {
    cursor,
    direction,
    folder,
    invitationsCursor,
    q,
    sort,
    token,
    usersCursor,
  } = await searchParams;
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
  // The bootstrap cursor must precede every data snapshot so changes during
  // server rendering can be replayed when the browser connects.
  const { csrfToken, currentUser, realtimeCursor } =
    await getDashboardSession();
  if (section.group === "system" && currentUser.role !== "admin") {
    notFound();
  }
  const adminUsersPromise =
    section.key === "users"
      ? getAdminUsersState({
          usersCursor: usersCursor?.trim() || undefined,
          invitationsCursor: invitationsCursor?.trim() || undefined,
          query: q?.trim() || undefined,
        })
      : Promise.resolve(undefined);
  const filesPromise = sectionNeedsFiles(section.key)
    ? getFilesState(
        getFileView(section.key) ?? "files",
        section.key === "files" || section.key === "shared"
          ? folder?.trim()
          : undefined,
        fileSort,
        fileSortDirection,
        cursor?.trim() || undefined,
      )
    : Promise.resolve<FilesState>({ status: "unavailable" });
  const repositoriesPromise =
    section.key === "repositories"
      ? getRepositoriesState(cursor?.trim() || undefined)
      : Promise.resolve<RepositoriesState>({ status: "unavailable" });
  const storagePromise =
    section.key === "storage"
      ? getStorageOverviewState()
      : Promise.resolve(undefined);
  const [adminUsersState, filesState, repositoriesState, storageState] =
    await Promise.all([
      adminUsersPromise,
      filesPromise,
      repositoriesPromise,
      storagePromise,
    ]);

  if (adminUsersState?.status === "unauthorized") {
    redirect("/login");
  }

  if (
    filesState.status === "unauthorized" ||
    storageState?.status === "unauthorized"
  ) {
    redirect("/login");
  }

  if (repositoriesState.status === "unauthorized") {
    redirect("/login");
  }

  if (
    adminUsersState?.status === "forbidden" ||
    storageState?.status === "forbidden"
  ) {
    notFound();
  }

  return (
    <DashboardPage
      sectionKey={section.key}
      currentUser={currentUser}
      csrfToken={csrfToken}
      realtimeCursor={realtimeCursor}
      invitationToken={section.key === "users" ? token?.trim() : undefined}
      adminQuery={section.key === "users" ? q?.trim() : undefined}
      adminUsersState={adminUsersState}
      filesState={filesState}
      fileSort={fileSort}
      fileSortDirection={fileSortDirection}
      repositoriesState={repositoriesState}
      storageState={storageState}
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
  return getFileView(sectionKey) !== null;
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
