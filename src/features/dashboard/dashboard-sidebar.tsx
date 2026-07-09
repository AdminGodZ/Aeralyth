"use client";

import { LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { AeralythLogo } from "@/components/aeralyth-logo";
import { Button } from "@/components/ui/button";
import {
  primaryDashboardSections,
  systemDashboardSections,
  type DashboardSection,
  type DashboardSectionKey,
} from "@/features/dashboard/config";
import { cn } from "@/lib/utils";

const SIDEBAR_COOKIE = "aeralyth_sidebar_collapsed";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function DashboardSidebar({
  activeSectionKey,
  canViewSystemNavigation,
  csrfToken,
  initialCollapsed,
}: {
  activeSectionKey: DashboardSectionKey;
  canViewSystemNavigation: boolean;
  csrfToken: string;
  initialCollapsed: boolean;
}) {
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);

  function toggleSidebar() {
    const nextCollapsed = !isCollapsed;

    setIsCollapsed(nextCollapsed);
    document.cookie = `${SIDEBAR_COOKIE}=${nextCollapsed ? "1" : "0"}; Path=/; Max-Age=${SIDEBAR_COOKIE_MAX_AGE}; SameSite=Lax`;
  }

  return (
    <aside
      data-collapsed={isCollapsed}
      className={cn(
        "dashboard-sidebar hidden shrink-0 flex-col pb-5 pt-9 transition-[width,padding] duration-200 lg:flex",
        isCollapsed ? "w-20 px-3" : "w-64 px-4",
      )}
    >
      <div className={cn(isCollapsed ? "px-0" : "px-2")}>
        <Link
          href="/files"
          aria-label="Aeralyth files"
          title={isCollapsed ? "Aeralyth" : undefined}
          className={cn(
            "flex h-10 min-w-0 items-center",
            isCollapsed ? "justify-center" : "gap-3",
          )}
        >
          <AeralythLogo className="size-10 shrink-0" />
          {!isCollapsed ? (
            <span className="truncate font-display text-4xl font-semibold leading-10">
              Aeralyth
            </span>
          ) : null}
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
              collapsed={isCollapsed}
            />
          ))}
        </nav>

        {canViewSystemNavigation ? (
          <section className={cn(isCollapsed && "border-t pt-5")}>
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
                  active={item.key === activeSectionKey}
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
            "flex gap-1",
            isCollapsed ? "flex-col items-center" : "items-center",
          )}
        >
          <form
            action="/api/auth/logout"
            method="post"
            className={cn("min-w-0", isCollapsed ? "flex-none" : "flex-1")}
          >
            <input type="hidden" name="csrf_token" value={csrfToken} />
            <Button
              type="submit"
              variant="secondary"
              title={isCollapsed ? "Sign out" : undefined}
              aria-label={isCollapsed ? "Sign out" : undefined}
              className={cn(
                "h-9 text-muted-foreground hover:text-destructive",
                isCollapsed ? "w-9 px-0" : "w-full justify-start px-3",
              )}
            >
              <LogOut className="size-4" aria-hidden="true" />
              {!isCollapsed ? <span>Sign out</span> : null}
            </Button>
          </form>

          <Button
            type="button"
            variant="secondary"
            size="icon-lg"
            onClick={toggleSidebar}
            aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!isCollapsed}
            title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="text-muted-foreground"
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
      className={cn(
        "flex h-9 w-full items-center rounded-full text-sm transition-colors",
        collapsed ? "justify-center px-0" : "gap-2 px-3 text-left",
        active
          ? "bg-background font-medium text-foreground shadow-xs"
          : "text-muted-foreground hover:bg-background hover:text-foreground",
      )}
    >
      <section.icon className="size-4 shrink-0" aria-hidden="true" />
      {!collapsed ? <span className="truncate">{section.label}</span> : null}
    </Link>
  );
}
