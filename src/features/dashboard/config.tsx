import type { LucideIcon } from "lucide-react";
import {
  Clock,
  Folder,
  FolderGit2,
  HardDrive,
  Settings,
  Share2,
  Star,
  Trash2,
  Users,
} from "lucide-react";

export type DashboardSectionKey =
  | "files"
  | "repositories"
  | "recent"
  | "favorites"
  | "shared"
  | "trash"
  | "settings"
  | "storage"
  | "users";

type DashboardAction = {
  label: string;
  icon: LucideIcon;
  variant?: "default" | "outline" | "destructive";
};

export type DashboardSection = {
  key: DashboardSectionKey;
  label: string;
  href: string;
  group: "primary" | "system";
  content: "files" | "repositories" | "system";
  icon: LucideIcon;
  title: string;
  subtitle: string;
  searchPlaceholder?: string;
  actions?: DashboardAction[];
};

export const dashboardSections: DashboardSection[] = [
  {
    key: "files",
    label: "Files",
    href: "/files",
    group: "primary",
    content: "files",
    icon: Folder,
    title: "Files",
    subtitle: "Personal workspace",
  },
  {
    key: "repositories",
    label: "Repositories",
    href: "/repositories",
    group: "primary",
    content: "repositories",
    icon: FolderGit2,
    title: "Repositories",
    subtitle: "Project folders in a code-focused view",
  },
  {
    key: "recent",
    label: "Recent",
    href: "/recent",
    group: "primary",
    content: "files",
    icon: Clock,
    title: "Recent",
    subtitle: "Recently opened and changed files",
  },
  {
    key: "favorites",
    label: "Favorites",
    href: "/favorites",
    group: "primary",
    content: "files",
    icon: Star,
    title: "Favorites",
    subtitle: "Pinned files and folders",
  },
  {
    key: "shared",
    label: "Shared",
    href: "/shared",
    group: "primary",
    content: "files",
    icon: Share2,
    title: "Shared",
    subtitle: "Links and files shared with others",
  },
  {
    key: "trash",
    label: "Trash",
    href: "/trash",
    group: "primary",
    content: "files",
    icon: Trash2,
    title: "Trash",
    subtitle: "Deleted items before permanent removal",
  },
  {
    key: "settings",
    label: "Settings",
    href: "/settings",
    group: "primary",
    content: "system",
    icon: Settings,
    title: "Settings",
    subtitle: "Profile and appearance",
  },
  {
    key: "storage",
    label: "Storage",
    href: "/storage",
    group: "system",
    content: "system",
    icon: HardDrive,
    title: "Storage",
    subtitle: "Account usage and storage bucket",
  },
  {
    key: "users",
    label: "Users",
    href: "/users",
    group: "system",
    content: "system",
    icon: Users,
    title: "Users",
    subtitle: "Accounts, roles, and access",
  },
];

export const primaryDashboardSections = dashboardSections.filter(
  (section) => section.group === "primary",
);

export const systemDashboardSections = dashboardSections.filter(
  (section) => section.group === "system",
);

export function getDashboardSection(sectionKey: string) {
  return dashboardSections.find((section) => section.key === sectionKey);
}
