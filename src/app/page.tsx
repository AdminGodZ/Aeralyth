import {
  Archive,
  FileArchive,
  FileText,
  Folder,
  HardDrive,
  ImageIcon,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Upload,
} from "lucide-react";
import Image from "next/image";

import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

const files = [
  {
    name: "Documents",
    type: "folder",
    size: "18 items",
    modified: "Today, 09:42",
    icon: Folder,
    accent: "text-sky-600 dark:text-sky-400",
  },
  {
    name: "Backups",
    type: "folder",
    size: "6 items",
    modified: "Yesterday",
    icon: Archive,
    accent: "text-primary",
  },
  {
    name: "Server notes.md",
    type: "Markdown",
    size: "18 KB",
    modified: "Mon, 16:18",
    icon: FileText,
    accent: "text-zinc-600 dark:text-zinc-300",
  },
  {
    name: "Photo import.zip",
    type: "Archive",
    size: "1.4 GB",
    modified: "May 20",
    icon: FileArchive,
    accent: "text-amber-600 dark:text-amber-400",
  },
  {
    name: "Wallpaper.png",
    type: "Image",
    size: "4.8 MB",
    modified: "May 18",
    icon: ImageIcon,
    accent: "text-fuchsia-600 dark:text-fuchsia-400",
  },
];

const navigationItems = [
  { label: "Files", icon: Folder, active: true },
  { label: "Storage", icon: HardDrive, active: false },
  { label: "Security", icon: ShieldCheck, active: false },
  { label: "Settings", icon: Settings, active: false },
];

export default function Home() {
  return (
    <main className="flex min-h-dvh bg-background text-foreground">
      <aside className="hidden w-64 shrink-0 border-r bg-muted/30 px-4 py-5 lg:block">
        <div className="flex items-center gap-3 px-2">
          <Image
            src="/Aeralyth_transparent.png"
            alt="Aeralyth logo"
            width={40}
            height={40}
            priority
            className="size-10 object-contain"
          />
          <div>
            <p className="font-display text-lg font-semibold leading-6">
              Aeralyth
            </p>
            <p className="text-xs text-muted-foreground">Local cloud</p>
          </div>
        </div>

        <nav className="mt-8 space-y-1">
          {navigationItems.map((item) => (
            <button
              key={item.label}
              type="button"
              aria-pressed={item.active}
              className={
                item.active
                  ? "flex h-9 w-full items-center gap-2 rounded-md bg-background px-3 text-left text-sm font-medium shadow-xs"
                  : "flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
              }
            >
              <item.icon className="size-4" aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="mt-8 rounded-md border bg-background p-3">
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

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-16 items-center justify-between border-b px-4 sm:px-6">
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
                Files
              </p>
              <p className="text-sm text-muted-foreground">
                Personal workspace
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button variant="outline" className="rounded-md">
              <Plus className="size-4" aria-hidden="true" />
              New folder
            </Button>
            <Button className="rounded-md">
              <Upload className="size-4" aria-hidden="true" />
              Upload
            </Button>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-6 px-4 py-5 sm:px-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="relative max-w-xl flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                type="search"
                aria-label="Search files"
                placeholder="Search files"
                className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
              />
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="size-4 text-primary" />
              Session protected
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border p-4">
              <p className="text-sm text-muted-foreground">Files</p>
              <p className="mt-2 font-display text-2xl font-semibold">128</p>
            </div>
            <div className="rounded-md border p-4">
              <p className="text-sm text-muted-foreground">Folders</p>
              <p className="mt-2 font-display text-2xl font-semibold">24</p>
            </div>
            <div className="rounded-md border p-4">
              <p className="text-sm text-muted-foreground">Storage used</p>
              <p className="mt-2 font-display text-2xl font-semibold">
                420 GB
              </p>
            </div>
          </div>

          <section className="min-w-0 overflow-hidden rounded-md border">
            <div className="grid grid-cols-[minmax(0,1fr)_2.5rem] gap-3 border-b bg-muted/40 px-4 py-3 text-xs font-medium uppercase text-muted-foreground sm:grid-cols-[minmax(0,1fr)_7rem_2.5rem] md:grid-cols-[minmax(0,1fr)_7rem_8rem_2.5rem]">
              <span>Name</span>
              <span className="hidden sm:block">Type</span>
              <span className="hidden md:block">Modified</span>
              <span className="sr-only">Actions</span>
            </div>

            <div className="divide-y">
              {files.map((file) => (
                <div
                  key={file.name}
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
                        {file.type} · {file.size}
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
      </section>
    </main>
  );
}
