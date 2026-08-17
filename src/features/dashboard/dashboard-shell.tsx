import {
  ChevronRight,
  FileText,
  Folder,
  HardDrive,
  type LucideIcon,
  Search,
  Share2,
  Star,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { AeralythLogo } from "@/components/aeralyth-logo";
import { FileEmptyIllustration } from "@/components/file-empty-illustration";
import { Button } from "@/components/ui/button";
import {
  type DashboardSection,
  type DashboardSectionKey,
  getDashboardSection,
} from "@/features/dashboard/config";
import { DashboardSidebar } from "@/features/dashboard/dashboard-sidebar";
import { ProfileSettingsForm } from "@/features/dashboard/profile-settings-form";
import { UploadPanel } from "@/features/dashboard/upload-panel";
import { UserPreferenceHydrator } from "@/features/dashboard/user-preference-hydrator";
import { UsersContent as UsersDirectory } from "@/features/dashboard/users-content";
import { RepositoryDetail } from "@/features/repositories/repository-detail";
import { RepositoryOverview } from "@/features/repositories/repository-overview";
import { VaultBreadcrumbs } from "@/features/vault/vault-breadcrumbs";
import { VaultFileList } from "@/features/vault/vault-file-list";
import { VaultProvider } from "@/features/vault/vault-provider";
import {
  DEFAULT_ACCENT_COLOR,
  getAccentCssProperties,
  normalizeAccentColor,
} from "@/lib/accent-color";
import type {
  AdminUsersState,
  CurrentUser,
  FileSort,
  FileSortDirection,
  FilesState,
  FolderBreadcrumb,
  RepositoriesState,
  RepositoryDetailState,
} from "@/lib/api";

type DashboardFrameProps = {
  children: ReactNode;
  currentUser: CurrentUser;
  csrfToken: string;
  initialSidebarCollapsed: boolean;
};

type DashboardPageProps = {
  sectionKey: DashboardSectionKey;
  currentUser: CurrentUser;
  csrfToken: string;
  invitationToken?: string;
  adminQuery?: string;
  adminUsersState?: AdminUsersState;
  filesState: FilesState;
  fileSort?: FileSort;
  fileSortDirection?: FileSortDirection;
  repositoriesState?: RepositoriesState;
  repositoryDetailState?: RepositoryDetailState;
  repositoryFileId?: string;
};

type ReadyFilesState = Extract<FilesState, { status: "ready" }>;

export function DashboardFrame({
  children,
  currentUser,
  csrfToken,
  initialSidebarCollapsed,
}: DashboardFrameProps) {
  const accentColor =
    normalizeAccentColor(currentUser.accentColor) ?? DEFAULT_ACCENT_COLOR;
  const dashboardStyle = getAccentCssProperties(accentColor) as CSSProperties;

  return (
    <main
      data-accent-color-scope
      className="flex min-h-dvh bg-sidebar text-foreground"
      style={dashboardStyle}
    >
      <UserPreferenceHydrator
        accentColor={accentColor}
        themePreference={currentUser.themePreference}
      />
      <VaultProvider
        csrfToken={csrfToken}
        e2eeMode={currentUser.e2eeMode}
        vaultConfigured={currentUser.vaultConfigured}
        autoLockMinutes={currentUser.vaultAutoLockMinutes}
      >
        <DashboardSidebar
          canViewSystemNavigation={currentUser.role === "admin"}
          csrfToken={csrfToken}
          initialCollapsed={initialSidebarCollapsed}
        />

        <section className="dashboard-main-panel flex min-w-0 flex-1 flex-col bg-background lg:mt-4 lg:min-h-[calc(100dvh-1rem)] lg:overflow-hidden lg:rounded-tl-3xl">
          {children}
        </section>
      </VaultProvider>
    </main>
  );
}

export function DashboardPage({
  sectionKey,
  currentUser,
  csrfToken,
  invitationToken,
  adminQuery,
  adminUsersState,
  filesState,
  fileSort,
  fileSortDirection,
  repositoriesState,
  repositoryDetailState,
  repositoryFileId,
}: DashboardPageProps) {
  const section =
    getDashboardSection(sectionKey) ?? getDashboardSection("files");

  if (!section) {
    return null;
  }

  return (
    <>
      <TopBar section={section} currentUser={currentUser} />
      <DashboardContent
        section={section}
        currentUser={currentUser}
        csrfToken={csrfToken}
        invitationToken={invitationToken}
        adminQuery={adminQuery}
        adminUsersState={adminUsersState}
        filesState={filesState}
        fileSort={fileSort}
        fileSortDirection={fileSortDirection}
        repositoriesState={repositoriesState}
        repositoryDetailState={repositoryDetailState}
        repositoryFileId={repositoryFileId}
      />
    </>
  );
}

function TopBar({
  section,
  currentUser,
}: {
  section: DashboardSection;
  currentUser: CurrentUser;
}) {
  return (
    <header className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-3 border-b px-4 py-3 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,34rem)_minmax(0,1fr)] lg:items-center">
      <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-3">
        <AeralythLogo className="size-9 lg:hidden" />
        <div className="min-w-0">
          <p className="font-display text-xl font-semibold leading-6">
            {section.title}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {section.subtitle}
          </p>
        </div>
      </div>

      {section.searchPlaceholder ? (
        <div className="col-span-2 min-w-0 lg:col-span-1 lg:col-start-2 lg:row-start-1 lg:w-full lg:justify-self-center">
          <SearchInput placeholder={section.searchPlaceholder} />
        </div>
      ) : null}

      <div className="col-start-2 row-start-1 flex min-w-0 flex-wrap items-center justify-end gap-2 self-center lg:col-start-3">
        {section.actions?.map((action) => (
          <Button
            key={action.label}
            type="button"
            variant={action.variant}
            className="rounded-full"
          >
            <action.icon className="size-4" aria-hidden="true" />
            {action.label}
          </Button>
        ))}
        <ProfileLink currentUser={currentUser} />
      </div>
    </header>
  );
}

