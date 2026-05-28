import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DashboardShell } from "@/features/dashboard/dashboard-shell";
import { getDashboardSection } from "@/features/dashboard/config";
import { requireUser } from "@/lib/auth/session";

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

  await requireUser();

  return <DashboardShell sectionKey={section.key} />;
}
