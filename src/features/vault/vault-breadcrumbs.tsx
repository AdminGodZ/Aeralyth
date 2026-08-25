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
  basePath: "/files" | "/shared";
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
    useState<BreadcrumbResolutionState>({
      source: null,
      basePath,
      values: {},
    });
  const names =
    resolutionState.source === breadcrumbs &&
    resolutionState.basePath === basePath
      ? resolutionState.values
      : {};

  useEffect(() => {
    if (vault.state !== "unlocked") {
      setResolutionState((current) =>
        current.source === breadcrumbs &&
        current.basePath === basePath &&
        Object.keys(current.values).length === 0
          ? current
          : { source: breadcrumbs, basePath, values: {} },
      );
      return;
    }
    const controller = new AbortController();
    let canceled = false;
    const values: Record<string, VaultNameResolution> = {};
    const references = breadcrumbs.flatMap((breadcrumb, index) => {
      if (breadcrumb.e2eeState !== "encrypted") return [];
      if (
        breadcrumb.vaultRecordHash === null ||
        breadcrumb.vaultRecordVersion === null ||
        breadcrumb.vaultGenerationId === null
      ) {
        values[breadcrumb.id] = { status: "unavailable" };
        return [];
      }
      return [
        {
          nodeId: breadcrumb.id,
          parentId: index > 0 ? breadcrumbs[index - 1].id : null,
          recordVersion: breadcrumb.vaultRecordVersion,
          recordHash: breadcrumb.vaultRecordHash,
          generationId: breadcrumb.vaultGenerationId,
        },
      ];
    });
    const publish = (
      results: Awaited<ReturnType<typeof vault.resolveMetadata>>,
    ) => {
      for (const result of results) {
        values[result.nodeId] =
          result.status === "ready"
            ? { status: "ready", name: result.manifest.name }
            : { status: "unavailable" };
      }
      if (!canceled) {
        setResolutionState({
          source: breadcrumbs,
          basePath,
          values: { ...values },
        });
      }
    };
    void vault
      .resolveMetadata(references, {
        signal: controller.signal,
        requireServerValidation: basePath === "/shared",
        onCached: publish,
        onPriority: publish,
      })
      .then(publish)
      .catch(() => {
        if (controller.signal.aborted) return;
        for (const reference of references) {
          values[reference.nodeId] = { status: "unavailable" };
        }
        if (!canceled) {
          setResolutionState({
            source: breadcrumbs,
            basePath,
            values: { ...values },
          });
        }
      });
    return () => {
      canceled = true;
      controller.abort();
    };
  }, [basePath, breadcrumbs, vault.resolveMetadata, vault.state]);

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