function ProfileLink({ currentUser }: { currentUser: CurrentUser }) {
  const profileName = getProfileName(currentUser);

  return (
    <Link
      href="/settings"
      className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-background text-sm font-semibold text-primary transition-colors hover:bg-muted"
      title={profileName}
      aria-label={`Open settings for ${profileName}`}
    >
      <UserAvatar currentUser={currentUser} />
    </Link>
  );
}

function UserAvatar({ currentUser }: { currentUser: CurrentUser }) {
  const profileName = getProfileName(currentUser);

  if (currentUser.profileImageUrl) {
    return (
      <Image
        src={currentUser.profileImageUrl}
        alt=""
        width={36}
        height={36}
        unoptimized
        className="size-full object-cover"
      />
    );
  }

  return <span>{getInitials(profileName)}</span>;
}

function getProfileName(currentUser: CurrentUser) {
  return currentUser.displayName?.trim() || currentUser.username;
}

function SearchInput({
  placeholder,
  className,
}: {
  placeholder: string;
  className?: string;
}) {
  return (
    <div className={`relative min-w-0 ${className ?? ""}`}>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        className="h-10 w-full rounded-full border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary"
      />
    </div>
  );
}

function DashboardContent({
  section,
  currentUser,
  csrfToken,
  invitationToken,
  adminQuery,
  adminUsersState,
  filesState,
  fileSort,
  fileSortDirection,
  repositoriesState,
  repositoryDetailState,
  repositoryFileId,
}: {
  section: DashboardSection;
  currentUser: CurrentUser;
  csrfToken: string;
  invitationToken?: string;
  adminQuery?: string;
  adminUsersState?: AdminUsersState;
  filesState: FilesState;
  fileSort?: FileSort;
  fileSortDirection?: FileSortDirection;
  repositoriesState?: RepositoriesState;
  repositoryDetailState?: RepositoryDetailState;
  repositoryFileId?: string;
}) {
  if (section.key === "settings") {
    return <SettingsContent currentUser={currentUser} csrfToken={csrfToken} />;
  }

  if (section.key === "users") {
    return (
      <UsersDirectory
        currentUser={currentUser}
        csrfToken={csrfToken}
        invitationToken={invitationToken}
        initialQuery={adminQuery}
        adminUsersState={adminUsersState}
      />
    );
  }

  if (section.key === "storage") {
    return <StorageContent filesState={filesState} />;
  }

  if (section.key === "repositories") {
    if (repositoryDetailState) {
      return (
        <RepositoryDetail
          csrfToken={csrfToken}
          repositoryState={repositoryDetailState}
          selectedFileId={repositoryFileId}
        />
      );
    }

    return (
      <RepositoryOverview
        repositoriesState={repositoriesState ?? { status: "unavailable" }}
        csrfToken={csrfToken}
        e2eeMode={currentUser.e2eeMode}
        ownerUsername={currentUser.username}
      />
    );
  }

  return (
    <FileContent
      section={section}
      filesState={filesState}
      csrfToken={csrfToken}
      folderZipPromptEnabled={currentUser.folderZipPromptEnabled !== false}
      e2eeMode={currentUser.e2eeMode}
      currentUserId={currentUser.id}
      fileSort={fileSort}
      fileSortDirection={fileSortDirection}
    />
  );
}

function SettingsContent({
  currentUser,
  csrfToken,
}: {
  currentUser: CurrentUser;
  csrfToken: string;
}) {
  return (
    <div className="flex flex-1 flex-col overflow-auto px-4 sm:px-8">
      <div className="mx-auto w-full max-w-5xl">
        <ProfileSettingsForm currentUser={currentUser} csrfToken={csrfToken} />
      </div>
    </div>
  );
}

