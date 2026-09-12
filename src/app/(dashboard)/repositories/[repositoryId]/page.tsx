import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { getDashboardSession } from "@/features/dashboard/dashboard-session";
import { DashboardPage } from "@/features/dashboard/dashboard-shell";
import { getRepositoryDetailState } from "@/lib/api";

type RepositoryPageProps = {
  params: Promise<{ repositoryId: string }>;
  searchParams: Promise<{ cursor?: string; file?: string; folder?: string }>;
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Repository",
  description: "Browse a project repository stored in Aeralyth.",
};

export default async function RepositoryPage({
  params,
  searchParams,
}: RepositoryPageProps) {
  const [{ repositoryId }, { cursor, file, folder }] = await Promise.all([
    params,
    searchParams,
  ]);
  const { csrfToken, currentUser, realtimeCursor } =
    await getDashboardSession();
  const repositoryDetailState = await getRepositoryDetailState(
    repositoryId,
    folder?.trim() || undefined,
    cursor?.trim() || undefined,
  );

  if (repositoryDetailState.status === "unauthorized") {
    redirect("/login");
  }

  if (repositoryDetailState.status === "not-found") {
    notFound();
  }

  return (
    <DashboardPage
      sectionKey="repositories"
      currentUser={currentUser}
      csrfToken={csrfToken}
      realtimeCursor={realtimeCursor}
      filesState={{ status: "unavailable" }}
      repositoryDetailState={repositoryDetailState}
      repositoryFileId={file?.trim() || undefined}
    />
  );
}
