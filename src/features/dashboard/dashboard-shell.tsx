import {
  Archive,
  CheckCircle2,
  FileArchive,
  FileText,
  Folder,
  HardDrive,
  ImageIcon,
  MoreHorizontal,
  Search,
  ShieldCheck,
  UserRound,
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

type CurrentUser = {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "active" | "disabled";
};

const fileRows = [
  {
    name: "Documents",
    type: "folder",
    detail: "18 items",
    modified: "Today, 09:42",
    icon: Folder,
    accent: "text-sky-600 dark:text-sky-400",
  },
  {
    name: "Backups",
    type: "folder",
    detail: "6 items",
    modified: "Yesterday",
    icon: Archive,
    accent: "text-primary",
  },
  {
    name: "Server notes.md",
    type: "Markdown",
    detail: "18 KB",
    modified: "Mon, 16:18",
    icon: FileText,
    accent: "text-zinc-600 dark:text-zinc-300",
  },
  {
    name: "Photo import.zip",
    type: "Archive",
    detail: "1.4 GB",
    modified: "May 20",
    icon: FileArchive,
    accent: "text-amber-600 dark:text-amber-400",
  },
  {
    name: "Wallpaper.png",
    type: "Image",
    detail: "4.8 MB",
    modified: "May 18",
    icon: ImageIcon,
    accent: "text-fuchsia-600 dark:text-fuchsia-400",
  },
];

const sectionRows: Partial<Record<DashboardSectionKey, typeof fileRows>> = {
  recent: [
    fileRows[0],
    fileRows[2],
    fileRows[4],
  ],
  favorites: [
    fileRows[0],
    fileRows[1],
  ],
  shared: [
    {
      ...fileRows[2],
      detail: "Shared link",
      modified: "Expires Jun 12",
    },
    {
      ...fileRows[4],
      detail: "Shared with Mira",
      modified: "Viewed today",
    },
  ],
  trash: [
    {
      ...fileRows[3],
      name: "Old backup.zip",
      detail: "Deletes in 24 days",
      modified: "Deleted May 24",
    },
    {
      ...fileRows[2],
      name: "Draft notes.md",
      detail: "Deletes in 28 days",
      modified: "Deleted May 20",
    },
  ],
};

const systemCards: Partial<Record<DashboardSectionKey, string[]>> = {
  storage: ["420 GB used", "1 TB capacity", "580 GB available"],
  transfers: ["2 active uploads", "4 completed today", "1 failed retry"],
  users: ["8 active users", "2 admins", "1 pending invite"],
  security: ["3 active sessions", "2FA ready", "No alerts"],
  settings: ["General", "Appearance", "Server"],
};

type DashboardShellProps = {
  sectionKey: DashboardSectionKey;
  currentUser: CurrentUser;
};

export function DashboardShell({
  sectionKey,
  currentUser,
}: DashboardShellProps) {
  const section = getDashboardSection(sectionKey) ?? getDashboardSection("files");

  if (!section) {
    return null;
  }

  return (
    <main className="flex min-h-dvh bg-background text-foreground">
      <Sidebar activeSectionKey={section.key} currentUser={currentUser} />

      <section className="flex min-w-0 flex-1 flex-col">
        <TopBar section={section} />
        <DashboardContent section={section} currentUser={currentUser} />
      </section>
    </main>
  );
}

function Sidebar({
  activeSectionKey,
  currentUser,
}: {
  activeSectionKey: DashboardSectionKey;
  currentUser: CurrentUser;
}) {
  const canViewSystemNavigation = currentUser.role === "admin";

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
          className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background text-sm font-semibold text-primary"
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
          <span className="text-muted-foreground">42%</span>
        </div>
        <div className="mt-3 h-2 rounded-full bg-muted">
          <div className="h-full w-[42%] rounded-full bg-primary" />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          420 GB of 1 TB used
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
          ? "flex h-9 w-full items-center gap-2 rounded-md bg-background px-3 text-left text-sm font-medium shadow-xs"
          : "flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
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
            className="rounded-md"
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
        className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
      />
    </div>
  );
}

function DashboardContent({
  section,
  currentUser,
}: {
  section: DashboardSection;
  currentUser: CurrentUser;
}) {
  if (section.key === "settings") {
    return <SettingsContent currentUser={currentUser} />;
  }

  if (section.content === "system") {
    return <SystemContent section={section} />;
  }

  return <FileContent section={section} />;
}

function SettingsContent({ currentUser }: { currentUser: CurrentUser }) {
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
            <Button type="submit" variant="outline" className="rounded-md">
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

function FileContent({ section }: { section: DashboardSection }) {
  const rows = sectionRows[section.key] ?? fileRows;
  const folderCount = rows.filter((row) => row.type === "folder").length;

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-5 sm:px-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label={section.title} value={String(rows.length)} />
        <Metric label="Folders" value={String(folderCount)} />
        <Metric label="Storage used" value="420 GB" />
      </div>

      <section className="min-w-0 overflow-hidden rounded-md border">
        <div className="grid grid-cols-[minmax(0,1fr)_2.5rem] gap-3 border-b bg-muted/40 px-4 py-3 text-xs font-medium uppercase text-muted-foreground sm:grid-cols-[minmax(0,1fr)_7rem_2.5rem] md:grid-cols-[minmax(0,1fr)_7rem_8rem_2.5rem]">
          <span>Name</span>
          <span className="hidden sm:block">Type</span>
          <span className="hidden md:block">
            {section.key === "trash" ? "Deleted" : "Modified"}
          </span>
          <span className="sr-only">Actions</span>
        </div>

        <div className="divide-y">
          {rows.map((file) => (
            <div
              key={`${section.key}-${file.name}`}
              className="grid min-h-14 grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-3 px-4 py-2 text-sm transition-colors hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_7rem_2.5rem] md:grid-cols-[minmax(0,1fr)_7rem_8rem_2.5rem]"
            >
              <div className="flex min-w-0 items-center gap-3">
                <file.icon
                  className={`size-5 shrink-0 ${file.accent}`}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="truncate font-medium">{file.name}</p>
                  <p className="text-xs text-muted-foreground sm:hidden">
                    {file.type} · {file.detail}
                  </p>
                </div>
              </div>
              <span className="hidden text-muted-foreground sm:block">
                {file.type}
              </span>
              <span className="hidden text-muted-foreground md:block">
                {file.modified}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="rounded-md"
                aria-label={`More actions for ${file.name}`}
              >
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SystemContent({ section }: { section: DashboardSection }) {
  const cards = systemCards[section.key] ?? [];

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-5 sm:px-6">
      <div className="grid gap-3 sm:grid-cols-3">
        {cards.map((card) => (
          <Metric key={card} label={section.title} value={card} />
        ))}
      </div>

      <section className="rounded-md border p-5">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md border bg-background">
            {section.key === "users" ? (
              <UserRound className="size-4 text-primary" aria-hidden="true" />
            ) : section.key === "security" ? (
              <ShieldCheck
                className="size-4 text-primary"
                aria-hidden="true"
              />
            ) : section.key === "storage" ? (
              <HardDrive className="size-4 text-primary" aria-hidden="true" />
            ) : (
              <CheckCircle2
                className="size-4 text-primary"
                aria-hidden="true"
              />
            )}
          </span>
          <div>
            <p className="font-medium">{section.title} overview</p>
            <p className="text-sm text-muted-foreground">
              This area will connect to backend data when the {section.label}
              module is implemented.
            </p>
          </div>
        </div>
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
