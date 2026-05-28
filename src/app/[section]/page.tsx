import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { DashboardShell } from "@/features/dashboard/dashboard-shell";
import { getDashboardSection } from "@/features/dashboard/config";

type SectionPageProps = {
  params: Promise<{
    section: string;
  }>;
};

export const dynamic = "force-dynamic";

type CurrentUser = {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "active" | "disabled";
};

function getApiOrigin(requestHeaders: Headers) {
  const configuredOrigin = process.env.AERALYTH_API_ORIGIN?.trim();

  if (configuredOrigin) {
    return configuredOrigin;
  }

  const host =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");

  if (!host) {
    return "http://127.0.0.1:3000";
  }

  const proto = requestHeaders.get("x-forwarded-proto") ?? "http";

  return `${proto}://${host}`;
}

async function getCurrentUser() {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");
  const apiOrigin = getApiOrigin(requestHeaders);

  try {
    const response = await fetch(`${apiOrigin}/api/auth/me`, {
      headers: cookie ? { cookie } : undefined,
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { user: CurrentUser | null };

    return data.user;
  } catch {
    return null;
  }
}

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

  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  if (section.group === "system" && user.role !== "admin") {
    notFound();
  }

  return <DashboardShell sectionKey={section.key} currentUser={user} />;
}
