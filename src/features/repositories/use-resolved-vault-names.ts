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
  entryType?: "file" | "folder";
  updatedAt?: string;
};

type StoredVaultName = VaultNameResolution & { sourceVersion: string };

type RepositoryNameResolutionState = {
  source: RepositoryNamedNode[] | null;
  values: Record<string, StoredVaultName>;
};

const NAME_PROGRESS_BATCH_SIZE = 24;

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

    let canceled = false;
    void (async () => {
      const next: Record<string, StoredVaultName> = {};
      let encryptedProcessed = 0;
      const publishProgress = () => {
        if (canceled) return;
        setResolutionState({ source: nodes, values: { ...next } });
      };
      for (const node of nodes) {
        if (canceled) return;
        if (node.e2eeState !== "encrypted") {
          continue;
        }
        let resolution: StoredVaultName;
        try {
          // Repository nodes share the vault worker/key cache, so bounded
          // sequential resolution avoids fanning out decrypt operations.
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          const manifest = await vault.openNode(node.id);
          resolution = {
            status: "ready",
            name: manifest.name,
            sourceVersion: sourceVersion(node),
          };
        } catch {
          resolution = {
            status: "unavailable",
            sourceVersion: sourceVersion(node),
          };
        }
        next[node.id] = resolution;
        encryptedProcessed += 1;
        if (
          encryptedProcessed === 1 ||
          encryptedProcessed % NAME_PROGRESS_BATCH_SIZE === 0
        ) {
          publishProgress();
        }
      }
      if (!canceled) {
        setResolutionState({ source: nodes, values: next });
      }
    })();

    return () => {
      canceled = true;
    };
  }, [nodes, vault.openNode, vault.state]);

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
  return `${node.updatedAt ?? ""}\u0000${node.name}`;
}
