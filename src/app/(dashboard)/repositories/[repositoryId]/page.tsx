import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { getDashboardSession } from "@/features/dashboard/dashboard-session";
import { DashboardPage } from "@/features/dashboard/dashboard-shell";
import { getRepositoryDetailState } from "@/lib/api";

type RepositoryPageProps = {
  params: Promise<{ repositoryId: string }>;
  searchParams: Promise<{ file?: string; folder?: string }>;
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
  const [{ repositoryId }, { file, folder }] = await Promise.all([
    params,
    searchParams,
  ]);
  const [{ csrfToken, currentUser }, repositoryDetailState] = await Promise.all(
    [
      getDashboardSession(),
      getRepositoryDetailState(repositoryId, folder?.trim() || undefined),
    ],
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
      filesState={{ status: "unavailable" }}
      repositoryDetailState={repositoryDetailState}
      repositoryFileId={file?.trim() || undefined}
    />
  );
}