function FileContent({
  section,
  filesState,
  csrfToken,
  folderZipPromptEnabled,
  e2eeMode,
  currentUserId,
  fileSort,
  fileSortDirection,
}: {
  section: DashboardSection;
  filesState: FilesState;
  csrfToken: string;
  folderZipPromptEnabled: boolean;
  e2eeMode: "off" | "migrate" | "required";
  currentUserId: string;
  fileSort?: FileSort;
  fileSortDirection?: FileSortDirection;
}) {
  if (!hasReadyFilesState(filesState)) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6 px-4 py-5 sm:px-6">
        <section className="rounded-md border p-5">
          <p className="font-medium">Files unavailable</p>
          <p className="mt-2 text-sm text-muted-foreground">
            The files API is not reachable.
          </p>
        </section>
      </div>
    );
  }

  const {
    breadcrumbs,
    currentFolderId,
    entries,
    hasMore,
    nextCursor,
    summary,
  } = filesState.data;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-4 py-5 sm:px-6">
      <div className="grid shrink-0 gap-3 md:grid-cols-2 xl:grid-cols-5">
        <FileMetric
          icon={FileText}
          label="Files"
          value={String(summary.totalFiles)}
        />
        <FileMetric
          icon={Folder}
          label="Folders"
          value={String(summary.totalFolders)}
        />
        <FileMetric
          icon={Star}
          label="Favorites"
          value={String(summary.favoriteFiles)}
        />
        <FileMetric
          icon={Share2}
          label="Shared with me"
          value={String(summary.sharedFiles)}
        />
        <FileMetric
          icon={HardDrive}
          label="Storage used"
          value={formatBytes(summary.usedBytes)}
        />
      </div>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border">
        {section.key === "files" || section.key === "shared" ? (
          <div className="flex min-h-16 shrink-0 flex-col justify-center gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            {e2eeMode === "off" ? (
              <FolderBreadcrumbs
                breadcrumbs={breadcrumbs}
                sort={fileSort}
                direction={fileSortDirection}
                basePath={section.key === "shared" ? "/shared" : "/files"}
              />
            ) : (
              <VaultBreadcrumbs
                breadcrumbs={breadcrumbs}
                sort={fileSort}
                direction={fileSortDirection}
                basePath={section.key === "shared" ? "/shared" : "/files"}
              />
            )}
            {section.key === "files" ? (
              <UploadPanel
                csrfToken={csrfToken}
                e2eeMode={e2eeMode}
                parentFolderId={currentFolderId}
                folderZipPromptEnabled={folderZipPromptEnabled}
                surface="files"
              />
            ) : null}
          </div>
        ) : null}

        {entries.length ? (
          <>
            <VaultFileList
              entries={entries}
              sectionKey={section.key}
              csrfToken={csrfToken}
              currentUserId={currentUserId}
              currentFolderId={currentFolderId}
              initialSort={fileSort}
              initialDirection={fileSortDirection}
            />
            {hasMore && nextCursor ? (
              <div className="flex shrink-0 justify-end border-t px-4 py-3">
                <Button asChild variant="outline">
                  <Link
                    href={{
                      pathname: `/${section.key}`,
                      query: {
                        ...(section.key === "files" && currentFolderId
                          ? { folder: currentFolderId }
                          : {}),
                        ...getSortQuery(fileSort, fileSortDirection),
                        cursor: nextCursor,
                      },
                    }}
                  >
                    Next page
                    <ChevronRight className="size-4" aria-hidden="true" />
                  </Link>
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <FilesEmptyState
            sectionKey={section.key}
            inFolder={Boolean(currentFolderId)}
          />
        )}
      </section>
    </div>
  );
}

