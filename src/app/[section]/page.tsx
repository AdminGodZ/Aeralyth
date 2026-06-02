import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { DashboardShell } from "@/features/dashboard/dashboard-shell";
import { getDashboardSection } from "@/features/dashboard/config";
import { getAuthState } from "@/lib/api";

type SectionPageProps = {
  params: Promise<{
    section: string;
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

export default async function SectionPage({ params }: SectionPageProps) {
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

  return <DashboardShell sectionKey={section.key} currentUser={user} />;
}
