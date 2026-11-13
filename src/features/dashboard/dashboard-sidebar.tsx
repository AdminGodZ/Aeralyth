"use client";

import { LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { AeralythLogo } from "@/components/aeralyth-logo";
import {
  type DashboardSection,
  getDashboardSection,
  primaryDashboardSections,
  systemDashboardSections,
} from "@/features/dashboard/config";
import { useVault } from "@/features/vault/vault-provider";
import { cn } from "@/lib/utils";

const SIDEBAR_COOKIE = "aeralyth_sidebar_collapsed";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

type NavigationIndicator = {
  animate: boolean;
  top: number;
  visible: boolean;
};

export function DashboardSidebar({
  canViewSystemNavigation,
  csrfToken,
  initialCollapsed,
  profileName,
  username,
  avatar,
}: {
  canViewSystemNavigation: boolean;
  csrfToken: string;
  initialCollapsed: boolean;
  profileName: string;
  username: string;
  avatar: ReactNode;
}) {
  const pathname = usePathname();
  const vault = useVault();
  const pathnameSectionKey =
    getDashboardSection(pathname.split("/")[1] ?? "")?.key ?? "files";
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);
  const sidebarRef = useRef<HTMLElement>(null);
  const indicatorHasPosition = useRef(false);
  const [navigationIndicator, setNavigationIndicator] =
    useState<NavigationIndicator>({
      animate: false,
      top: 0,
      visible: false,
    });

  const moveNavigationIndicator = useCallback((element: HTMLElement) => {
    const sidebar = sidebarRef.current;

    if (!sidebar) {
      return;
    }

    const sidebarBounds = sidebar.getBoundingClientRect();
    const elementBounds = element.getBoundingClientRect();

    setNavigationIndicator({
      animate: indicatorHasPosition.current,
      top: elementBounds.top - sidebarBounds.top,
      visible: true,
    });
    indicatorHasPosition.current = true;
  }, []);

  const restoreActiveIndicator = useCallback(() => {
    const activeLink = sidebarRef.current?.querySelector<HTMLElement>(
      '[data-sidebar-active="true"]',
    );

    if (activeLink) {
      moveNavigationIndicator(activeLink);
    }
  }, [moveNavigationIndicator]);

  // Route and collapse changes alter the measured DOM without changing this stable callback.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Both values intentionally trigger a post-render remeasurement.
  useLayoutEffect(() => {
    restoreActiveIndicator();
  }, [pathnameSectionKey, isCollapsed, restoreActiveIndicator]);

  useEffect(() => {
    window.addEventListener("resize", restoreActiveIndicator);

    return () => {
      window.removeEventListener("resize", restoreActiveIndicator);
    };
  }, [restoreActiveIndicator]);

  function toggleSidebar() {
    const nextCollapsed = !isCollapsed;

    setIsCollapsed(nextCollapsed);
    // The server reads this preference during SSR, and the synchronous cookie API
    // remains the broadly compatible way to persist a server-readable UI setting.
    // biome-ignore lint/suspicious/noDocumentCookie: This is a non-sensitive SSR layout preference.
    document.cookie = `${SIDEBAR_COOKIE}=${nextCollapsed ? "1" : "0"}; Path=/; Max-Age=${SIDEBAR_COOKIE_MAX_AGE}; SameSite=Lax`;
  }

  const collapseToggle = (
    <button
      type="button"
      onClick={toggleSidebar}
      aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!isCollapsed}
      title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      className="sidebar-icon-button"
    >
      {isCollapsed ? (
        <PanelLeftOpen className="size-4" aria-hidden="true" />
      ) : (
        <PanelLeftClose className="size-4" aria-hidden="true" />
      )}
    </button>
  );

  return (
    <aside
      ref={sidebarRef}
      data-collapsed={isCollapsed}
      className={cn(
        "dashboard-sidebar hidden shrink-0 flex-col px-3 pt-5 pb-3 transition-[width] duration-200 lg:flex",
        isCollapsed ? "w-[4.5rem]" : "w-64",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "sidebar-active-indicator pointer-events-none absolute top-0 z-0 h-10 motion-reduce:transition-none",
          navigationIndicator.animate &&
            "transition-[transform,width,opacity] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
        )}
        style={
          {
            left: isCollapsed ? "1rem" : "0.75rem",
            opacity: navigationIndicator.visible ? 1 : 0,
            transform: `translate3d(0, ${navigationIndicator.top}px, 0)`,
            width: isCollapsed ? "2.5rem" : "calc(100% - 1.5rem)",
          } satisfies CSSProperties
        }
      />

      <div
        className={cn(
          "flex min-h-10 items-center gap-2",
          isCollapsed ? "flex-col" : "justify-between pl-2",
        )}
      >
        <Link
          href="/files"
          aria-label="Aeralyth files"
          title={isCollapsed ? "Aeralyth" : undefined}
          className="flex h-10 min-w-0 items-center gap-2.5"
        >
          <AeralythLogo className="size-7 shrink-0" />
          {!isCollapsed ? (
            <span className="min-w-0 truncate text-lg font-semibold tracking-tight">
              Aeralyth
            </span>
          ) : null}
        </Link>
        {collapseToggle}
      </div>

      <div className="mt-8 flex flex-col gap-7">
        <SidebarGroup label="Workspace" collapsed={isCollapsed}>
          <nav className="space-y-1" aria-label="Main navigation">
            {primaryDashboardSections.map((item) => (
              <SidebarLink
                key={item.key}
                section={item}
                active={item.key === pathnameSectionKey}
                collapsed={isCollapsed}
              />
            ))}
          </nav>
        </SidebarGroup>

        {canViewSystemNavigation ? (
          <SidebarGroup label="System" collapsed={isCollapsed}>
            <nav className="space-y-1" aria-label="System navigation">
              {systemDashboardSections.map((item) => (
                <SidebarLink
                  key={item.key}
                  section={item}
                  active={item.key === pathnameSectionKey}
                  collapsed={isCollapsed}
                />
              ))}
            </nav>
          </SidebarGroup>
        ) : null}
      </div>

      <div className="mt-auto pt-6">
        <div
          className={cn(
            "flex gap-1",
            isCollapsed ? "flex-col items-center" : "items-center",
          )}
        >
          <Link
            href="/settings"
            title={isCollapsed ? profileName : undefined}
            aria-label={`Open settings for ${profileName}`}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1.5 transition-colors hover:bg-white/[5%]"
          >
            <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/10 text-xs font-semibold">
              {avatar}
            </span>
            {!isCollapsed ? (
              <span className="min-w-0 leading-tight">
                <span className="block truncate text-sm font-medium">
                  {profileName}
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  @{username}
                </span>
              </span>
            ) : null}
          </Link>
          <form
            action="/api/auth/logout"
            method="post"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              // Erase the persisted resume key before navigation closes its worker.
              void vault.lock().finally(() => form.submit());
            }}
          >
            <input type="hidden" name="csrf_token" value={csrfToken} />
            <button
              type="submit"
              title="Sign out"
              aria-label="Sign out"
              className="sidebar-icon-button hover:text-destructive"
            >
              <LogOut className="size-4" aria-hidden="true" />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}

function SidebarGroup({
  label,
  collapsed,
  children,
}: {
  label: string;
  collapsed: boolean;
  children: ReactNode;
}) {
  return (
    <section>
      <p
        className={cn(
          "mb-2 px-3 text-[13px] text-muted-foreground",
          collapsed && "sr-only",
        )}
      >
        {label}
      </p>
      {children}
    </section>
  );
}

function SidebarLink({
  section,
  active,
  collapsed,
}: {
  section: DashboardSection;
  active: boolean;
  collapsed: boolean;
}) {
  return (
    <Link
      href={section.href}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? section.label : undefined}
      title={collapsed ? section.label : undefined}
      data-sidebar-active={active ? "true" : "false"}
      className={cn(
        "relative z-10 flex h-10 items-center gap-3 rounded-xl px-3 text-left text-[15px] font-medium transition-colors",
        collapsed ? "ml-1 w-10 justify-center px-0" : "w-full",
        active
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <section.icon className="size-[1.125rem] shrink-0" aria-hidden="true" />
      {!collapsed ? <span className="truncate">{section.label}</span> : null}
    </Link>
  );
}
