import {
  Download,
  FileArchive,
  FileText,
  ImageIcon,
  RotateCcw,
  Search,
  Share2,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  getDashboardSection,
  primaryDashboardSections,
  systemDashboardSections,
  type DashboardSection,
  type DashboardSectionKey,
} from "@/features/dashboard/config";
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
  fileMessage?: string;
  userMessage?: string;
  inviteMessage?: string;
};

type ReadyFilesState = Extract<FilesState, { status: "ready" }>;

export function DashboardShell({
  sectionKey,
  currentUser,
  csrfToken,
  adminUsersState,
  filesState,
  fileMessage,
  userMessage,
  inviteMessage,
}: DashboardShellProps) {
  const section = getDashboardSection(sectionKey) ?? getDashboardSection("files");

  if (!section) {
    return null;
  }

  return (
    <main className="flex min-h-dvh bg-background text-foreground">
      <Sidebar
        activeSectionKey={section.key}
        currentUser={currentUser}
        filesState={filesState}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <TopBar section={section} />
        <DashboardContent
          section={section}
          currentUser={currentUser}
          csrfToken={csrfToken}
          adminUsersState={adminUsersState}
          filesState={filesState}
          fileMessage={fileMessage}
          userMessage={userMessage}
          inviteMessage={inviteMessage}
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
    <aside className="hidden w-64 shrink-0 flex-col border-r bg-muted/30 px-4 py-5 lg:flex">
      <div className="flex items-center justify-between gap-3 px-2">
        <Link href="/files" className="flex min-w-0 items-center gap-3">
          <Image
            src="/Aeralyth_transparent.png"
            alt="Aeralyth logo"
            width={40}
            height={40}
            priority
            className="size-10 shrink-0 object-contain"
          />
          <p className="truncate font-display text-lg font-semibold leading-6">
            Aeralyth
          </p>
        </Link>
        <Link
          href="/settings"
          className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-background text-sm font-semibold text-primary"
          title={currentUser.username}
          aria-label={`Open settings for ${currentUser.username}`}
        >
          {getInitials(currentUser.username)}
        </Link>
      </div>

      <div className="mt-8 space-y-7">
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

function TopBar({ section }: { section: DashboardSection }) {
  return (
    <header className="grid min-h-16 gap-3 border-b px-4 py-3 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,34rem)_minmax(0,1fr)] lg:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <Image
          src="/Aeralyth_transparent.png"
          alt="Aeralyth logo"
          width={36}
          height={36}
          priority
          className="size-9 shrink-0 object-contain lg:hidden"
        />
        <div className="min-w-0">
          <p className="font-display text-xl font-semibold leading-6">
            {section.title}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {section.subtitle}
          </p>
        </div>
      </div>

      <div className="min-w-0 lg:justify-self-center">
        {section.searchPlaceholder ? (
          <SearchInput placeholder={section.searchPlaceholder} />
        ) : null}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
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
      </div>
    </header>
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
  fileMessage,
  userMessage,
  inviteMessage,
}: {
  section: DashboardSection;
  currentUser: CurrentUser;
  csrfToken: string;
  adminUsersState?: AdminUsersState;
  filesState: FilesState;
  fileMessage?: string;
  userMessage?: string;
  inviteMessage?: string;
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
        userMessage={userMessage}
        inviteMessage={inviteMessage}
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
      fileMessage={fileMessage}
    />
  );
}

function UsersContent({
  currentUser,
  csrfToken,
  adminUsersState,
  userMessage,
  inviteMessage,
}: {
  currentUser: CurrentUser;
  csrfToken: string;
  adminUsersState?: AdminUsersState;
  userMessage?: string;
  inviteMessage?: string;
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
  const message = getUsersMessage(userMessage, inviteMessage);

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-5 sm:px-6">
      <div className="grid gap-3 sm:grid-cols-4">
        <Metric label="Users" value={String(summary.totalUsers)} />
        <Metric label="Active" value={String(summary.activeUsers)} />
        <Metric label="Admins" value={String(summary.admins)} />
        <Metric label="Invites" value={String(summary.pendingInvites)} />
      </div>

      {message ? (
        <section
          className={
            message.tone === "success"
              ? "rounded-md border border-primary/30 bg-primary/10 px-4 py-3 text-sm"
              : "rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          }
        >
          {message.text}
        </section>
      ) : null}

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
    <div className="flex flex-1 flex-col gap-6 px-4 py-5 sm:px-6">
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="rounded-md border p-5">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-md border bg-background text-sm font-semibold text-primary">
              {getInitials(currentUser.username)}
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium">{currentUser.username}</p>
              <p className="text-sm capitalize text-muted-foreground">
                {currentUser.role}
              </p>
            </div>
          </div>

          <form action="/api/auth/logout" method="post" className="mt-5">
            <input type="hidden" name="csrf_token" value={csrfToken} />
            <Button type="submit" variant="outline" className="rounded-full">
              Sign out
            </Button>
          </form>
        </div>

        <div className="rounded-md border p-5">
          <p className="font-medium">Appearance</p>
          <div className="mt-4 flex items-center justify-between gap-4">
            <span className="text-sm text-muted-foreground">Dark mode</span>
            <ThemeToggle className="shrink-0" />
          </div>
        </div>
      </section>
    </div>
  );
}

function FileContent({
  section,
  filesState,
  csrfToken,
  fileMessage,
}: {
  section: DashboardSection;
  filesState: FilesState;
  csrfToken: string;
  fileMessage?: string;
}) {
  if (!hasReadyFilesState(filesState)) {
    return (
      <div className="flex flex-1 flex-col gap-6 px-4 py-5 sm:px-6">
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
  const message = getFileMessage(fileMessage);
  const isTrash = section.key === "trash";
  const isShared = section.key === "shared";

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-5 sm:px-6">
      <div className="grid gap-3 sm:grid-cols-4">
        <Metric label={section.title} value={String(entries.length)} />
        <Metric label="Active" value={String(summary.activeFiles)} />
        <Metric label="Trash" value={String(summary.trashedFiles)} />
        <Metric label="Used" value={formatBytes(summary.usedBytes)} />
      </div>

      {message ? (
        <section
          className={
            message.tone === "success"
              ? "rounded-md border border-primary/30 bg-primary/10 px-4 py-3 text-sm"
              : "rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          }
        >
          {message.text}
        </section>
      ) : null}

      {section.key === "files" ? <UploadPanel csrfToken={csrfToken} /> : null}

      <section className="min-w-0 overflow-hidden rounded-md border">
        <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3 border-b bg-muted/40 px-4 py-3 text-xs font-medium uppercase text-muted-foreground md:grid-cols-[minmax(0,1fr)_7rem_7rem_9rem_minmax(18rem,26rem)]">
          <span>Name</span>
          <span>Kind</span>
          <span className="hidden md:block">Size</span>
          <span className="hidden md:block">
            {isTrash ? "Deleted" : isShared ? "Shared" : "Updated"}
          </span>
          <span className="hidden md:block">Actions</span>
        </div>

        <div className="divide-y">
          {entries.length ? (
            entries.map((file) => (
              <FileRow
                key={file.id}
                file={file}
                sectionKey={section.key}
                csrfToken={csrfToken}
              />
            ))
          ) : (
            <p className="px-4 py-4 text-sm text-muted-foreground">
              {emptyFilesText(section.key)}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function UploadPanel({ csrfToken }: { csrfToken: string }) {
  const action = `/api/files/upload?csrf_token=${encodeURIComponent(csrfToken)}`;

  return (
    <section className="rounded-md border p-5">
      <p className="font-medium">Upload</p>
      <form
        action={action}
        method="post"
        encType="multipart/form-data"
        className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]"
      >
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <input
          name="file"
          type="file"
          required
          multiple
          className="h-10 min-w-0 rounded-full border bg-background px-3 py-2 text-sm file:mr-3 file:rounded-full file:border-0 file:bg-primary file:px-3 file:py-1 file:text-sm file:font-medium file:text-primary-foreground"
        />
        <Button type="submit" className="h-10 rounded-full">
          <Upload className="size-4" aria-hidden="true" />
          Upload
        </Button>
      </form>
    </section>
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
    <div className="grid gap-3 px-4 py-3 text-sm md:grid-cols-[minmax(0,1fr)_7rem_7rem_9rem_minmax(18rem,26rem)] md:items-center">
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
      <div className="flex flex-wrap gap-2">
        {isTrash ? (
          <>
            <form action={`/api/files/${file.id}/restore`} method="post">
              <input type="hidden" name="csrf_token" value={csrfToken} />
              <Button
                type="submit"
                size="xs"
                variant="outline"
                className="rounded-full"
              >
                <RotateCcw className="size-3" aria-hidden="true" />
                Restore
              </Button>
            </form>
            <form action={`/api/files/${file.id}/delete`} method="post">
              <input type="hidden" name="csrf_token" value={csrfToken} />
              <Button
                type="submit"
                size="xs"
                variant="destructive"
                className="rounded-full"
              >
                <Trash2 className="size-3" aria-hidden="true" />
                Delete
              </Button>
            </form>
          </>
        ) : isShared ? (
          <>
            <Button
              asChild
              size="xs"
              variant="outline"
              className="rounded-full"
            >
              <Link href={`/api/files/${file.id}/download`}>
                <Download className="size-3" aria-hidden="true" />
                Download
              </Link>
            </Button>
            <form action={`/api/files/${file.id}/unshare`} method="post">
              <input type="hidden" name="csrf_token" value={csrfToken} />
              <Button
                type="submit"
                size="xs"
                variant="outline"
                className="rounded-full"
              >
                <X className="size-3" aria-hidden="true" />
                Remove
              </Button>
            </form>
          </>
        ) : (
          <>
            <Button
              asChild
              size="xs"
              variant="outline"
              className="rounded-full"
            >
              <Link href={`/api/files/${file.id}/download`}>
                <Download className="size-3" aria-hidden="true" />
                Download
              </Link>
            </Button>
            <form action={`/api/files/${file.id}/favorite`} method="post">
              <input type="hidden" name="csrf_token" value={csrfToken} />
              <Button
                type="submit"
                size="xs"
                variant="outline"
                className="rounded-full"
              >
                <Star
                  className={file.favorite ? "size-3 fill-primary" : "size-3"}
                  aria-hidden="true"
                />
                Star
              </Button>
            </form>
            <form action={`/api/files/${file.id}/trash`} method="post">
              <input type="hidden" name="csrf_token" value={csrfToken} />
              <Button
                type="submit"
                size="xs"
                variant="outline"
                className="rounded-full"
              >
                <Trash2 className="size-3" aria-hidden="true" />
                Trash
              </Button>
            </form>
            <form
              action={`/api/files/${file.id}/share`}
              method="post"
              className="flex min-w-0 gap-2"
            >
              <input type="hidden" name="csrf_token" value={csrfToken} />
              <input
                name="username"
                type="text"
                required
                minLength={3}
                maxLength={32}
                pattern="[A-Za-z0-9_.-]{3,32}"
                placeholder="username"
                className="h-7 w-28 rounded-full border bg-background px-2 text-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
              />
              <Button
                type="submit"
                size="xs"
                variant="outline"
                className="rounded-full"
              >
                <Share2 className="size-3" aria-hidden="true" />
                Share
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

function getFileMessage(fileMessage?: string) {
  if (fileMessage === "uploaded") {
    return { tone: "success" as const, text: "Upload complete." };
  }

  if (fileMessage === "trashed") {
    return { tone: "success" as const, text: "File moved to trash." };
  }

  if (fileMessage === "restored") {
    return { tone: "success" as const, text: "File restored." };
  }

  if (fileMessage === "deleted") {
    return { tone: "success" as const, text: "File deleted." };
  }

  if (fileMessage === "updated") {
    return { tone: "success" as const, text: "File updated." };
  }

  if (fileMessage === "shared") {
    return { tone: "success" as const, text: "File shared." };
  }

  if (fileMessage === "unshared") {
    return { tone: "success" as const, text: "Share removed." };
  }

  if (fileMessage === "too-large") {
    return { tone: "error" as const, text: "Upload is too large." };
  }

  if (fileMessage === "missing") {
    return { tone: "error" as const, text: "Choose a file first." };
  }

  if (fileMessage === "share-invalid") {
    return { tone: "error" as const, text: "Use a valid username." };
  }

  if (fileMessage === "share-user-missing") {
    return { tone: "error" as const, text: "That active user does not exist." };
  }

  if (fileMessage === "share-self") {
    return {
      tone: "error" as const,
      text: "You cannot share a file with yourself.",
    };
  }

  return null;
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

function getUsersMessage(userMessage?: string, inviteMessage?: string) {
  if (inviteMessage === "created") {
    return { tone: "success" as const, text: "Invitation created." };
  }

  if (inviteMessage === "invalid-username") {
    return {
      tone: "error" as const,
      text: "Use 3 to 32 letters, numbers, dots, underscores, or hyphens.",
    };
  }

  if (inviteMessage === "invalid-role") {
    return { tone: "error" as const, text: "Choose a valid role." };
  }

  if (inviteMessage === "user-exists") {
    return { tone: "error" as const, text: "That user already exists." };
  }

  if (inviteMessage === "invite-exists") {
    return { tone: "error" as const, text: "That invite is already pending." };
  }

  if (userMessage === "updated") {
    return { tone: "success" as const, text: "User updated." };
  }

  if (userMessage === "created") {
    return { tone: "success" as const, text: "User created." };
  }

  if (userMessage === "self-protected") {
    return {
      tone: "error" as const,
      text: "You cannot remove your own admin access.",
    };
  }

  if (userMessage === "last-admin") {
    return {
      tone: "error" as const,
      text: "At least one active admin is required.",
    };
  }

  if (userMessage === "missing") {
    return { tone: "error" as const, text: "User not found." };
  }

  if (userMessage === "invalid-username") {
    return {
      tone: "error" as const,
      text: "Use 3 to 32 letters, numbers, dots, underscores, or hyphens.",
    };
  }

  if (userMessage === "invalid-role") {
    return { tone: "error" as const, text: "Choose a valid role." };
  }

  if (userMessage === "invalid-status") {
    return { tone: "error" as const, text: "Choose a valid status." };
  }

  if (userMessage === "weak-password") {
    return { tone: "error" as const, text: "Password must be at least 8 characters." };
  }

  if (userMessage === "user-exists") {
    return { tone: "error" as const, text: "That user already exists." };
  }

  return null;
}
