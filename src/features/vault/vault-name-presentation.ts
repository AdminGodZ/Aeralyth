export type VaultNamedNode = {
  name: string;
  e2eeState: "legacy" | "staged" | "encrypted";
  entryType?: "file" | "folder";
};

export type VaultNameResolution =
  | { status: "ready"; name: string }
  | { status: "unavailable" };

export type VaultNamePresentation =
  | { status: "ready" | "locked" | "unavailable"; name: string }
  | { status: "pending"; name: null };

export function getVaultNamePresentation({
  node,
  unlocked,
  resolution,
}: {
  node: VaultNamedNode;
  unlocked: boolean;
  resolution?: VaultNameResolution;
}): VaultNamePresentation {
  if (node.e2eeState !== "encrypted") {
    return { status: "ready", name: node.name };
  }

  if (!unlocked) {
    return { status: "locked", name: lockedName(node.entryType) };
  }

  if (!resolution) {
    return { status: "pending", name: null };
  }

  if (resolution.status === "unavailable") {
    return { status: "unavailable", name: "Name unavailable" };
  }

  return resolution;
}

function lockedName(entryType?: "file" | "folder"): string {
  if (entryType === "file") return "Locked file";
  if (entryType === "folder") return "Locked folder";
  return "Locked repository";
}
