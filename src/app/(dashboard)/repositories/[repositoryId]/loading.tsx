import { Skeleton } from "@/components/ui/skeleton";
import { getDashboardSection } from "@/features/dashboard/config";

const ENTRY_SKELETON_WIDTHS = ["w-48", "w-36", "w-56", "w-40", "w-32", "w-44"];

// Dynamic-route prefetches stop at the nearest loading boundary, so this shell
// appears immediately when a repository or one of its folders is opened.
export default function RepositoryLoading() {
  const section = getDashboardSection("repositories");

  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        Loading repository
      </span>
      <header className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <p className="font-display text-xl font-semibold leading-6">
            {section?.title}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {section?.subtitle}
          </p>
        </div>
        <Skeleton className="size-9 rounded-full" />
      </header>

      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        aria-busy="true"
      >
        <div className="border-b px-4 pt-5 sm:px-6">
          <div className="mx-auto flex w-full max-w-7xl items-center gap-2 pb-4">
            <Skeleton className="size-5" />
            <Skeleton className="h-5 w-56" />
          </div>
        </div>
        <div className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-8 w-24" />
            </div>
            <div className="overflow-hidden rounded-md border">
              <div className="flex min-h-12 items-center border-b px-4">
                <Skeleton className="h-4 w-48" />
              </div>
              <div className="divide-y">
                {ENTRY_SKELETON_WIDTHS.map((width) => (
                  <div
                    key={width}
                    className="flex h-11 items-center gap-3 px-4"
                  >
                    <Skeleton className="size-4 shrink-0" />
                    <Skeleton className={`h-4 ${width}`} />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="space-y-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        </div>
      </div>
    </>
  );
}
