import {
  Activity,
  ArrowDown,
  ChevronsUpDown,
  Download,
  FileArchive,
  FileText,
  Folder,
  HardDrive,
  ImageIcon,
  ListFilter,
  LogOut,
  RotateCcw,
  Search,
  Star,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { AeralythLogo } from "@/components/aeralyth-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { AccentColorPreference } from "@/features/dashboard/accent-color-preference";
import {
  getDashboardSection,
  primaryDashboardSections,
  systemDashboardSections,
  type DashboardSection,
  type DashboardSectionKey,
} from "@/features/dashboard/config";
import { UploadPanel } from "@/features/dashboard/upload-panel";
import type {
  AdminUsersState,
  FileEntry,
  FilesState,
  StorageStats,
} from "@/lib/api";

type CurrentUser = {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "active" | "disabled";
};

type DashboardShellProps = {
  sectionKey: DashboardSectionKey;
  currentUser: CurrentUser;
  csrfToken: string;
  adminUsersState?: AdminUsersState;
  filesState: FilesState;
};

type ReadyFilesState = Extract<FilesState, { status: "ready" }>;

export function DashboardShell({
  sectionKey,
  currentUser,
  csrfToken,
  adminUsersState,
  filesState,
}: DashboardShellProps) {
  const section = getDashboardSection(sectionKey) ?? getDashboardSection("files");

  if (!section) {
    return null;
  }

  return (
    <main className="flex min-h-dvh bg-sidebar text-foreground">
      <Sidebar
        activeSectionKey={section.key}
        currentUser={currentUser}
        filesState={filesState}
      />

      <section className="dashboard-main-panel flex min-w-0 flex-1 flex-col bg-background lg:mt-4 lg:min-h-[calc(100dvh-1rem)] lg:overflow-hidden lg:rounded-tl-3xl">
        <TopBar section={section} currentUser={currentUser} />
        <DashboardContent
          section={section}
          currentUser={currentUser}
          csrfToken={csrfToken}
          adminUsersState={adminUsersState}
          filesState={filesState}
        />
      </section>
    </main>
  );
}

function Sidebar({
  activeSectionKey,
  currentUser,
  filesState,
}: {
  activeSectionKey: DashboardSectionKey;
  currentUser: CurrentUser;
  filesState: FilesState;
}) {
  const canViewSystemNavigation = currentUser.role === "admin";
  const storage = hasReadyFilesState(filesState)
    ? filesState.data.storage
    : undefined;
  const storagePercent = storage
    ? percentage(storage.systemUsedBytes, storage.totalBytes)
    : 0;

  return (
    <aside className="dashboard-sidebar hidden w-64 shrink-0 flex-col px-4 pb-5 pt-5 lg:flex lg:pt-9">
      <div className="px-2">
        <Link href="/files" className="flex min-w-0 items-center gap-3">
          <AeralythLogo className="size-10" />
          <p className="truncate font-display text-4xl font-semibold leading-10">
            Aeralyth
          </p>
        </Link>
        <div role="separator" aria-hidden="true" className="mt-5 h-px bg-border" />
      </div>

      <div className="mt-6 space-y-7">
        <nav className="space-y-1" aria-label="Main navigation">
          {primaryDashboardSections.map((item) => (
            <SidebarLink
              key={item.key}
              section={item}
              active={item.key === activeSectionKey}
            />
          ))}
        </nav>

        {canViewSystemNavigation ? (
          <section>
            <p className="px-3 text-xs font-medium uppercase text-muted-foreground">
              System
            </p>
            <nav className="mt-2 space-y-1" aria-label="System navigation">
              {systemDashboardSections.map((item) => (
                <SidebarLink
                  key={item.key}
                  section={item}
                  active={item.key === activeSectionKey}
                />
              ))}
            </nav>
          </section>
        ) : null}
      </div>

      <div className="mt-auto px-2 pt-6">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">Storage</span>
          <span className="text-muted-foreground">
            {storage ? `${storagePercent}%` : "Unavailable"}
          </span>
        </div>
        <div className="mt-3 h-2 rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${storagePercent}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {storage
            ? `${formatBytes(storage.systemUsedBytes)} of ${formatBytes(
                storage.totalBytes,
              )} used`
            : "Storage stats unavailable"}
        </p>
      </div>
    </aside>
  );
}

