"use client";

import { useEffect, useMemo, useRef } from "react";
import { usePathname } from "next/navigation";
import {
  Home,
  ListChecks,
  Phone,
  FileText,
  Send,
  Building2,
  Search,
  BarChart3,
  MapPin,
} from "lucide-react";
import { SidebarNavItem } from "./SidebarNavItem";
import { useJobs, type Job } from "@/app/hooks/useJobs";

const NAV = [
  { href: "/",         label: "Home",         icon: Home },
  { href: "/tasks",    label: "Tasks",        icon: ListChecks },
  { href: "/calls",    label: "Call Logger",  icon: Phone },
  { href: "/prep",     label: "Call Prep",    icon: FileText },
  { href: "/outreach", label: "Outreach",     icon: Send },
  { href: "/accounts", label: "Accounts",     icon: Building2 },
  { href: "/sourcing", label: "Sourcing",     icon: Search },
  { href: "/stats",    label: "Stats",        icon: BarChart3 },
  { href: "/trip",     label: "Trip Planner", icon: MapPin },
] as const;

const KIND_TO_ROUTE: Record<Job["kind"], string> = {
  sourcing: "/sourcing",
  prep: "/prep",
  task_bulk: "/tasks",
  trip_geocode: "/trip",
  trip_search: "/trip",
  calls_log: "/calls",
  accounts_enrich: "/accounts",
};

const ROUTE_TO_KINDS: Record<string, Job["kind"][]> = Object.entries(
  KIND_TO_ROUTE,
).reduce<Record<string, Job["kind"][]>>((acc, [kind, route]) => {
  (acc[route] ??= []).push(kind as Job["kind"]);
  return acc;
}, {});

export function SidebarNav() {
  const pathname = usePathname() ?? "/";
  const { jobs, refetch } = useJobs();
  const lastClearedRef = useRef<string | null>(null);

  const unreadByRoute = useMemo(() => {
    const map: Record<string, number> = {};
    for (const job of jobs) {
      const isUnread =
        (job.status === "succeeded" || job.status === "failed") &&
        job.seen_at == null;
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
    const matchingRoute = Object.keys(ROUTE_TO_KINDS).find((route) =>
      pathname === route || pathname.startsWith(route + "/"),
    );
    if (!matchingRoute) return;
    if ((unreadByRoute[matchingRoute] ?? 0) === 0) return;
    const cacheKey = `${matchingRoute}:${unreadByRoute[matchingRoute]}`;
    if (lastClearedRef.current === cacheKey) return;
    lastClearedRef.current = cacheKey;
    const kinds = ROUTE_TO_KINDS[matchingRoute];
    fetch("/api/jobs/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kinds }),
    })
      .then(() => refetch())
      .catch(() => {
        // Reset cache key so we retry on next render.
        lastClearedRef.current = null;
      });
  }, [pathname, unreadByRoute, refetch]);

  return (
    <nav className="space-y-0.5" aria-label="Primary">
      {NAV.map((item) => {
        const active =
          item.href === "/"
            ? pathname === "/"
            : pathname === item.href || pathname.startsWith(item.href + "/");
        const unread = (unreadByRoute[item.href] ?? 0) > 0;
        return (
          <SidebarNavItem
            key={item.href}
            href={item.href}
            label={item.label}
            Icon={item.icon}
            active={active}
            unread={unread}
          />
        );
      })}
    </nav>
  );
}
