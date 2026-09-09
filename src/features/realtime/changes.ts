export const changeScopes = [
  "files",
  "shared",
  "repositories",
  "profile",
  "vault",
  "security",
  "users",
] as const;
export type ChangeScope = (typeof changeScopes)[number];
export type RealtimeChange = { scope: ChangeScope; folderIds: string[] };

export function parseChanges(data: string): RealtimeChange[] | null {
  try {
    const changes: unknown = JSON.parse(data);
    if (!Array.isArray(changes) || changes.length > changeScopes.length)
      return null;
    if (
      !changes.every(
        (change) =>
          change &&
          typeof change === "object" &&
          changeScopes.includes(change.scope) &&
          Array.isArray(change.folderIds) &&
          change.folderIds.length <= 32 &&
          change.folderIds.every(
            (id: unknown) => typeof id === "string" && id.length <= 256,
          ),
      )
    )
      return null;
    return changes;
  } catch {
    return null;
  }
}

export function mergeChanges(
  current: RealtimeChange[],
  incoming: RealtimeChange[],
): RealtimeChange[] {
  const merged = new Map(
    current.map((change) => [change.scope, change.folderIds]),
  );
  for (const { scope, folderIds } of incoming) {
    const existing = merged.get(scope);
    const folders = existing
      ? [...new Set([...existing, ...folderIds])]
      : folderIds;
    merged.set(
      scope,
      existing?.length === 0 || folderIds.length === 0 || folders.length > 32
        ? []
        : folders,
    );
  }
  return [...merged].map(([scope, folderIds]) => ({ scope, folderIds }));
}

export function affectsRoute(changes: RealtimeChange[], url: URL): boolean {
  const section = url.pathname.split("/")[1] || "files";
  return changes.some(({ scope }) => {
    if (scope === "profile" || scope === "vault" || scope === "security")
      return true;
    if (scope === "users") return section === "users";
    if (scope === "repositories") return section === "repositories";
    // File pages include account-wide counters, even inside an unrelated
    // folder. Folder IDs still limit decrypted metadata cache invalidation.
    return [
      "files",
      "shared",
      "recent",
      "favorites",
      "trash",
      "storage",
      "repositories",
    ].includes(section);
  });
}

/** One trailing refresh, bounded memory, and no starvation during bulk uploads. */
export class RefreshCoordinator {
  private changes: RealtimeChange[] = [];
  private reset = false;
  private mutations = 0;
  private visible = true;
  private refreshing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly refresh: (
      changes: RealtimeChange[],
      reset: boolean,
    ) => void,
  ) {}

  request(changes: RealtimeChange[], reset = false): void {
    this.changes = mergeChanges(this.changes, changes);
    this.reset ||= reset;
    this.schedule();
  }

  beginMutation(): () => void {
    this.mutations += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.mutations -= 1;
      // A response already in flight when the mutation began may be stale.
      this.reset = true;
      this.schedule();
    };
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.schedule();
  }
  setRefreshing(refreshing: boolean): void {
    this.refreshing = refreshing;
    this.schedule();
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }

  private schedule(): void {
    if (
      this.disposed ||
      this.timer ||
      !this.visible ||
      this.refreshing ||
      this.mutations ||
      (!this.reset && this.changes.length === 0)
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.visible || this.refreshing || this.mutations || this.disposed)
        return;
      const changes = this.changes;
      const reset = this.reset;
      this.changes = [];
      this.reset = false;
      this.refresh(changes, reset);
    }, 200);
  }
}
