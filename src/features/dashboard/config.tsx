import {
  Clock,
  Folder,
  FolderPlus,
  HardDrive,
  RefreshCw,
  Settings,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Trash2,
  Upload,
  UserPlus,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type DashboardSectionKey =
  | "files"
  | "recent"
  | "favorites"
  | "shared"
  | "trash"
  | "settings"
  | "storage"
  | "transfers"
  | "users"
  | "security";

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
  content: "files" | "system";
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
    searchPlaceholder: "Search files",
    actions: [
      { label: "New folder", icon: FolderPlus, variant: "outline" },
      { label: "Upload", icon: Upload },
    ],
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
    searchPlaceholder: "Search recent files",
    actions: [{ label: "Filter", icon: SlidersHorizontal, variant: "outline" }],
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
    searchPlaceholder: "Search favorites",
    actions: [{ label: "Filter", icon: SlidersHorizontal, variant: "outline" }],
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
    searchPlaceholder: "Search shared files",
    actions: [{ label: "Create share", icon: Share2 }],
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
    searchPlaceholder: "Search trash",
    actions: [{ label: "Empty trash", icon: Trash2, variant: "destructive" }],
  },
  {
    key: "settings",
    label: "Settings",
    href: "/settings",
    group: "primary",
    content: "system",
    icon: Settings,
    title: "Settings",
    subtitle: "App and server configuration",
  },
  {
    key: "storage",
    label: "Storage",
    href: "/storage",
    group: "system",
    content: "system",
    icon: HardDrive,
    title: "Storage",
    subtitle: "Capacity, quotas, and storage locations",
    actions: [
      { label: "Refresh", icon: RefreshCw, variant: "outline" },
      { label: "Configure", icon: Settings },
    ],
  },
  {
    key: "transfers",
    label: "Transfers",
    href: "/transfers",
    group: "system",
    content: "system",
    icon: Upload,
    title: "Transfers",
    subtitle: "Uploads, downloads, and failed jobs",
    searchPlaceholder: "Search transfers",
    actions: [
      { label: "Clear completed", icon: Trash2, variant: "outline" },
    ],
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
    searchPlaceholder: "Search users",
    actions: [{ label: "New user", icon: UserPlus }],
  },
  {
    key: "security",
    label: "Security",
    href: "/security",
    group: "system",
    content: "system",
    icon: ShieldCheck,
    title: "Security",
    subtitle: "Sessions, passwords, and access controls",
    actions: [{ label: "Review sessions", icon: ShieldCheck }],
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
