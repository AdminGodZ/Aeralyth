import { afterEach, describe, expect, it, vi } from "vitest";
import {
  affectsRoute,
  mergeChanges,
  parseChanges,
  RefreshCoordinator,
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
      true,
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
    expect(refresh).toHaveBeenLastCalledWith([], true);
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
      true,
    ]);
    expect(refresh).toHaveBeenCalledTimes(3);
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

it("refreshes file pages with account-wide counters but skips unrelated settings", () => {
  const changes = [{ scope: "files" as const, folderIds: ["one"] }];
  expect(
    affectsRoute(changes, new URL("https://example.test/files?folder=two")),
  ).toBe(true);
  expect(
    affectsRoute(changes, new URL("https://example.test/files?folder=one")),
  ).toBe(true);
  expect(
    affectsRoute(
      [{ scope: "shared", folderIds: [] }],
      new URL("https://example.test/files?folder=two"),
    ),
  ).toBe(true);
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
