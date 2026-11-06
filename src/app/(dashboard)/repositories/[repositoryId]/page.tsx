import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { getDashboardSession } from "@/features/dashboard/dashboard-session";
import { DashboardPage } from "@/features/dashboard/dashboard-shell";
import { getRepositoryDetailState } from "@/lib/api";

type RepositoryPageProps = {
  params: Promise<{ repositoryId: string }>;
  searchParams: Promise<{ cursor?: string; folder?: string }>;
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
  const [{ repositoryId }, { cursor, folder }] = await Promise.all([
    params,
    searchParams,
  ]);
  // The detail response reports the replay cursor it read before its
  // snapshot, so bootstrap and the snapshot can be requested together.
  const [session, repositoryDetailState] = await Promise.all([
    getDashboardSession(),
    getRepositoryDetailState(
      repositoryId,
      folder?.trim() || undefined,
      cursor?.trim() || undefined,
    ),
  ]);
  const { csrfToken, currentUser } = session;
  const realtimeCursor =
    (repositoryDetailState.status === "ready"
      ? repositoryDetailState.realtimeCursor
      : undefined) ?? session.realtimeCursor;

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
    />
  );
}
