"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ListChecks,
  Send,
  Phone,
  FileText,
  Building2,
  Search,
  BarChart3,
  MapPin,
  CalendarRange,
  type LucideIcon,
} from "lucide-react";
import { Card } from "@/app/components/ui/Card";
import { Badge } from "@/app/components/ui/Badge";
import { useIsIntern } from "@/app/components/RoleContext";

type ConnState = boolean | null;

type Tool = {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  // Which connections this tool needs. Order = render order.
  needs: Array<"sf" | "ms" | "outreach">;
};

const TOOLS: Tool[] = [
  { href: "/tasks", title: "Tasks", description: "Manage open Salesforce tasks by week and send reconnects into Weekly Outreach.", icon: ListChecks, needs: ["sf"] },
  { href: "/prep", title: "Call Prep", description: "Generate a 60-second briefing plus a complete business and relationship refresher.", icon: FileText, needs: ["sf", "ms"] },
  { href: "/weekly-outreach", title: "Weekly Outreach", description: "Build this week's E1 and RCE list from Tasks, Re-Contact, or Salesforce names.", icon: CalendarRange, needs: ["sf", "ms"] },
  { href: "/sourcing", title: "Sourcing", description: "Research companies and produce personalized, ready-to-review E1 outreach.", icon: Search, needs: [] },
  { href: "/calls", title: "Call Logger", description: "Review Outlook meetings and log calls and follow-ups to Salesforce.", icon: Phone, needs: ["sf", "ms"] },
  { href: "/outreach", title: "Outreach Queue", description: "Surface accounts due for another contact and push the next step to Salesforce and Outreach.", icon: Send, needs: ["sf", "outreach"] },
  { href: "/accounts", title: "Account Creator", description: "Create a Salesforce account from a company URL.", icon: Building2, needs: ["sf"] },
  { href: "/stats", title: "Weekly Stats", description: "Review CDM outreach, calls, meetings, and pipeline.", icon: BarChart3, needs: ["sf"] },
  { href: "/trip", title: "Trip Planner", description: "Find nearby accounts and discover targets around a trip.", icon: MapPin, needs: ["sf"] },
];

// Interns only get the Sourcing card. Enforcement is in middleware.ts.
const INTERN_TOOL_HREFS: readonly string[] = ["/sourcing"];

const CONN_LABEL: Record<"sf" | "ms" | "outreach", string> = {
  sf: "Salesforce",
  ms: "Outlook",
  outreach: "Outreach",
};

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function formatToday() {
  return new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function HomePage() {
  const isIntern = useIsIntern();
  const [sfConnected, setSfConnected] = useState<ConnState>(null);
  const [msConnected, setMsConnected] = useState<ConnState>(null);
  const [outreachConnected, setOutreachConnected] = useState<ConnState>(null);
  const [dashSummary, setDashSummary] = useState<{
    overdueTasks: number | null;
    dueOutreach: number | null;
  } | null>(null);

  const visibleTools = useMemo(
    () =>
      isIntern ? TOOLS.filter((t) => INTERN_TOOL_HREFS.includes(t.href)) : TOOLS,
    [isIntern],
  );

  useEffect(() => {
    // Interns are blocked from the status + dashboard endpoints by middleware,
    // and the Sourcing card needs no connections, so skip the fetches entirely.
    if (isIntern) return;
    void loadAll();
  }, [isIntern]);

  async function loadAll() {
    try {
      const [sfRes, msRes, orRes] = await Promise.all([
        fetch("/api/salesforce/status"),
        fetch("/api/microsoft/status"),
        fetch("/api/outreach/status"),
      ]);
      if (sfRes.ok) setSfConnected((await sfRes.json()).connected);
      if (msRes.ok) setMsConnected((await msRes.json()).connected);
      if (orRes.ok) setOutreachConnected((await orRes.json()).connected);
    } catch {
      setSfConnected(false);
      setMsConnected(false);
      setOutreachConnected(false);
    }
    try {
      const sumRes = await fetch("/api/dashboard/summary");
      if (sumRes.ok) setDashSummary(await sumRes.json());
    } catch {
      /* non-fatal */
    }
  }

  function statusFor(key: "sf" | "ms" | "outreach"): ConnState {
    if (key === "sf") return sfConnected;
    if (key === "ms") return msConnected;
    return outreachConnected;
  }

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden rounded-xl bg-navy text-ink-inverse mb-6 md:mb-8 px-5 py-6 md:px-8 md:py-10">
        <div className="absolute inset-0 bg-gradient-to-br from-navy via-navy to-navy-dark opacity-90 pointer-events-none" />
        <div className="relative">
          <p className="text-xs uppercase tracking-widest text-ink-inverse-muted mb-2">
            Valstone &middot; Platform
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            {greeting()}.
          </h1>
          <p className="text-sm text-ink-inverse-muted mt-1.5">
            {formatToday()}
          </p>
        </div>
      </section>

      {/* Status banner */}
      {dashSummary && (
        <div className="flex flex-wrap gap-2 mb-8">
          {dashSummary.overdueTasks != null && dashSummary.overdueTasks > 0 && (
            <Link href="/tasks" className="no-underline">
              <Badge variant="danger" size="md" dot>
                {dashSummary.overdueTasks} overdue task
                {dashSummary.overdueTasks !== 1 ? "s" : ""}
              </Badge>
            </Link>
          )}
          {dashSummary.dueOutreach != null && dashSummary.dueOutreach > 0 && (
            <Link href="/outreach" className="no-underline">
              <Badge variant="brand" size="md" dot>
                {dashSummary.dueOutreach} account
                {dashSummary.dueOutreach !== 1 ? "s" : ""} due for outreach
              </Badge>
            </Link>
          )}
          {dashSummary.overdueTasks === 0 && dashSummary.dueOutreach === 0 && (
            <Badge variant="ok" size="md" dot>
              All clear — nothing overdue
            </Badge>
          )}
        </div>
      )}

      {/* Quick access */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-ink-muted">
          Quick Access
        </h2>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {visibleTools.map((tool) => {
          const Icon = tool.icon;
          return (
            <Link key={tool.href} href={tool.href} className="no-underline">
              <Card hoverable padded={false} className="h-full p-5 flex flex-col">
                <div className="flex items-start justify-between mb-4">
                  <div className="rounded-lg bg-surface-3 p-2.5 text-ink">
                    <Icon className="h-5 w-5" strokeWidth={1.75} />
                  </div>
                </div>
                <h3 className="text-base font-semibold text-ink leading-snug mb-1.5">
                  {tool.title}
                </h3>
                <p className="text-sm text-ink-muted leading-relaxed mb-4 line-clamp-3">
                  {tool.description}
                </p>
                {tool.needs.length > 0 && (
                  <div className="mt-auto flex flex-wrap gap-1.5">
                    {tool.needs.map((key) => {
                      const state = statusFor(key);
                      const label = CONN_LABEL[key];
                      if (state === null) {
                        return (
                          <Badge key={key} variant="neutral" size="sm">
                            …
                          </Badge>
                        );
                      }
                      if (state === true) {
                        return (
                          <Badge key={key} variant="ok" size="sm" dot>
                            {label}
                          </Badge>
                        );
                      }
                      return (
                        <Badge key={key} variant="warn" size="sm">
                          {label} not connected
                        </Badge>
                      );
                    })}
                  </div>
                )}
              </Card>
            </Link>
          );
        })}
      </div>
    </>
  );
}
