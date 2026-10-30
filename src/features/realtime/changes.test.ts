import { afterEach, describe, expect, it, vi } from "vitest";
import {
  affectsRoute,
  mergeChanges,
  parseChanges,
  RefreshCoordinator,
  SnapshotHistory,
} from "./changes";
import { applyFileListOverlay } from "./file-list-overlay";

afterEach(() => vi.useRealTimers());

describe("realtime refresh coordination", () => {
  it("coalesces a burst into bounded invalidations", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const coordinator = new RefreshCoordinator(refresh);
    for (let index = 0; index < 1000; index += 1) {
      coordinator.request([{ scope: "files", folderIds: [String(index)] }]);
    }
    vi.advanceTimersByTime(200);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(
      [{ scope: "files", folderIds: [] }],
      false,
    );
    coordinator.request([{ scope: "files", folderIds: ["next"] }]);
    vi.advanceTimersByTime(200);
    expect(refresh).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it("defers updates during a local mutation and follows an older in-flight refresh", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const coordinator = new RefreshCoordinator(refresh);
    coordinator.setRefreshing(true);
    const end = coordinator.beginMutation();
    coordinator.request([{ scope: "files", folderIds: [""] }]);
    coordinator.setRefreshing(false);
    vi.advanceTimersByTime(500);
    expect(refresh).not.toHaveBeenCalled();
    end();
    end();
    vi.advanceTimersByTime(200);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(
      [{ scope: "files", folderIds: [""] }],
      false,
    );
  });

  it("bounds deferral during real, overlapping upload and edit activity", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const coordinator = new RefreshCoordinator(refresh);
    const endUpload = coordinator.beginMutation();
    const endEdit = coordinator.beginMutation();
    coordinator.request([{ scope: "files", folderIds: ["remote"] }]);
    vi.advanceTimersByTime(900);
    coordinator.request([{ scope: "files", folderIds: ["another"] }]);
    vi.advanceTimersByTime(100);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(
      [{ scope: "files", folderIds: ["remote", "another"] }],
      false,
    );
    coordinator.setRefreshing(true);
    coordinator.request([{ scope: "shared", folderIds: [] }]);
    vi.advanceTimersByTime(2_000);
    expect(refresh).toHaveBeenCalledOnce();
    coordinator.setRefreshing(false);
    vi.advanceTimersByTime(200);
    expect(refresh).toHaveBeenCalledTimes(2);
    endUpload();
    endEdit();
    vi.advanceTimersByTime(200);
    expect(refresh).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it("refreshes a confirmed local mutation at once and settles after its refresh", async () => {
    vi.useFakeTimers();
    let coordinator: RefreshCoordinator;
    const refresh = vi.fn((changes: unknown[]) => {
      if (changes.length) coordinator.setRefreshing(true);
    });
    coordinator = new RefreshCoordinator(refresh);
    const endUpload = coordinator.beginMutation();
    coordinator.request([{ scope: "paths", folderIds: [] }]);
    let settled = false;
    const done = coordinator
      .requestNow([{ scope: "files", folderIds: [""] }])
      .then(() => {
        settled = true;
      });
    vi.advanceTimersByTime(0);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(
      [
        { scope: "paths", folderIds: [] },
        { scope: "files", folderIds: [""] },
      ],
      false,
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    // The event for the same upload trails the in-flight refresh, batched.
    coordinator.request([{ scope: "files", folderIds: [""] }]);
    coordinator.setRefreshing(false);
    await done;
    vi.advanceTimersByTime(500);
    expect(refresh).toHaveBeenCalledOnce();
    endUpload();
    vi.advanceTimersByTime(500);
    expect(refresh).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it("settles a confirmed mutation at once when the route is unaffected", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const coordinator = new RefreshCoordinator(refresh);
    const done = coordinator.requestNow([{ scope: "files", folderIds: ["A"] }]);
    vi.advanceTimersByTime(0);
    await done;
    expect(refresh).toHaveBeenCalledOnce();
    coordinator.dispose();
  });

  it("does not turn a completed mutation in A into a reset after navigating to B", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const coordinator = new RefreshCoordinator(refresh);
    const end = coordinator.beginMutation();
    const currentRoute = new URL("https://example.test/files?folder=B");
    const changes = [{ scope: "files" as const, folderIds: ["A"] }];
    coordinator.request(changes);
    end();
    vi.advanceTimersByTime(200);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(changes, false);
    expect(affectsRoute(refresh.mock.calls[0][0], currentRoute)).toBe(false);
    coordinator.beginMutation()();
    vi.advanceTimersByTime(2_000);
    expect(refresh).toHaveBeenCalledOnce();
    coordinator.dispose();
  });

  it("waits for the durable scoped event when a mutation completes before publication", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const coordinator = new RefreshCoordinator(refresh);
    coordinator.beginMutation()();
    vi.advanceTimersByTime(2_000);
    expect(refresh).not.toHaveBeenCalled();
    const changes = [{ scope: "files" as const, folderIds: ["B"] }];
    coordinator.request(changes);
    vi.advanceTimersByTime(200);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(changes, false);
    expect(
      affectsRoute(changes, new URL("https://example.test/files?folder=B")),
    ).toBe(true);
    coordinator.dispose();
  });

  it("keeps hidden-tab invalidations until resume and cancels work on unmount", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const coordinator = new RefreshCoordinator(refresh);
    coordinator.request([], true);
    coordinator.setVisible(false);
    vi.advanceTimersByTime(1000);
    expect(refresh).not.toHaveBeenCalled();
    coordinator.setVisible(true);
    vi.advanceTimersByTime(200);
    expect(refresh).toHaveBeenCalledOnce();
    coordinator.request([], true);
    coordinator.dispose();
    vi.advanceTimersByTime(1000);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("never extends the deadline when short mutations keep finishing", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const coordinator = new RefreshCoordinator(refresh);
    const endUpload = coordinator.beginMutation();
    coordinator.request([{ scope: "files", folderIds: ["remote"] }]);
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(100);
      coordinator.beginMutation()();
    }
    expect(refresh.mock.calls[0]).toEqual([
      [{ scope: "files", folderIds: ["remote"] }],
      false,
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    endUpload();
    coordinator.dispose();
  });
});

it("limits and validates event payloads", () => {
  expect(parseChanges("not JSON")).toBeNull();
  expect(parseChanges('[{"scope":"admin-all","folderIds":[]}]')).toBeNull();
  expect(parseChanges('[{"scope":"files","folderIds":[42]}]')).toBeNull();
  expect(parseChanges('[{"scope":"files","folderIds":[""]}]')).toEqual([
    { scope: "files", folderIds: [""] },
  ]);
  expect(
    mergeChanges(
      [{ scope: "files", folderIds: [] }],
      [{ scope: "files", folderIds: ["one"] }],
    ),
  ).toEqual([{ scope: "files", folderIds: [] }]);
});

it("refreshes only relevant folders and account-wide collections", () => {
  const changes = [{ scope: "files" as const, folderIds: ["one"] }];
  expect(
    affectsRoute(changes, new URL("https://example.test/files?folder=two")),
  ).toBe(false);
  expect(
    affectsRoute(changes, new URL("https://example.test/files?folder=one")),
  ).toBe(true);
  expect(
    affectsRoute(
      [{ scope: "shared", folderIds: [] }],
      new URL("https://example.test/files?folder=two"),
    ),
  ).toBe(false);
  expect(affectsRoute(changes, new URL("https://example.test/trash"))).toBe(
    true,
  );
  expect(affectsRoute(changes, new URL("https://example.test/settings"))).toBe(
    false,
  );
  expect(
    affectsRoute(
      [{ scope: "shared", folderIds: [] }],
      new URL("https://example.test/shared?folder=one"),
    ),
  ).toBe(true);
});

it("does not resurrect an optimistic deletion or revert a favorite from an older refresh", () => {
  const removed = new Set(["deleted"]);
  const favorites = new Map([["starred", true]]);
  expect(
    applyFileListOverlay(
      [
        { id: "deleted", favorite: false },
        { id: "starred", favorite: false },
      ],
      removed,
      favorites,
      false,
    ),
  ).toEqual([{ id: "starred", favorite: true }]);
  applyFileListOverlay(
    [{ id: "starred", favorite: true }],
    removed,
    favorites,
    false,
  );
  expect(removed.size).toBe(0);
  expect(favorites.size).toBe(0);
});

it("refreshes parent moves/renames, root membership, broad resets, and security changes", () => {
  const current = new URL("https://example.test/files?folder=child");
  expect(
    affectsRoute([{ scope: "paths", folderIds: ["ancestor"] }], current, [
      "ancestor",
      "child",
    ]),
  ).toBe(true);
  expect(
    affectsRoute(
      [{ scope: "files", folderIds: [""] }],
      new URL("https://example.test/files"),
    ),
  ).toBe(true);
  expect(affectsRoute([{ scope: "files", folderIds: [] }], current)).toBe(true);
  for (const scope of ["security", "vault", "profile"] as const)
    expect(affectsRoute([{ scope, folderIds: [] }], current)).toBe(true);
});

describe("server snapshot reconciliation", () => {
  it("replays an event skipped in A after B's older navigation snapshot commits", () => {
    const history = new SnapshotHistory("10");
    const changes = [{ scope: "files" as const, folderIds: ["B"] }];
    history.record(changes, false, "11");
    expect(
      affectsRoute(changes, new URL("https://example.test/files?folder=A")),
    ).toBe(false);
    const replay = history.since("10");
    expect(replay.reset).toBe(false);
    expect(
      affectsRoute(
        replay.changes,
        new URL("https://example.test/files?folder=B"),
      ),
    ).toBe(true);
    expect(history.since("11")).toEqual({ changes: [], reset: false });
  });

  it("keeps unchanged checkpoint coverage without growing event history", () => {
    const history = new SnapshotHistory("10", 2);
    for (let cursor = 11; cursor < 1000; cursor++)
      history.checkpoint(String(cursor));
    expect(history.since("10")).toEqual({ changes: [], reset: false });
    history.record([{ scope: "files", folderIds: ["B"] }], false, "1000");
    expect(history.since("999").changes).toEqual([
      { scope: "files", folderIds: ["B"] },
    ]);
  });

  it("resets when a page predates retained changes or a server replay gap", () => {
    const history = new SnapshotHistory("10", 2);
    history.record([{ scope: "files", folderIds: ["A"] }], false, "11");
    history.record([{ scope: "files", folderIds: ["B"] }], false, "12");
    history.record([], true, "13");
    expect(history.since("10").reset).toBe(true);
    expect(history.since("12")).toEqual({ changes: [], reset: true });
    expect(history.since("13")).toEqual({ changes: [], reset: false });
  });
});

it("does not mistake changes to a parent listing for renamed ancestor metadata", () => {
  const current = new URL("https://example.test/files?folder=B");
  const ancestors = ["A", "B"];
  expect(
    affectsRoute(
      [{ scope: "files", folderIds: ["A", "C"] }],
      current,
      ancestors,
    ),
  ).toBe(false);
  expect(
    affectsRoute([{ scope: "paths", folderIds: ["A"] }], current, ancestors),
  ).toBe(true);
  expect(
    affectsRoute([{ scope: "paths", folderIds: ["C"] }], current, ancestors),
  ).toBe(false);
});
