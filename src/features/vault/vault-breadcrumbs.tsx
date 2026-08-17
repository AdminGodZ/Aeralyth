"use client";

import { ChevronRight, Folder } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getVaultNamePresentation,
  type VaultNameResolution,
} from "@/features/vault/vault-name-presentation";
import { useVault } from "@/features/vault/vault-provider";
import type { FileSort, FileSortDirection, FolderBreadcrumb } from "@/lib/api";

type BreadcrumbResolutionState = {
  source: FolderBreadcrumb[] | null;
  values: Record<string, VaultNameResolution>;
};

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
  const [resolutionState, setResolutionState] =
    useState<BreadcrumbResolutionState>({ source: null, values: {} });
  const names =
    resolutionState.source === breadcrumbs ? resolutionState.values : {};

  useEffect(() => {
    if (vault.state !== "unlocked") {
      setResolutionState((current) =>
        current.source === breadcrumbs &&
        Object.keys(current.values).length === 0
          ? current
          : { source: breadcrumbs, values: {} },
      );
      return;
    }
    let canceled = false;
    void resolveBreadcrumbNames({
      breadcrumbs,
      openNode: vault.openNode,
      canceled: () => canceled,
      onProgress(values) {
        if (canceled) return;
        // The exact breadcrumbs array owns this snapshot; render ignores
        // results from any superseded source before this state is applied.
        setResolutionState({ source: breadcrumbs, values });
      },
    });
    return () => {
      canceled = true;
    };
  }, [breadcrumbs, vault.openNode, vault.state]);

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
        const resolution = names[breadcrumb.id];
        const presentation = getVaultNamePresentation({
          node: { ...breadcrumb, entryType: "folder" },
          unlocked: vault.state === "unlocked",
          resolution,
        });
        const label =
          presentation.status === "pending" ? (
            <>
              <Skeleton className="h-4 w-24" aria-hidden="true" />
              <span className="sr-only">Decrypting folder name</span>
            </>
          ) : (
            presentation.name
          );
        const current = index === breadcrumbs.length - 1;
        return (
          <div
            key={breadcrumb.id}
            className="flex min-w-0 items-center gap-1"
            aria-busy={presentation.status === "pending" || undefined}
          >
            <ChevronRight
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            {current || presentation.status === "pending" ? (
              <div className="max-w-52 truncate font-medium">{label}</div>
            ) : (
              <Link
                href={{
                  pathname: basePath,
                  query: { folder: breadcrumb.id, ...query },
                }}
                className="max-w-52 truncate text-muted-foreground transition-colors hover:text-foreground"
              >
                {label}
              </Link>
            )}
          </div>
        );
      })}
    </nav>
  );
}

async function resolveBreadcrumbNames({
  breadcrumbs,
  openNode,
  canceled,
  onProgress,
}: {
  breadcrumbs: FolderBreadcrumb[];
  openNode(nodeId: string): Promise<{ name: string }>;
  canceled(): boolean;
  onProgress(values: Record<string, VaultNameResolution>): void;
}): Promise<void> {
  const resolved: Record<string, VaultNameResolution> = {};
  for (const breadcrumb of breadcrumbs) {
    if (canceled()) return;
    if (breadcrumb.e2eeState !== "encrypted") continue;
    try {
      // Breadcrumbs are ordered parents first so each decrypted key seeds the next.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const manifest = await openNode(breadcrumb.id);
      resolved[breadcrumb.id] = {
        status: "ready",
        name: manifest.name,
      };
    } catch {
      resolved[breadcrumb.id] = { status: "unavailable" };
    }
    if (!canceled()) onProgress({ ...resolved });
  }
  if (!canceled()) onProgress(resolved);
}
