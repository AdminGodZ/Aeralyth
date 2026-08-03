"use client";

import { LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { AeralythLogo } from "@/components/aeralyth-logo";
import { Button } from "@/components/ui/button";
import {
  type DashboardSection,
  getDashboardSection,
  primaryDashboardSections,
  systemDashboardSections,
} from "@/features/dashboard/config";
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
}: {
  canViewSystemNavigation: boolean;
  csrfToken: string;
  initialCollapsed: boolean;
}) {
  const pathname = usePathname();
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

  return (
    <aside
      ref={sidebarRef}
      data-collapsed={isCollapsed}
      className={cn(
        "dashboard-sidebar hidden shrink-0 flex-col px-4 pb-5 pt-9 transition-[width] duration-200 lg:flex",
        isCollapsed ? "w-20" : "w-[15.5rem]",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-4 top-0 z-0 h-9 rounded-full motion-reduce:transition-none",
          navigationIndicator.animate &&
            "transition-[transform,width,opacity] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
          "bg-primary/[0.12]",
        )}
        style={
          {
            opacity: navigationIndicator.visible ? 1 : 0,
            transform: `translate3d(0, ${navigationIndicator.top}px, 0)`,
            width: isCollapsed ? "2.5rem" : "calc(100% - 2rem)",
          } satisfies CSSProperties
        }
      />

      <div>
        <Link
          href="/files"
          aria-label="Aeralyth files"
          title={isCollapsed ? "Aeralyth" : undefined}
          className={cn(
            "flex h-10 min-w-0 items-center gap-3",
            isCollapsed ? "w-10 justify-start" : "w-full justify-center",
          )}
        >
          <AeralythLogo className="size-10 shrink-0" />
          {!isCollapsed ? (
            <span className="min-w-0 truncate font-display text-4xl font-semibold leading-10">
              Aeralyth
            </span>
          ) : null}
        </Link>
        <hr className={cn("mt-5 border-border", isCollapsed && "w-10")} />
      </div>

      <div className="mt-6 space-y-7">
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

        {canViewSystemNavigation ? (
          <section className={cn("border-t pt-5", isCollapsed && "w-10")}>
            <p
              className={cn(
                "px-3 text-xs font-medium uppercase text-muted-foreground",
                isCollapsed && "sr-only",
              )}
            >
              System
            </p>
            <nav
              className={cn("space-y-1", !isCollapsed && "mt-2")}
              aria-label="System navigation"
            >
              {systemDashboardSections.map((item) => (
                <SidebarLink
                  key={item.key}
                  section={item}
                  active={item.key === pathnameSectionKey}
                  collapsed={isCollapsed}
                />
              ))}
            </nav>
          </section>
        ) : null}
      </div>

      <div className="mt-auto pt-6">
        <div
          className={cn(
            "relative h-9 transition-[height] duration-200 ease-out",
            isCollapsed && "h-[5.25rem]",
          )}
        >
          <form
            action="/api/auth/logout"
            method="post"
            className={cn(
              "absolute left-0 top-0 h-9 min-w-0 transition-[width] duration-200 ease-out",
              isCollapsed ? "w-10" : "w-[calc(100%-2.5rem)]",
            )}
          >
            <input type="hidden" name="csrf_token" value={csrfToken} />
            <Button
              type="submit"
              variant="ghost"
              title={isCollapsed ? "Sign out" : undefined}
              aria-label={isCollapsed ? "Sign out" : undefined}
              className={cn(
                "h-9 justify-start border-transparent bg-transparent px-3 text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:border-transparent dark:hover:bg-destructive/15",
                isCollapsed ? "w-10" : "w-full",
              )}
            >
              <LogOut className="size-4" aria-hidden="true" />
              {!isCollapsed ? <span>Sign out</span> : null}
            </Button>
          </form>

          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            onClick={toggleSidebar}
            aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!isCollapsed}
            title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "absolute border-transparent bg-transparent text-foreground transition-[top,right,width] duration-200 ease-out hover:bg-foreground/[0.08] focus-visible:border-transparent aria-expanded:bg-transparent aria-expanded:hover:bg-foreground/[0.08] active:not-aria-[haspopup]:translate-y-0",
              isCollapsed
                ? "right-2 top-12 w-10 justify-start px-3"
                : "right-0 top-0",
            )}
          >
            {isCollapsed ? (
              <PanelLeftOpen className="size-4" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="size-4" aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>
    </aside>
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
        "relative z-10 flex h-9 items-center gap-2 rounded-full px-3 text-left text-sm transition-colors",
        collapsed ? "w-10" : "w-full",
        active
          ? "font-medium text-foreground [&_svg]:text-primary"
          : "text-muted-foreground hover:bg-primary/[0.07] hover:text-foreground",
      )}
    >
      <section.icon className="size-4 shrink-0" aria-hidden="true" />
      {!collapsed ? <span className="truncate">{section.label}</span> : null}
    </Link>
  );
}