function FolderBreadcrumbs({
  breadcrumbs,
  sort,
  direction,
  basePath,
}: {
  breadcrumbs: FolderBreadcrumb[];
  sort?: FileSort;
  direction?: FileSortDirection;
  basePath: "/files" | "/shared";
}) {
  const isRoot = breadcrumbs.length === 0;

  return (
    <nav
      aria-label="Folder path"
      className="flex min-h-8 min-w-0 items-center gap-1 overflow-x-auto text-sm"
    >
      <Link
        href={{ pathname: basePath, query: getSortQuery(sort, direction) }}
        aria-current={isRoot ? "page" : undefined}
        className={
          isRoot
            ? "shrink-0 font-medium text-foreground"
            : "shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        }
      >
        {basePath === "/shared" ? "Shared" : "Files"}
      </Link>
      {breadcrumbs.map((breadcrumb, index) => {
        const isCurrent = index === breadcrumbs.length - 1;

        return (
          <span key={breadcrumb.id} className="flex min-w-0 items-center gap-1">
            <ChevronRight
              className="size-4 shrink-0 text-muted-foreground/60"
              aria-hidden="true"
            />
            {isCurrent ? (
              <span className="max-w-52 truncate font-medium">
                {breadcrumb.name}
              </span>
            ) : (
              <Link
                href={{
                  pathname: basePath,
                  query: {
                    folder: breadcrumb.id,
                    ...getSortQuery(sort, direction),
                  },
                }}
                className="max-w-52 truncate text-muted-foreground transition-colors hover:text-foreground"
              >
                {breadcrumb.name}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function StorageContent({ filesState }: { filesState: FilesState }) {
  if (!hasReadyFilesState(filesState)) {
    return (
      <div className="flex flex-1 flex-col gap-6 px-4 py-5 sm:px-6">
        <section className="rounded-md border p-5">
          <p className="font-medium">Storage unavailable</p>
          <p className="mt-2 text-sm text-muted-foreground">
            The storage API is not reachable.
          </p>
        </section>
      </div>
    );
  }

  const storage = filesState.data.storage;
  const usedPercent = percentage(storage.systemUsedBytes, storage.totalBytes);

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-5 sm:px-6">
      <div className="grid gap-3 sm:grid-cols-4">
        <Metric label="Used" value={formatBytes(storage.systemUsedBytes)} />
        <Metric label="Available" value={formatBytes(storage.availableBytes)} />
        <Metric label="Quota" value={formatBytes(storage.totalBytes)} />
        <Metric label="Utilization" value={`${usedPercent}%`} />
      </div>

      <section className="rounded-md border p-5">
        <div className="flex items-center justify-between gap-4 text-sm">
          <span className="font-medium">Storage quota</span>
          <span className="text-muted-foreground">{usedPercent}% used</span>
        </div>
        <div className="mt-4 h-3 rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${usedPercent}%` }}
          />
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          {storage.storagePath}
        </p>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 font-display text-2xl font-semibold">{value}</p>
    </div>
  );
}

function FileMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="grid h-24 grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-3 rounded-md border px-4">
      <span className="flex size-10 items-center justify-center text-primary">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-col justify-center">
        <p className="truncate text-sm leading-5 text-muted-foreground">
          {label}
        </p>
        <p className="mt-0.5 truncate font-display text-2xl font-semibold leading-7 tabular-nums">
          {value}
        </p>
      </div>
    </div>
  );
}

function FilesEmptyState({
  sectionKey,
  inFolder = false,
}: {
  sectionKey: DashboardSectionKey;
  inFolder?: boolean;
}) {
  const isFilesView = sectionKey === "files";

  return (
    <div className="flex min-h-72 flex-1 flex-col items-center justify-center px-4 py-12 text-center">
      <FileEmptyIllustration className="size-32" />
      <p className="mt-2 font-display text-lg font-semibold">
        {isFilesView
          ? inFolder
            ? "This folder is empty"
            : "No files or folders yet"
          : emptyFilesText(sectionKey)}
      </p>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        {isFilesView
          ? "Upload files or choose a folder to preserve its structure."
          : "Items for this view will appear here."}
      </p>
    </div>
  );
}

function getInitials(username: string) {
  const initials = username
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return initials || "A";
}

function getSortQuery(sort?: FileSort, direction?: FileSortDirection) {
  if (!sort) {
    return {};
  }

  return {
    sort,
    direction: direction ?? (sort === "name" ? "asc" : "desc"),
  };
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let unitIndex = 0;
  let size = value;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${
    units[unitIndex]
  }`;
}

function percentage(used: number, total: number) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

function emptyFilesText(sectionKey: DashboardSectionKey) {
  if (sectionKey === "trash") {
    return "Trash is empty.";
  }

  if (sectionKey === "favorites") {
    return "No favorite files.";
  }

  if (sectionKey === "recent") {
    return "No recent files.";
  }

  if (sectionKey === "shared") {
    return "No shared files.";
  }

  return "No files uploaded.";
}

function hasReadyFilesState(
  filesState: FilesState,
): filesState is ReadyFilesState {
  if (filesState.status !== "ready") {
    return false;
  }

  const { entries, summary, storage } = filesState.data;

  return (
    Array.isArray(entries) &&
    entries.every((entry) => typeof entry.shared === "boolean") &&
    summary !== undefined &&
    typeof summary.totalFiles === "number" &&
    typeof summary.totalFolders === "number" &&
    typeof summary.activeFiles === "number" &&
    typeof summary.trashedFiles === "number" &&
    typeof summary.favoriteFiles === "number" &&
    typeof summary.sharedFiles === "number" &&
    typeof summary.usedBytes === "number" &&
    storage !== undefined &&
    typeof storage.totalBytes === "number" &&
    typeof storage.systemUsedBytes === "number"
  );
}
