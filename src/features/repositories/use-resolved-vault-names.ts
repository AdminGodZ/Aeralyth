"use client";

import { useEffect, useState } from "react";

import {
  getVaultNamePresentation,
  type VaultNameResolution,
} from "@/features/vault/vault-name-presentation";
import { useVault } from "@/features/vault/vault-provider";

export type RepositoryNamedNode = {
  id: string;
  name: string;
  e2eeState: "legacy" | "staged" | "encrypted";
  parentId?: string | null;
  entryType?: "file" | "folder";
  updatedAt?: string;
  vaultGenerationId: string | null;
  vaultRecordVersion: number | null;
  vaultRecordHash: string | null;
};

type StoredVaultName = VaultNameResolution & { sourceVersion: string };

type RepositoryNameResolutionState = {
  source: RepositoryNamedNode[] | null;
  values: Record<string, StoredVaultName>;
};

export function useResolvedVaultNames(nodes: RepositoryNamedNode[]) {
  const vault = useVault();
  const [resolutionState, setResolutionState] =
    useState<RepositoryNameResolutionState>({ source: null, values: {} });
  const encryptedNames =
    resolutionState.source === nodes ? resolutionState.values : {};
  useEffect(() => {
    if (vault.state !== "unlocked") {
      setResolutionState((current) =>
        current.source === nodes && Object.keys(current.values).length === 0
          ? current
          : { source: nodes, values: {} },
      );
      return;
    }

    const controller = new AbortController();
    let canceled = false;
    const next: Record<string, StoredVaultName> = {};
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const references = nodes.flatMap((node) => {
      if (node.e2eeState !== "encrypted") return [];
      if (
        node.vaultGenerationId === null ||
        node.vaultRecordVersion === null ||
        node.vaultRecordHash === null
      ) {
        next[node.id] = {
          status: "unavailable",
          sourceVersion: sourceVersion(node),
        };
        return [];
      }
      return [
        {
          nodeId: node.id,
          parentId: node.parentId ?? null,
          recordVersion: node.vaultRecordVersion,
          recordHash: node.vaultRecordHash,
          generationId: node.vaultGenerationId,
        },
      ];
    });
    const publish = (
      results: Awaited<ReturnType<typeof vault.resolveMetadata>>,
    ) => {
      for (const result of results) {
        const node = nodesById.get(result.nodeId);
        if (!node || result.recordHash !== node.vaultRecordHash) continue;
        next[node.id] =
          result.status === "ready"
            ? {
                status: "ready",
                name: result.manifest.name,
                sourceVersion: sourceVersion(node),
              }
            : {
                status: "unavailable",
                sourceVersion: sourceVersion(node),
              };
      }
      if (!canceled) {
        setResolutionState({ source: nodes, values: { ...next } });
      }
    };
    void vault
      .resolveMetadata(references, {
        signal: controller.signal,
        onCached: publish,
        onPriority: publish,
      })
      .then(publish)
      .catch(() => {
        if (controller.signal.aborted) return;
        for (const reference of references) {
          const node = nodesById.get(reference.nodeId);
          if (!node) continue;
          next[node.id] = {
            status: "unavailable",
            sourceVersion: sourceVersion(node),
          };
        }
        if (!canceled) {
          setResolutionState({ source: nodes, values: { ...next } });
        }
      });

    return () => {
      canceled = true;
      controller.abort();
    };
  }, [nodes, vault.resolveMetadata, vault.state]);

  function presentationFor(node: RepositoryNamedNode) {
    const stored = encryptedNames[node.id];
    return getVaultNamePresentation({
      node,
      unlocked: vault.state === "unlocked",
      resolution:
        stored?.sourceVersion === sourceVersion(node) ? stored : undefined,
    });
  }

  return {
    presentationFor,
  };
}

function sourceVersion(node: RepositoryNamedNode): string {
  return node.vaultRecordHash ?? `${node.updatedAt ?? ""}\u0000${node.name}`;
}
