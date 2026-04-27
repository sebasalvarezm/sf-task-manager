"use client";

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

export function SidebarNav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="space-y-0.5" aria-label="Primary">
      {NAV.map((item) => {
        const active =
          item.href === "/"
            ? pathname === "/"
            : pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <SidebarNavItem
            key={item.href}
            href={item.href}
            label={item.label}
            Icon={item.icon}
            active={active}
          />
        );
      })}
    </nav>
  );
}
