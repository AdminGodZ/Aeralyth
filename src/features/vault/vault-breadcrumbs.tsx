"use client";

import { ChevronRight, Folder } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  VaultMetadataPlan,
  VaultMetadataReference,
} from "@/features/vault/protocol";
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
  metadataPlans,
  sort,
  direction,
  basePath = "/files",
}: {
  breadcrumbs: FolderBreadcrumb[];
  /** Metadata plans delivered in the same response as `breadcrumbs`. */
  metadataPlans?: VaultMetadataPlan[];
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
  // Folder names already decrypted in memory render on the first paint; the
  // effect below still resolves misses and re-validates. Shared paths must not
  // show a name before the server re-validates the grant.
  const peeked = useMemo((): Record<string, VaultNameResolution> => {
    if (basePath === "/shared") return {};
    const references = breadcrumbs.flatMap((breadcrumb, index) => {
      if (breadcrumb.e2eeState !== "encrypted") return [];
      const reference = breadcrumbMetadataReference(breadcrumbs, index);
      return reference ? [reference] : [];
    });
    return Object.fromEntries(
      vault
        .peekMetadata(references)
        .map((result) => [
          result.nodeId,
          { status: "ready", name: result.manifest.name },
        ]),
    );
  }, [basePath, breadcrumbs, vault.peekMetadata]);
  // The listing's plans also cover its entries; the path needs only its own.
  const breadcrumbPlans = useMemo(() => {
    if (!metadataPlans) return undefined;
    const ids = new Set(breadcrumbs.map((breadcrumb) => breadcrumb.id));
    return metadataPlans.filter((plan) => ids.has(plan.nodeId));
  }, [breadcrumbs, metadataPlans]);
  const names =
    resolutionState.source === breadcrumbs &&
    resolutionState.basePath === basePath
      ? { ...peeked, ...resolutionState.values }
      : peeked;

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
      const reference = breadcrumbMetadataReference(breadcrumbs, index);
      if (!reference) {
        values[breadcrumb.id] = { status: "unavailable" };
        return [];
      }
      return [reference];
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
        plans: breadcrumbPlans,
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
  }, [
    basePath,
    breadcrumbPlans,
    breadcrumbs,
    vault.resolveMetadata,
    vault.state,
  ]);

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

function breadcrumbMetadataReference(
  breadcrumbs: FolderBreadcrumb[],
  index: number,
): VaultMetadataReference | null {
  const breadcrumb = breadcrumbs[index];
  if (
    breadcrumb.vaultRecordHash === null ||
    breadcrumb.vaultRecordVersion === null ||
    breadcrumb.vaultGenerationId === null
  ) {
    return null;
  }
  return {
    nodeId: breadcrumb.id,
    parentId: index > 0 ? breadcrumbs[index - 1].id : null,
    recordVersion: breadcrumb.vaultRecordVersion,
    recordHash: breadcrumb.vaultRecordHash,
    generationId: breadcrumb.vaultGenerationId,
  };
}
