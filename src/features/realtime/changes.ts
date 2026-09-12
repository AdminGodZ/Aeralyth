export const changeScopes = [
  "files",
  "paths",
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

export function affectsRoute(
  changes: RealtimeChange[],
  url: URL,
  ancestorFolderIds: readonly string[] = [],
): boolean {
  const section = url.pathname.split("/")[1] || "files";
  const currentFolderId = url.searchParams.get("folder") ?? "";
  return changes.some(({ scope, folderIds }) => {
    if (scope === "profile" || scope === "vault" || scope === "security")
      return true;
    if (scope === "users") return section === "users";
    if (scope === "repositories") return section === "repositories";
    if (scope === "shared") return section === "shared";
    if (scope === "paths") {
      return (
        ["files", "shared"].includes(section) &&
        (folderIds.length === 0 ||
          folderIds.some(
            (id) => id === currentFolderId || ancestorFolderIds.includes(id),
          ))
      );
    }
    if (section === "files") {
      return folderIds.length === 0 || folderIds.includes(currentFolderId);
    }
    // These are account-wide collections, or repository aggregates whose
    // membership can change when a file elsewhere in their tree changes.
    return ["recent", "favorites", "trash", "storage", "repositories"].includes(
      section,
    );
  });
}

/** Reconcile route snapshots that commit after their events were consumed. */
export class SnapshotHistory {
  private changes: {
    cursor: bigint;
    changes: RealtimeChange[];
    reset: boolean;
  }[] = [];
  private floor: bigint;
  private head: bigint;

  constructor(
    initialCursor: string,
    private readonly limit = 512,
  ) {
    this.floor = BigInt(initialCursor);
    this.head = this.floor;
  }

  checkpoint(cursor: string): void {
    const next = BigInt(cursor);
    if (next > this.head) this.head = next;
  }

  record(changes: RealtimeChange[], reset: boolean, cursor: string): void {
    const next = BigInt(cursor);
    if (next < this.head && reset) {
      this.changes = [];
      this.floor = next;
    }
    this.head = next;
    this.changes.push({ cursor: next, changes, reset });
    while (this.changes.length > this.limit) {
      const oldest = this.changes.shift();
      if (oldest) this.floor = oldest.cursor;
    }
  }

  since(cursor: string): { changes: RealtimeChange[]; reset: boolean } {
    const fence = BigInt(cursor);
    if (fence < this.floor) return { changes: [], reset: true };
    const result = { changes: [] as RealtimeChange[], reset: false };
    for (const update of this.changes) {
      if (update.cursor <= fence) continue;
      result.changes = mergeChanges(result.changes, update.changes);
      result.reset ||= update.reset;
    }
    return result;
  }
}

/** One trailing refresh, bounded memory, and no starvation during bulk uploads. */
export class RefreshCoordinator {
  private changes: RealtimeChange[] = [];
  private reset = false;
  private mutations = 0;
  private pendingSince: number | undefined;
  private visible = true;
  private refreshing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerDeadline = 0;
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
    if (this.reset || this.changes.length) this.pendingSince ??= Date.now();
    this.schedule();
  }

  beginMutation(): () => void {
    this.mutations += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.mutations -= 1;
      // Drain scoped durable events. Page snapshot fences reconcile any
      // response that read data before the mutation committed.
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
      !this.visible ||
      this.refreshing ||
      (!this.reset && this.changes.length === 0)
    )
      return;
    const delay = Math.max(
      200,
      this.mutations
        ? 1_000 - (Date.now() - (this.pendingSince ?? Date.now()))
        : 0,
    );
    const deadline = Date.now() + delay;
    // Completion may bring a refresh forward, but must never postpone one.
    if (this.timer && this.timerDeadline <= deadline) return;
    clearTimeout(this.timer);
    this.timerDeadline = deadline;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.visible || this.refreshing || this.disposed) return;
      if (
        this.mutations &&
        Date.now() - (this.pendingSince ?? Date.now()) < 1_000
      ) {
        this.schedule();
        return;
      }
      const changes = this.changes;
      const reset = this.reset;
      this.changes = [];
      this.reset = false;
      this.pendingSince = undefined;
      this.refresh(changes, reset);
    }, delay);
  }
}
