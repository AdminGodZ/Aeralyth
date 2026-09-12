import { beforeEach, describe, expect, it, vi } from "vitest";

import SectionPage from "@/app/(dashboard)/[section]/page";
import RepositoryPage from "@/app/(dashboard)/repositories/[repositoryId]/page";

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  admin: vi.fn(),
  files: vi.fn(),
  repositories: vi.fn(),
  repository: vi.fn(),
  storage: vi.fn(),
}));

vi.mock("@/features/dashboard/dashboard-session", () => ({
  getDashboardSession: mocks.bootstrap,
}));
vi.mock("@/features/dashboard/dashboard-shell", () => ({
  DashboardPage: () => null,
}));
vi.mock("@/lib/api", () => ({
  getAdminUsersState: mocks.admin,
  getFilesState: mocks.files,
  getRepositoriesState: mocks.repositories,
  getRepositoryDetailState: mocks.repository,
  getStorageOverviewState: mocks.storage,
}));

const dataReads = [
  mocks.admin,
  mocks.files,
  mocks.repositories,
  mocks.repository,
  mocks.storage,
];

describe("dashboard replay snapshot ordering", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const read of dataReads) {
      read.mockResolvedValue({ status: "unavailable" });
    }
  });

  it.each([
    "files",
    "recent",
    "favorites",
    "shared",
    "trash",
    "repositories",
    "users",
    "storage",
    "repository-detail",
  ])(
    "captures the bootstrap cursor before fetching %s data",
    async (section) => {
      let releaseBootstrap = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseBootstrap = resolve;
      });
      let startedBootstrap = () => {};
      const started = new Promise<void>((resolve) => {
        startedBootstrap = resolve;
      });
      mocks.bootstrap.mockImplementation(async () => {
        startedBootstrap();
        await gate;
        return {
          currentUser: { id: "user-1", role: "admin" },
          csrfToken: "csrf-token",
          realtimeCursor: "100",
        };
      });

      const rendering =
        section === "repository-detail"
          ? RepositoryPage({
              params: Promise.resolve({ repositoryId: "repo-1" }),
              searchParams: Promise.resolve({}),
            })
          : SectionPage({
              params: Promise.resolve({ section }),
              searchParams: Promise.resolve({}),
            });
      await started;
      // Allow any erroneously parallel fetch to execute while the bootstrap
      // snapshot is still pending.
      await Promise.resolve();
      for (const read of dataReads) {
        expect(read).not.toHaveBeenCalled();
      }
      releaseBootstrap();
      await rendering;
      expect(
        dataReads.reduce((count, read) => count + read.mock.calls.length, 0),
      ).toBe(1);
    },
  );
});
