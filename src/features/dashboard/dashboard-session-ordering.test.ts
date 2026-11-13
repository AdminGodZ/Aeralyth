import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SectionPage from "@/app/(dashboard)/[section]/page";

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  admin: vi.fn(),
  files: vi.fn(),
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
  getStorageOverviewState: mocks.storage,
}));

const dataReads = [mocks.admin, mocks.files, mocks.storage];

const SECTIONS = [
  "files",
  "recent",
  "favorites",
  "shared",
  "trash",
  "users",
  "storage",
] as const;

function render(section: (typeof SECTIONS)[number]) {
  return SectionPage({
    params: Promise.resolve({ section }),
    searchParams: Promise.resolve({}),
  });
}

async function renderedCursor(rendering: ReturnType<typeof render>) {
  const element = await rendering;
  if (!isValidElement<{ realtimeCursor: string }>(element)) {
    throw new Error("The page did not render the dashboard.");
  }
  return element.props.realtimeCursor;
}

describe("dashboard replay snapshot ordering", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.bootstrap.mockResolvedValue({
      currentUser: { id: "user-1", role: "admin" },
      csrfToken: "csrf-token",
      realtimeCursor: "100",
    });
    for (const read of dataReads) {
      read.mockResolvedValue({
        status: "ready",
        data: {},
        realtimeCursor: "90",
      });
    }
  });

  it.each(SECTIONS)(
    "requests %s data without waiting for bootstrap",
    async (section) => {
      let releaseBootstrap = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseBootstrap = resolve;
      });
      mocks.bootstrap.mockImplementation(async () => {
        await gate;
        return {
          currentUser: { id: "user-1", role: "admin" },
          csrfToken: "csrf-token",
          realtimeCursor: "100",
        };
      });

      const rendering = render(section);
      await vi.waitFor(() =>
        expect(
          dataReads.reduce((count, read) => count + read.mock.calls.length, 0),
        ).toBe(1),
      );
      releaseBootstrap();

      // The snapshot's own cursor was read before its data, so it is the
      // replay fence even though bootstrap finished later.
      await expect(renderedCursor(rendering)).resolves.toBe("90");
    },
  );

  it.each(SECTIONS)(
    "falls back to the bootstrap cursor when %s data has none",
    async (section) => {
      for (const read of dataReads) {
        read.mockResolvedValue({ status: "unavailable" });
      }

      await expect(renderedCursor(render(section))).resolves.toBe("100");
    },
  );
});
