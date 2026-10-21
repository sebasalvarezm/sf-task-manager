"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { NAV_GROUPS, STANDALONE_TOOLS } from "@/app/components/shell/nav-groups";
import { Card } from "@/app/components/ui/Card";
import { Badge } from "@/app/components/ui/Badge";
import { useIsIntern } from "@/app/components/RoleContext";

type ConnState = boolean | null;

type Tool = {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  needs: Array<"sf" | "ms" | "outreach">;
};

const toTool = (t: { href: string; label: string; description: string; icon: LucideIcon; needs: Array<"sf" | "ms" | "outreach"> }): Tool => ({ href: t.href, title: t.label, description: t.description, icon: t.icon, needs: t.needs });
const TOOLS: Tool[] = [...NAV_GROUPS.flatMap((g) => g.tools), ...STANDALONE_TOOLS].map(toTool);

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
      if (sfRes.ok) setSfConnected((await sfRes.json()).connected); else setSfConnected(false);
      if (msRes.ok) setMsConnected((await msRes.json()).connected); else setMsConnected(false);
      if (orRes.ok) setOutreachConnected((await orRes.json()).connected); else setOutreachConnected(false);
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

  const [openGroup, setOpenGroup] = useState<string | null>(null);

  function renderTool(tool: Tool) {
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
  }

  return (
    <>
      <div className="mb-8 mt-2 md:mt-4">
        <h1 className="text-[32px] leading-[38px] font-normal tracking-tight text-ink">{greeting()}{isIntern ? "" : ", Seb"}</h1>
        <p className="mt-1 text-sm text-ink-secondary">{formatToday()}</p>
      </div>

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
              All clear, nothing overdue
            </Badge>
          )}
        </div>
      )}

      {/* Three blocks in the order the work happens; a block opens to show its tools in sequence. */}
      {isIntern ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">{visibleTools.map(renderTool)}</div>
      ) : (
        <div className="space-y-4">
          {NAV_GROUPS.map((group) => {
            const expanded = openGroup === group.key;
            const GroupIcon = group.icon;
            return (
              <section key={group.key} className="rounded-md border border-line bg-white">
                <button
                  type="button"
                  onClick={() => setOpenGroup((v) => (v === group.key ? null : group.key))}
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-surface-3"
                >
                  <div className="rounded-lg bg-surface-3 p-2.5 text-ink">
                    <GroupIcon className="h-5 w-5" strokeWidth={1.75} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-base font-semibold text-ink">{group.label}</h2>
                    <p className="text-sm text-ink-muted">{group.description}</p>
                  </div>
                  <span className="hidden text-xs text-ink-muted sm:block">{group.tools.map((t) => t.label).join(" → ")}</span>
                  <ChevronDown className={`h-5 w-5 shrink-0 text-ink-muted transition-transform ${expanded ? "rotate-180" : ""}`} strokeWidth={1.5} />
                </button>
                {expanded ? (
                  <div className="grid grid-cols-1 gap-4 border-t border-line p-4 sm:grid-cols-2 xl:grid-cols-4">
                    {group.tools.map(toTool).map(renderTool)}
                  </div>
                ) : null}
              </section>
            );
          })}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">{STANDALONE_TOOLS.map(toTool).map(renderTool)}</div>
        </div>
      )}
    </>
  );
}
