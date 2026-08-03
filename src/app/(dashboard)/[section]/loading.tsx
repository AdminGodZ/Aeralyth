"use client";

import { usePathname } from "next/navigation";

import { Skeleton } from "@/components/ui/skeleton";
import { getDashboardSection } from "@/features/dashboard/config";

const DASHBOARD_CARD_SKELETONS = [
  "storage-used",
  "storage-free",
  "files",
  "folders",
  "shared",
] as const;

export default function SectionLoading() {
  const pathname = usePathname();
  const section =
    getDashboardSection(pathname.split("/")[1] ?? "") ??
    getDashboardSection("files");

  if (!section) {
    return null;
  }

  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        Loading {section.title}
      </span>
      <header className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <p className="font-display text-xl font-semibold leading-6">
            {section.title}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {section.subtitle}
          </p>
        </div>
        <Skeleton className="size-9 rounded-full" />
      </header>

      {section.key === "settings" ? (
        <SettingsLoading />
      ) : (
        <DashboardDataLoading />
      )}
    </>
  );
}

function SettingsLoading() {
  return (
    <div
      className="flex flex-1 flex-col overflow-hidden px-4 sm:px-8"
      aria-busy="true"
    >
      <div className="mx-auto grid w-full max-w-5xl gap-8 py-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <div className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-4/5" />
          <Skeleton className="h-9 w-3/5" />
        </div>
        <div className="space-y-6">
          <Skeleton className="h-20 w-full" />
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-3/4" />
          </div>
        </div>
      </div>
    </div>
  );
}

function DashboardDataLoading() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-4 py-5 sm:px-6"
      aria-busy="true"
    >
      <div className="grid shrink-0 gap-3 md:grid-cols-2 xl:grid-cols-5">
        {DASHBOARD_CARD_SKELETONS.map((skeleton) => (
          <div
            key={skeleton}
            className="flex min-h-24 items-center gap-4 rounded-md border p-4"
          >
            <Skeleton className="size-9 shrink-0" />
            <div className="w-full space-y-2">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-6 w-1/3" />
            </div>
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
        <div className="flex min-h-14 items-center border-b px-4">
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="space-y-4 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-4/5" />
        </div>
      </div>
    </div>
  );
}
