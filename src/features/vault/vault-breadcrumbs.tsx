"use client";

import { ChevronRight, Folder } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useVault } from "@/features/vault/vault-provider";
import type { FileSort, FileSortDirection, FolderBreadcrumb } from "@/lib/api";

export function VaultBreadcrumbs({
  breadcrumbs,
  sort,
  direction,
  basePath = "/files",
}: {
  breadcrumbs: FolderBreadcrumb[];
  sort?: FileSort;
  direction?: FileSortDirection;
  basePath?: "/files" | "/shared";
}) {
  const vault = useVault();
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (vault.state !== "unlocked") return;
    let canceled = false;
    void (async () => {
      const resolved: Record<string, string> = {};
      for (const breadcrumb of breadcrumbs) {
        if (breadcrumb.e2eeState !== "encrypted") continue;
        // Breadcrumbs are ordered parents first so each decrypted key seeds the next.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const manifest = await vault.openNode(breadcrumb.id);
        resolved[breadcrumb.id] = manifest.name;
      }
      if (!canceled) setNames(resolved);
    })().catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, [breadcrumbs, vault]);

  const query = sort
    ? { sort, ...(direction ? { direction } : {}) }
    : undefined;

  return (
    <nav className="flex min-w-0 items-center gap-1" aria-label="Folder path">
      <Button asChild variant="ghost" size="sm" className="shrink-0">
        <Link href={{ pathname: basePath, query }}>
          <Folder className="size-4" aria-hidden="true" />
          Files
        </Link>
      </Button>
      {breadcrumbs.map((breadcrumb, index) => {
        const name =
          breadcrumb.e2eeState === "encrypted"
            ? (names[breadcrumb.id] ?? "Encrypted folder")
            : breadcrumb.name;
        const current = index === breadcrumbs.length - 1;
        return (
          <span key={breadcrumb.id} className="flex min-w-0 items-center gap-1">
            <ChevronRight
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            {current ? (
              <span className="max-w-52 truncate font-medium">{name}</span>
            ) : (
              <Link
                href={{
                  pathname: basePath,
                  query: { folder: breadcrumb.id, ...query },
                }}
                className="max-w-52 truncate text-muted-foreground transition-colors hover:text-foreground"
              >
                {name}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