function SidebarLink({
  section,
  active,
}: {
  section: DashboardSection;
  active: boolean;
}) {
  return (
    <Link
      href={section.href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "flex h-9 w-full items-center gap-2 rounded-full bg-background px-3 text-left text-sm font-medium shadow-xs"
          : "flex h-9 w-full items-center gap-2 rounded-full px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
      }
    >
      <section.icon className="size-4" aria-hidden="true" />
      {section.label}
    </Link>
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
  return (
    <Link
      href="/settings"
      className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-background text-sm font-semibold text-primary transition-colors hover:bg-muted"
      title={currentUser.username}
      aria-label={`Open settings for ${currentUser.username}`}
    >
      {getInitials(currentUser.username)}
    </Link>
  );
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
        className="h-10 w-full rounded-full border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
      />
    </div>
  );
}

function DashboardContent({
  section,
  currentUser,
  csrfToken,
  adminUsersState,
  filesState,
}: {
  section: DashboardSection;
  currentUser: CurrentUser;
  csrfToken: string;
  adminUsersState?: AdminUsersState;
  filesState: FilesState;
}) {
  if (section.key === "settings") {
    return <SettingsContent currentUser={currentUser} csrfToken={csrfToken} />;
  }

  if (section.key === "users") {
    return (
      <UsersContent
        currentUser={currentUser}
        csrfToken={csrfToken}
        adminUsersState={adminUsersState}
      />
    );
  }

  if (section.key === "storage") {
    return <StorageContent filesState={filesState} />;
  }

  return (
    <FileContent
      section={section}
      filesState={filesState}
      csrfToken={csrfToken}
    />
  );
}

