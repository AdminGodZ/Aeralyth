"use client";

import { useEffect, useState } from "react";

import { useVault } from "@/features/vault/vault-provider";

export type RepositoryNamedNode = {
  id: string;
  name: string;
  e2eeState: "legacy" | "staged" | "encrypted";
  entryType?: "file" | "folder";
};

export function useResolvedVaultNames(nodes: RepositoryNamedNode[]) {
  const vault = useVault();
  const [encryptedNames, setEncryptedNames] = useState<Record<string, string>>(
    {},
  );
  useEffect(() => {
    if (vault.state !== "unlocked") {
      return;
    }

    let canceled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const node of nodes) {
        if (node.e2eeState !== "encrypted") {
          continue;
        }
        try {
          // Repository nodes share the vault worker/key cache, so bounded
          // sequential resolution avoids fanning out decrypt operations.
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          const manifest = await vault.openNode(node.id);
          next[node.id] = manifest.name;
        } catch {
          next[node.id] = fallbackEncryptedName(node.entryType);
        }
      }
      if (!canceled) {
        setEncryptedNames(next);
      }
    })();

    return () => {
      canceled = true;
    };
  }, [nodes, vault]);

  return {
    vaultState: vault.state,
    nameFor(node: RepositoryNamedNode) {
      if (node.e2eeState !== "encrypted") {
        return node.name;
      }

      return encryptedNames[node.id] ?? fallbackEncryptedName(node.entryType);
    },
  };
}

function fallbackEncryptedName(entryType?: "file" | "folder") {
  if (entryType === "file") {
    return "Encrypted file";
  }

  if (entryType === "folder") {
    return "Encrypted folder";
  }

  return "Encrypted repository";
}
