"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { SidebarNavItem } from "./SidebarNavItem";
import { HOME, NAV_GROUPS, STANDALONE_TOOLS, groupForPath, type NavTool } from "./nav-groups";
import { useJobs, type Job } from "@/app/hooks/useJobs";
import { useIsIntern } from "@/app/components/RoleContext";

// Interns only get these two. Enforcement is in middleware.ts — this is UI.
const INTERN_NAV_HREFS: readonly string[] = ["/", "/sourcing"];

const KIND_TO_ROUTE: Record<Job["kind"], string> = {
  sourcing: "/sourcing",
  sourcing_bulk: "/sourcing",
  prep: "/prep",
  task_bulk: "/tasks",
  trip_geocode: "/trip",
  trip_search: "/trip",
  calls_log: "/calls",
  accounts_enrich: "/accounts",
  outreach_screen: "/outreach",
  outcomes_build: "/replies",
  e1_prepare: "/send",
  e1_schedule: "/send",
};

const ROUTE_TO_KINDS: Record<string, Job["kind"][]> = Object.entries(
  KIND_TO_ROUTE,
).reduce<Record<string, Job["kind"][]>>((acc, [kind, route]) => {
  (acc[route] ??= []).push(kind as Job["kind"]);
  return acc;
}, {});

const OPEN_KEY = "nav:open-groups";

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}

export function SidebarNav() {
  const pathname = usePathname() ?? "/";
  const { jobs, refetch } = useJobs();
  const lastClearedRef = useRef<string | null>(null);
  const isIntern = useIsIntern();
  const activeGroup = groupForPath(pathname);

  // Which groups are expanded: the active one always, plus whatever Seb opened last.
  const [open, setOpen] = useState<Set<string>>(() => new Set(activeGroup ? [activeGroup] : ["outreach"]));
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(OPEN_KEY) ?? "[]") as string[];
      setOpen(new Set([...saved, ...(activeGroup ? [activeGroup] : [])]));
    } catch {
      /* default */
    }
  }, [activeGroup]);
  function toggle(key: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        window.localStorage.setItem(OPEN_KEY, JSON.stringify(Array.from(next)));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const unreadByRoute = useMemo(() => {
    const map: Record<string, number> = {};
    for (const job of jobs) {
      const isUnread = (job.status === "succeeded" || job.status === "failed") && job.seen_at == null;
      if (!isUnread) continue;
      const route = KIND_TO_ROUTE[job.kind];
      if (!route) continue;
      map[route] = (map[route] ?? 0) + 1;
    }
    return map;
  }, [jobs]);

  // When the user lands on a tool's page, mark its jobs as seen so the dot
  // clears. Guarded so a single visit doesn't fire repeated requests.
  useEffect(() => {
    const matchingRoute = Object.keys(ROUTE_TO_KINDS).find((route) => pathname === route || pathname.startsWith(route + "/"));
    if (!matchingRoute) return;
    if ((unreadByRoute[matchingRoute] ?? 0) === 0) return;
    const cacheKey = `${matchingRoute}:${unreadByRoute[matchingRoute]}`;
    if (lastClearedRef.current === cacheKey) return;
    lastClearedRef.current = cacheKey;
    const kinds = ROUTE_TO_KINDS[matchingRoute];
    fetch("/api/jobs/seen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kinds }) })
      .then(() => refetch())
      .catch(() => {
        lastClearedRef.current = null;
      });
  }, [pathname, unreadByRoute, refetch]);

  const item = (tool: NavTool) => (
    <SidebarNavItem key={tool.href} href={tool.href} label={tool.label} Icon={tool.icon} active={isActive(pathname, tool.href)} unread={(unreadByRoute[tool.href] ?? 0) > 0} />
  );

  if (isIntern) {
    const tools = [HOME, ...NAV_GROUPS.flatMap((g) => g.tools), ...STANDALONE_TOOLS].filter((t) => INTERN_NAV_HREFS.includes(t.href));
    return <nav className="space-y-0.5" aria-label="Primary">{tools.map(item)}</nav>;
  }

  return (
    <nav className="space-y-0.5" aria-label="Primary">
      {item(HOME)}
      {NAV_GROUPS.map((group) => {
        const expanded = open.has(group.key);
        const groupUnread = group.tools.some((t) => (unreadByRoute[t.href] ?? 0) > 0);
        const GroupIcon = group.icon;
        return (
          <div key={group.key} className="pt-1">
            <button
              type="button"
              onClick={() => toggle(group.key)}
              aria-expanded={expanded}
              className={`flex h-9 w-full items-center gap-3 rounded-sm px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-surface-4 ${
                activeGroup === group.key && !expanded ? "text-white" : "text-ink-inverse-muted"
              } hover:bg-surface-sidebar-active/60 hover:text-white`}
            >
              <GroupIcon className="h-5 w-5 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{group.label}</span>
              {groupUnread && !expanded ? <span aria-label="New activity" className="ml-auto h-2 w-2 shrink-0 rounded-full bg-brand" /> : null}
              <ChevronDown className={`${groupUnread && !expanded ? "ml-2" : "ml-auto"} h-4 w-4 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} strokeWidth={1.5} />
            </button>
            {expanded ? <div className="ml-4 border-l border-white/10 pl-1">{group.tools.map(item)}</div> : null}
          </div>
        );
      })}
      <div className="pt-1">{STANDALONE_TOOLS.map(item)}</div>
    </nav>
  );
}