function UsersContent({
  currentUser,
  csrfToken,
  adminUsersState,
}: {
  currentUser: CurrentUser;
  csrfToken: string;
  adminUsersState?: AdminUsersState;
}) {
  if (!adminUsersState || adminUsersState.status === "unavailable") {
    return (
      <div className="flex flex-1 flex-col gap-6 px-4 py-5 sm:px-6">
        <section className="rounded-md border p-5">
          <p className="font-medium">Users unavailable</p>
          <p className="mt-2 text-sm text-muted-foreground">
            The admin users API is not reachable.
          </p>
        </section>
      </div>
    );
  }

  if (adminUsersState.status !== "ready") {
    return null;
  }

  const { users, invitations, summary } = adminUsersState.data;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 px-4 py-5 sm:px-6">
      <div className="grid gap-3 sm:grid-cols-4">
        <Metric label="Users" value={String(summary.totalUsers)} />
        <Metric label="Active" value={String(summary.activeUsers)} />
        <Metric label="Admins" value={String(summary.admins)} />
        <Metric label="Invites" value={String(summary.pendingInvites)} />
      </div>

      <section className="rounded-md border p-5">
        <p className="font-medium">Create user</p>
        <form
          action="/api/admin/users"
          method="post"
          className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(12rem,16rem)_10rem_auto]"
        >
          <input type="hidden" name="csrf_token" value={csrfToken} />
          <input
            name="username"
            type="text"
            autoComplete="off"
            required
            minLength={3}
            maxLength={32}
            pattern="[A-Za-z0-9_.-]{3,32}"
            placeholder="username"
            className="h-10 min-w-0 rounded-full border bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          />
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            placeholder="password"
            className="h-10 min-w-0 rounded-full border bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          />
          <select
            name="role"
            defaultValue="user"
            className="h-10 rounded-full border bg-background px-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
          <Button type="submit" className="h-10 rounded-full">
            Create
          </Button>
        </form>
      </section>

      <section className="min-w-0 overflow-hidden rounded-md border">
        <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3 border-b bg-muted/40 px-4 py-3 text-xs font-medium uppercase text-muted-foreground md:grid-cols-[minmax(0,1fr)_7rem_7rem_10rem_16rem]">
          <span>User</span>
          <span>Role</span>
          <span className="hidden md:block">Status</span>
          <span className="hidden md:block">Created</span>
          <span className="hidden md:block">Actions</span>
        </div>

        <div className="divide-y">
          {users.map((user) => {
            const isCurrentUser = user.id === currentUser.id;

            return (
              <div
                key={user.id}
                className="grid gap-3 px-4 py-3 text-sm md:grid-cols-[minmax(0,1fr)_7rem_7rem_10rem_16rem] md:items-center"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{user.username}</p>
                  <p className="text-xs text-muted-foreground md:hidden">
                    {user.role} · {user.status}
                  </p>
                </div>
                <span className="capitalize text-muted-foreground">
                  {user.role}
                </span>
                <span className="hidden capitalize text-muted-foreground md:block">
                  {user.status}
                </span>
                <span className="hidden text-muted-foreground md:block">
                  {formatDate(user.createdAt)}
                </span>
                <div className="grid gap-2 sm:grid-cols-2 md:flex md:items-center">
                  <form
                    action={`/api/admin/users/${user.id}/role`}
                    method="post"
                    className="flex min-w-0 gap-2"
                  >
                    <input type="hidden" name="csrf_token" value={csrfToken} />
                    <select
                      name="role"
                      defaultValue={user.role}
                      disabled={isCurrentUser}
                      className="h-8 min-w-0 flex-1 rounded-full border bg-background px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                    <Button
                      type="submit"
                      size="xs"
                      variant="outline"
                      disabled={isCurrentUser}
                      className="rounded-full"
                    >
                      Role
                    </Button>
                  </form>
                  <form
                    action={`/api/admin/users/${user.id}/status`}
                    method="post"
                    className="flex min-w-0 gap-2"
                  >
                    <input type="hidden" name="csrf_token" value={csrfToken} />
                    <select
                      name="status"
                      defaultValue={user.status}
                      disabled={isCurrentUser}
                      className="h-8 min-w-0 flex-1 rounded-full border bg-background px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                    >
                      <option value="active">Active</option>
                      <option value="disabled">Disabled</option>
                    </select>
                    <Button
                      type="submit"
                      size="xs"
                      variant="outline"
                      disabled={isCurrentUser}
                      className="rounded-full"
                    >
                      Status
                    </Button>
                  </form>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="min-w-0 overflow-hidden rounded-md border">
        <div className="grid grid-cols-[minmax(0,1fr)_7rem_7rem] gap-3 border-b bg-muted/40 px-4 py-3 text-xs font-medium uppercase text-muted-foreground md:grid-cols-[minmax(0,1fr)_7rem_7rem_10rem]">
          <span>Invite</span>
          <span>Role</span>
          <span>Status</span>
          <span className="hidden md:block">Expires</span>
        </div>

        <div className="divide-y">
          {invitations.length ? (
            invitations.map((invitation) => (
              <div
                key={invitation.id}
                className="grid grid-cols-[minmax(0,1fr)_7rem_7rem] gap-3 px-4 py-3 text-sm md:grid-cols-[minmax(0,1fr)_7rem_7rem_10rem]"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {invitation.invitedUsername}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    by {invitation.createdByUsername}
                  </p>
                </div>
                <span className="capitalize text-muted-foreground">
                  {invitation.role}
                </span>
                <span className="capitalize text-muted-foreground">
                  {invitation.status}
                </span>
                <span className="hidden text-muted-foreground md:block">
                  {formatDate(invitation.expiresAt)}
                </span>
              </div>
            ))
          ) : (
            <p className="px-4 py-4 text-sm text-muted-foreground">
              No invitations.
            </p>
          )}
        </div>
      </section>
    </div>
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
    <div className="flex flex-1 flex-col px-4 py-5 sm:px-6">
      <div className="grid w-full max-w-3xl gap-4">
        <SettingsSection title="Account">
          <div className="flex min-w-0 items-center gap-3 px-4 py-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-primary/10 text-sm font-semibold text-primary">
              {getInitials(currentUser.username)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {currentUser.username}
              </p>
              <p className="text-xs text-muted-foreground">Signed in</p>
            </div>
          </div>

          <SettingsRow label="Role">
            <span className="text-sm capitalize text-muted-foreground">
              {currentUser.role}
            </span>
          </SettingsRow>

          <SettingsRow label="Status">
            <StatusPill>{currentUser.status}</StatusPill>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Preferences">
          <SettingsRow
            label="Appearance"
            description="Switch the interface between light and dark mode."
          >
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">Dark mode</span>
              <ThemeToggle className="shrink-0" />
            </div>
          </SettingsRow>

          <SettingsRow
            label="Accent color"
            description="Controls buttons, highlights, focus rings, and selected states."
          >
            <AccentColorPreference />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Session">
          <SettingsRow label="Session">
            <form action="/api/auth/logout" method="post">
              <input type="hidden" name="csrf_token" value={csrfToken} />
              <Button type="submit" variant="destructive" size="sm">
                <LogOut className="size-4" aria-hidden="true" />
                Sign out
              </Button>
            </form>
          </SettingsRow>
        </SettingsSection>
      </div>
    </div>
  );
}

function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="w-full overflow-hidden rounded-md border">
      <div className="border-b px-4 py-3">
        <p className="text-sm font-medium">{title}</p>
      </div>
      <div className="divide-y">{children}</div>
    </section>
  );
}

function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {description ? (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center sm:justify-end">{children}</div>
    </div>
  );
}

function StatusPill({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium capitalize text-primary">
      {children}
    </span>
  );
}

function FileContent({
  section,
  filesState,
  csrfToken,
}: {
  section: DashboardSection;
  filesState: FilesState;
  csrfToken: string;
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

  const { entries, summary } = filesState.data;
  const isTrash = section.key === "trash";
  const isShared = section.key === "shared";
  const folderCount = countFolders(entries);
  const fileCount = entries.length - folderCount;
  const uploadInputId =
    section.key === "files" ? "aeralyth-file-upload-input" : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 px-4 py-5 sm:px-6">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <FileMetric
          icon={FileText}
          label={section.key === "files" ? "Files" : section.title}
          value={String(section.key === "files" ? fileCount : entries.length)}
        />
        <FileMetric icon={Folder} label="Folders" value={String(folderCount)} />
        <FileMetric
          icon={Activity}
          label="Active"
          value={String(summary.activeFiles)}
        />
        <FileMetric
          icon={Trash2}
          label="Trash"
          value={String(summary.trashedFiles)}
        />
        <FileMetric
          icon={HardDrive}
          label="Used"
          value={formatBytes(summary.usedBytes)}
        />
      </div>

      {section.key === "files" ? (
        <UploadPanel csrfToken={csrfToken} inputId={uploadInputId} />
      ) : null}

      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-card/45 shadow-[0_18px_70px_rgb(0_0_0/0.08)]">
        {entries.length ? (
          <>
            <FileTableHeader
              isShared={isShared}
              isTrash={isTrash}
            />
            <div className="min-h-0 flex-1 divide-y overflow-auto">
              {entries.map((file) => (
                <FileRow
                  key={file.id}
                  file={file}
                  sectionKey={section.key}
                  csrfToken={csrfToken}
                />
              ))}
            </div>
          </>
        ) : (
          <FilesEmptyState sectionKey={section.key} />
        )}
      </section>
    </div>
  );
}

function FileTableHeader({
  isTrash,
  isShared,
}: {
  isTrash: boolean;
  isShared: boolean;
}) {
  return (
    <div className="grid min-h-14 grid-cols-[2rem_minmax(0,1fr)_7rem] gap-3 border-b px-4 py-3 text-sm font-medium text-muted-foreground md:grid-cols-[2rem_minmax(12rem,1fr)_7rem_7rem_9rem_minmax(18rem,22rem)] md:items-center">
      <span className="flex items-center justify-center">
        <input
          type="checkbox"
          aria-label="Select all files"
          disabled
          className="size-4 rounded border border-border bg-transparent"
        />
      </span>
      <span className="flex items-center gap-1.5">
        Name
        <ChevronsUpDown className="size-3.5" aria-hidden="true" />
      </span>
      <span>Kind</span>
      <span className="hidden md:block">Size</span>
      <span className="hidden items-center gap-1.5 md:flex">
        {isTrash ? "Deleted" : isShared ? "Shared" : "Updated"}
        <ArrowDown className="size-3.5" aria-hidden="true" />
      </span>
      <span className="hidden items-center justify-end gap-1.5 md:flex">
        Actions
        <ListFilter className="size-3.5" aria-hidden="true" />
      </span>
    </div>
  );
}

function FileRow({
  file,
  sectionKey,
  csrfToken,
}: {
  file: FileEntry;
  sectionKey: DashboardSectionKey;
  csrfToken: string;
}) {
  const FileIcon = getFileIcon(file);
  const isTrash = sectionKey === "trash";
  const isShared = sectionKey === "shared";
  const rowDate =
    isTrash && file.trashedAt
      ? file.trashedAt
      : isShared && file.sharedAt
        ? file.sharedAt
        : file.updatedAt;

  return (
    <div className="grid gap-3 px-4 py-3 text-sm md:min-h-16 md:grid-cols-[2rem_minmax(12rem,1fr)_7rem_7rem_9rem_minmax(18rem,22rem)] md:items-center">
      <span className="hidden items-center justify-center md:flex">
        <input
          type="checkbox"
          aria-label={`Select ${file.name}`}
          disabled
          className="size-4 rounded border border-border bg-transparent"
        />
      </span>
      <div className="flex min-w-0 items-center gap-3">
        <FileIcon className="size-5 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0">
          <p className="truncate font-medium">{file.name}</p>
          <p className="text-xs text-muted-foreground md:hidden">
            {file.kind} · {formatBytes(file.sizeBytes)}
          </p>
          {isShared && file.ownerUsername ? (
            <p className="truncate text-xs text-muted-foreground">
              Shared by {file.ownerUsername}
            </p>
          ) : null}
        </div>
      </div>
      <span className="text-muted-foreground">{file.kind}</span>
      <span className="hidden text-muted-foreground md:block">
        {formatBytes(file.sizeBytes)}
      </span>
      <span className="hidden text-muted-foreground md:block">
        {formatDate(rowDate)}
      </span>
      <div className="flex min-w-0 flex-wrap items-center justify-start gap-2 md:flex-nowrap md:justify-end">
        {isTrash ? (
          <>
            <form action={`/api/files/${file.id}/restore`} method="post">
              <input type="hidden" name="csrf_token" value={csrfToken} />
              <Button
                type="submit"
                variant="outline"
                className="rounded-full"
              >
                <RotateCcw className="size-4" aria-hidden="true" />
                Restore
              </Button>
            </form>
            <form action={`/api/files/${file.id}/delete`} method="post">
              <input type="hidden" name="csrf_token" value={csrfToken} />
              <Button
                type="submit"
                variant="destructive"
                className="rounded-full"
              >
                <Trash2 className="size-4" aria-hidden="true" />
                Delete
              </Button>
            </form>
          </>
        ) : isShared ? (
          <>
            <Button
              asChild
              variant="outline"
              className="rounded-full"
            >
              <Link href={`/api/files/${file.id}/download`}>
                <Download className="size-4" aria-hidden="true" />
                Download
              </Link>
            </Button>
            <form action={`/api/files/${file.id}/unshare`} method="post">
              <input type="hidden" name="csrf_token" value={csrfToken} />
              <Button
                type="submit"
                variant="outline"
                className="rounded-full"
              >
                <X className="size-4" aria-hidden="true" />
                Remove
              </Button>
            </form>
          </>
        ) : (
          <>
            <Button
              asChild
              variant="outline"
              className="rounded-full"
            >
              <Link href={`/api/files/${file.id}/download`}>
                <Download className="size-4" aria-hidden="true" />
                Download
              </Link>
            </Button>
            <form action={`/api/files/${file.id}/favorite`} method="post">
              <input type="hidden" name="csrf_token" value={csrfToken} />
              <Button
                type="submit"
                variant="outline"
                className="rounded-full"
              >
                <Star
                  className={file.favorite ? "size-4 fill-primary" : "size-4"}
                  aria-hidden="true"
                />
                Star
              </Button>
            </form>
            <form action={`/api/files/${file.id}/trash`} method="post">
              <input type="hidden" name="csrf_token" value={csrfToken} />
              <Button
                type="submit"
                variant="outline"
                className="rounded-full"
              >
                <Trash2 className="size-4" aria-hidden="true" />
                Trash
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
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
        <Metric label="System used" value={formatBytes(storage.systemUsedBytes)} />
        <Metric label="Available" value={formatBytes(storage.availableBytes)} />
        <Metric label="Capacity" value={formatBytes(storage.totalBytes)} />
        <Metric
          label="Aeralyth data"
          value={formatBytes(storage.aeralythUsedBytes)}
        />
      </div>

      <section className="rounded-md border p-5">
        <div className="flex items-center justify-between gap-4 text-sm">
          <span className="font-medium">System storage</span>
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
    <div className="flex min-h-24 items-center gap-4 rounded-md border bg-card/45 p-5 shadow-[0_18px_70px_rgb(0_0_0/0.08)]">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-md text-primary">
        <Icon className="size-6" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 font-display text-2xl font-semibold leading-8">
          {value}
        </p>
      </div>
    </div>
  );
}

function FilesEmptyState({ sectionKey }: { sectionKey: DashboardSectionKey }) {
  const isFilesView = sectionKey === "files";

  return (
    <div className="flex min-h-72 flex-1 flex-col items-center justify-center px-4 py-12 text-center">
      <div className="relative flex size-28 items-center justify-center text-primary">
        <Folder
          className="absolute left-1/2 top-6 size-20 -translate-x-1/2 text-muted-foreground/30"
          aria-hidden="true"
        />
        <span className="absolute bottom-4 right-4 flex size-11 items-center justify-center rounded-full border bg-background text-primary shadow-[0_12px_38px_rgb(0_0_0/0.18)]">
          <Search className="size-5" aria-hidden="true" />
        </span>
      </div>
      <p className="mt-2 font-display text-lg font-semibold">
        {isFilesView ? "No files uploaded yet" : emptyFilesText(sectionKey)}
      </p>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        {isFilesView
          ? "Upload your first file or create a new folder to get started."
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

function formatDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  }).format(date);
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

function getFileIcon(file: FileEntry) {
  const kind = file.kind.toLowerCase();

  if (isFolderEntry(file)) {
    return Folder;
  }

  if (kind.includes("image")) {
    return ImageIcon;
  }

  if (
    kind.includes("zip") ||
    kind.includes("archive") ||
    kind.includes("tar") ||
    kind.includes("rar")
  ) {
    return FileArchive;
  }

  return FileText;
}

function countFolders(entries: FileEntry[]) {
  return entries.filter(isFolderEntry).length;
}

function isFolderEntry(entry: FileEntry) {
  const kind = entry.kind.toLowerCase();

  return kind === "folder" || kind === "directory";
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

function hasReadyFilesState(filesState: FilesState): filesState is ReadyFilesState {
  if (filesState.status !== "ready") {
    return false;
  }

  const { entries, summary, storage } = filesState.data;

  return (
    Array.isArray(entries) &&
    entries.every((entry) => typeof entry.shared === "boolean") &&
    summary !== undefined &&
    typeof summary.activeFiles === "number" &&
    typeof summary.trashedFiles === "number" &&
    typeof summary.usedBytes === "number" &&
    storage !== undefined &&
    typeof storage.totalBytes === "number" &&
    typeof storage.systemUsedBytes === "number"
  );
}
