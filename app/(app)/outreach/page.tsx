"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronDown, MoreHorizontal } from "lucide-react";
import { PageContent } from "@/app/components/ui/PageContent";
import { Button } from "@/app/components/ui/Button";

/**
 * Outreach: the next companies to email, prequalified.
 *
 * One list. Every row here has already passed the rules of engagement
 * (lib/outreach-rules.ts) and the website check (lib/outreach-screen.ts):
 * software business, not acquired or funded recently. Seb reads two lines,
 * pushes to Weekly Outreach or skips, and the list refills. Everything else
 * (waiting, filtered out, done, check a list, rules) lives behind one menu.
 */

type RuleStatus = "eligible" | "wait" | "blocked";
type ReviewStatus = "open" | "pushed" | "skipped";
type ScreenStatus = "pending" | "software" | "not_software" | "wrong_market" | "acquired" | "unclear" | "error";
type Send = { date: string; type: string; by: string | null };

type Row = {
  sf_account_id: string;
  account_name: string;
  website: string | null;
  account_url: string | null;
  employees: number | null;
  country: string | null;
  industry: string | null;
  owner_name: string | null;
  last_e1_at: string | null;
  last_e1_by: string | null;
  sends: Send[];
  rule_status: RuleStatus;
  rule_reason: string;
  eligible_on: string | null;
  sends_in_window: number;
  screen_status: ScreenStatus;
  screen_reason: string | null;
  screen_facts: { summary?: string | null; ownership?: string | null; investment?: string | null; softwareType?: string | null; linkedin?: string | null; linkedinChecked?: boolean; group?: { group: string | null; mainGroup: string | null } | null } | null;
  review_status: ReviewStatus;
  skip_reason: string | null;
  reviewed_at: string | null;
  pushed_week_start: string | null;
  refreshed_at: string;
};

type Settings = {
  windowDays: number;
  maxSendsInWindow: number;
  inFlightDays: number;
  lookbackMonths: number;
  minEmployees: number;
  maxEmployees: number;
  countries: string[];
  excludedUsers: string[];
  recordType: string;
  batchSize: number;
  refillBelow: number;
};

type CheckRow = {
  input: string;
  status: "matched" | "multiple" | "not_found";
  accountId: string | null;
  accountName: string | null;
  accountUrl: string | null;
  owner: string | null;
  matchCount: number;
  verdict: { status: RuleStatus; reason: string; eligibleOn: string | null; sendsInWindow: number } | null;
  lastSend: Send | null;
};

type View = "next" | "waiting" | "filtered" | "done" | "check" | "rules";

const VIEW_LABEL: Record<View, string> = {
  next: "Next to contact",
  waiting: "Waiting on the window",
  filtered: "Filtered out by the check",
  done: "Pushed and skipped",
  check: "Check a list",
  rules: "Rules",
};

const SKIP_REASONS = ["Not software", "Services-heavy", "Wrong end market", "Acquired", "Wrong size", "Wrong geography", "Rule exception", "Other"];

/** "Wrong end market: dental labs" shows as "wrong end market: dental labs" (only the reason is lowercased). */
function skipLabel(reason: string): string {
  const i = reason.indexOf(":");
  return i < 0 ? reason.toLowerCase() : reason.slice(0, i).toLowerCase() + reason.slice(i);
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "";
  return new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function hrefOf(url: string | null): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function firstName(name: string | null): string | null {
  return name ? name.split(" ")[0] : null;
}

const OWNERSHIP: Record<string, string> = {
  bootstrapped: "bootstrapped",
  pe_backed: "PE-backed",
  vc_backed: "VC-backed",
  public: "public",
  subsidiary: "subsidiary",
};

/** Line two of a row: what they sell, where, size, group, and ownership. */
function describe(row: Row): string {
  const f = row.screen_facts;
  const parts: string[] = [];
  if (f?.summary) parts.push(f.summary);
  else if (f?.softwareType) parts.push(f.softwareType);
  else if (row.industry) parts.push(row.industry);
  if (row.country) parts.push(row.country);
  if (row.employees !== null) parts.push(`${row.employees} people`);
  if (f?.group?.group) parts.push(f.group.group);
  if (!f?.summary && f?.ownership && OWNERSHIP[f.ownership]) parts.push(OWNERSHIP[f.ownership]);
  if (!f?.summary && f?.investment) parts.push(`raised ${f.investment}`);
  return parts.join(" · ");
}

export default function OutreachPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-surface" />}>
      <OutreachInner />
    </Suspense>
  );
}

function OutreachInner() {
  const params = useSearchParams();
  const [view, setView] = useState<View>(params.get("tab") === "check" ? "check" : "next");
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [skipFor, setSkipFor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [weekCount, setWeekCount] = useState<number | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shown, setShown] = useState(50);
  const [screen, setScreen] = useState<{ pending: number; running: boolean; step: string | null }>({ pending: 0, running: false, step: null });
  const readyRef = useRef(0);
  const settingsRef = useRef<Settings | null>(null);
  /** Ready rows still without a LinkedIn page and never looked up: the check job fills them in. */
  const linkedinRef = useRef(0);

  const pollScreen = useCallback(async () => {
    try {
      const res = await fetch("/api/outreach/screen");
      const data = await res.json();
      if (!res.ok) return false;
      const job = data.job as { status: string; progress?: { step?: string } | null } | null;
      setScreen({ pending: data.pending ?? 0, running: !!job, step: job?.progress?.step ?? null });
      return !!job;
    } catch {
      return false;
    }
  }, []);

  /** Check one batch at a time, and only when the checked pile runs low. Each check costs a model call, so the rest waits. */
  const ensureScreened = useCallback(
    async (batch: number, force = false) => {
      const running = await pollScreen();
      if (running) return;
      const low = settingsRef.current?.refillBelow ?? 20;
      if (!force && readyRef.current >= low && linkedinRef.current === 0) return;
      try {
        const res = await fetch("/api/outreach/screen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limit: batch }) });
        const data = await res.json();
        if (res.ok && data.jobId) setScreen((s) => ({ ...s, running: true, step: null }));
        else if (!res.ok && data.error) setError(data.error);
      } catch {
        /* next poll retries */
      }
    },
    [pollScreen],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, weekRes, setRes] = await Promise.all([fetch("/api/outreach/candidates"), fetch("/api/weekly-outreach"), fetch("/api/outreach/settings")]);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load");
      const rows = (data.items ?? []) as Row[];
      setItems(rows);
      const week = await weekRes.json().catch(() => null);
      setWeekCount(Array.isArray(week?.items) ? week.items.length : null);
      const set = await setRes.json().catch(() => null);
      if (set?.settings) {
        setSettings(set.settings);
        settingsRef.current = set.settings;
        setShown(set.settings.batchSize ?? 50);
      }
      setError(null);
      const ready = rows.filter((r) => r.review_status === "open" && r.rule_status === "eligible" && r.screen_status === "software");
      readyRef.current = ready.length;
      linkedinRef.current = ready.filter((r) => !r.screen_facts?.linkedin && !r.screen_facts?.linkedinChecked).length;
      void ensureScreened(set?.settings?.batchSize ?? 50);
    } catch (err) {
      setError(err instanceof Error && !/load failed|failed to fetch/i.test(err.message) ? err.message : "The connection dropped while loading. Reopen the page.");
    } finally {
      setLoading(false);
    }
  }, [ensureScreened]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!screen.running) return;
    const id = window.setInterval(async () => {
      const running = await pollScreen();
      try {
        const res = await fetch("/api/outreach/candidates");
        const data = await res.json();
        if (res.ok) setItems(data.items ?? []);
      } catch {
        /* keep polling */
      }
      if (!running) void ensureScreened(settings?.batchSize ?? 50);
    }, 12000);
    return () => window.clearInterval(id);
  }, [screen.running, pollScreen, ensureScreened, settings?.batchSize]);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    setNotice(null);
    setMenuOpen(false);
    try {
      const res = await fetch("/api/outreach/candidates", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Refresh failed");
      await load();
      const s = data.summary;
      setNotice(`Pool rebuilt from Salesforce: ${s.inPool} accounts, ${s.eligible} eligible, ${s.waiting} waiting, ${s.blocked} blocked.`);
    } catch (err) {
      setError(err instanceof Error && !/load failed|failed to fetch/i.test(err.message) ? err.message : "The connection dropped before Salesforce answered. Try again.");
    } finally {
      setRefreshing(false);
    }
  }

  function replaceRow(row: Row) {
    setItems((prev) => prev.map((r) => (r.sf_account_id === row.sf_account_id ? row : r)));
  }

  async function act(row: Row, action: "push" | "skip" | "reopen", reason?: string) {
    setBusy((prev) => new Set(prev).add(row.sf_account_id));
    setError(null);
    try {
      const res = await fetch("/api/outreach/candidates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: row.sf_account_id, action, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      replaceRow(data.item);
      if (action === "push") {
        setWeekCount((n) => (n === null ? null : n + 1));
        setNotice(`${row.account_name} added to Weekly Outreach${data.ownerChanged ? ", account owner set to you in Salesforce" : ""}.`);
      }
      if (action === "reopen") setWeekCount(null);
      setSkipFor(null);
      if (action !== "reopen") void ensureScreened(settings?.batchSize ?? 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(row.sf_account_id);
        return next;
      });
    }
  }

  const open = useMemo(() => items.filter((r) => r.review_status === "open"), [items]);
  const eligibleAll = useMemo(() => open.filter((r) => r.rule_status === "eligible"), [open]);
  const next = useMemo(() => {
    const rank = (r: Row) => (r.screen_status === "software" ? 0 : 1);
    return eligibleAll
      .filter((r) => r.screen_status === "software" || r.screen_status === "unclear")
      .sort((a, b) => rank(a) - rank(b) || ((a.last_e1_at ?? "") < (b.last_e1_at ?? "") ? -1 : 1));
  }, [eligibleAll]);
  const unchecked = useMemo(() => eligibleAll.filter((r) => r.screen_status === "pending" || r.screen_status === "error").length, [eligibleAll]);
  const waiting = useMemo(() => open.filter((r) => r.rule_status !== "eligible").sort((a, b) => ((a.eligible_on ?? "9999") < (b.eligible_on ?? "9999") ? -1 : 1)), [open]);
  const filtered = useMemo(() => eligibleAll.filter((r) => r.screen_status === "not_software" || r.screen_status === "wrong_market" || r.screen_status === "acquired"), [eligibleAll]);
  const done = useMemo(() => items.filter((r) => r.review_status !== "open").sort((a, b) => ((a.reviewed_at ?? "") < (b.reviewed_at ?? "") ? 1 : -1)), [items]);
  readyRef.current = next.filter((r) => r.screen_status === "software").length;
  linkedinRef.current = next.filter((r) => r.screen_status === "software" && !r.screen_facts?.linkedin && !r.screen_facts?.linkedinChecked).length;

  const batch = settings?.batchSize ?? 50;
  const list = view === "next" ? next.slice(0, shown) : view === "waiting" ? waiting : view === "filtered" ? filtered : view === "done" ? done : [];

  const statusLine = [
    `${next.length} ready`,
    unchecked > 0 ? `${unchecked} being checked` : null,
    `${waiting.length} waiting on the ${settings?.windowDays ?? 60}-day window`,
    weekCount !== null ? `${weekCount} in Weekly Outreach this week` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <PageContent>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-normal tracking-tight text-ink">{VIEW_LABEL[view]}</h1>
          <p className="mt-1 text-sm text-ink-secondary">{statusLine}</p>
        </div>
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="More views"
            className="flex h-9 w-9 items-center justify-center rounded-sm border border-line-strong bg-white text-ink-secondary hover:bg-surface-3"
          >
            <MoreHorizontal size={18} strokeWidth={1.5} />
          </button>
          {menuOpen ? (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden />
              <div className="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-md border border-line bg-white shadow-xl">
                {(["next", "waiting", "filtered", "done", "check", "rules"] as View[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setView(key);
                      setMenuOpen(false);
                    }}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-3 ${view === key ? "bg-surface-3 text-ink" : "text-ink-secondary"}`}
                  >
                    <span>{VIEW_LABEL[key]}</span>
                    <span className="text-xs text-ink-muted tabular-nums">
                      {key === "next" ? next.length : key === "waiting" ? waiting.length : key === "filtered" ? filtered.length : key === "done" ? done.length : ""}
                    </span>
                  </button>
                ))}
                <div className="border-t border-line" />
                <button type="button" disabled={refreshing} onClick={() => void refresh()} className="w-full px-3 py-2 text-left text-sm text-ink-secondary hover:bg-surface-3 disabled:text-ink-muted">
                  {refreshing ? "Rebuilding the pool…" : "Rebuild the pool from Salesforce"}
                </button>
                {unchecked > 0 ? (
                  <button type="button" onClick={() => { setMenuOpen(false); void ensureScreened(batch, true); }} className="w-full px-3 py-2 text-left text-sm text-ink-secondary hover:bg-surface-3">
                    Check the next {Math.min(unchecked, batch)} now
                  </button>
                ) : null}
                <Link href="/outreach/legacy" className="block px-3 py-2 text-sm text-ink-muted no-underline hover:bg-surface-3">Legacy queue (Outreach.io push)</Link>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {error ? <p className="mb-4 rounded-sm border border-danger bg-white px-3 py-2 text-sm text-ink">{error}</p> : null}
      {notice ? <p className="mb-4 text-sm text-ink-secondary">{notice}</p> : null}

      {view === "rules" && settings ? (
        <RulesPanel settings={settings} onSaved={(s) => { setSettings(s); settingsRef.current = s; setShown(s.batchSize); setNotice("Rules saved. Rebuild the pool to apply them."); setView("next"); }} />
      ) : view === "check" ? (
        <CheckList onPushed={() => setWeekCount((n) => (n === null ? null : n + 1))} />
      ) : loading ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-ink-secondary">Nothing here yet. Rebuild the pool from Salesforce from the menu.</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-ink-secondary">
          {view === "next"
            ? unchecked > 0
              ? `Nothing checked yet. ${unchecked} accounts are in the check queue; rows appear here as they pass.`
              : "Nothing to contact right now."
            : "Nothing here."}
        </p>
      ) : (
        <div className="rounded-md border border-line bg-white">
          {list.map((row) => (
            <CandidateRow
              key={row.sf_account_id}
              row={row}
              view={view}
              busy={busy.has(row.sf_account_id)}
              skipOpen={skipFor === row.sf_account_id}
              expanded={expanded.has(row.sf_account_id)}
              onToggle={() =>
                setExpanded((prev) => {
                  const n = new Set(prev);
                  if (n.has(row.sf_account_id)) n.delete(row.sf_account_id);
                  else n.add(row.sf_account_id);
                  return n;
                })
              }
              onSkipToggle={() => setSkipFor((v) => (v === row.sf_account_id ? null : row.sf_account_id))}
              onPush={() => void act(row, "push")}
              onSkip={(reason) => void act(row, "skip", reason)}
              onReopen={() => void act(row, "reopen")}
            />
          ))}
        </div>
      )}

      {view === "next" && next.length > shown ? (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={() => setShown((n) => n + batch)}>
            Show {Math.min(batch, next.length - shown)} more
          </Button>
        </div>
      ) : null}
      {view === "next" && screen.running ? (
        <p className="mt-4 text-xs text-ink-muted">Checking websites{screen.step ? `, ${screen.step.toLowerCase()}` : ""}…</p>
      ) : null}
    </PageContent>
  );
}

function CandidateRow({
  row,
  view,
  busy,
  skipOpen,
  expanded,
  onToggle,
  onSkipToggle,
  onPush,
  onSkip,
  onReopen,
}: {
  row: Row;
  view: View;
  busy: boolean;
  skipOpen: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSkipToggle: () => void;
  onPush: () => void;
  onSkip: (reason: string) => void;
  onReopen: () => void;
}) {
  const isOpen = row.review_status === "open";
  const site = hrefOf(row.website);
  const lastContact = row.last_e1_at ? `Last contacted ${fmtDate(row.last_e1_at)}${row.last_e1_by ? ` by ${firstName(row.last_e1_by)}` : ""}` : "Never contacted";
  const lineTwo = describe(row);
  // Line three carries the state the row is in when it is not simply "next".
  const lineThree =
    view === "waiting"
      ? row.rule_reason
      : view === "filtered"
        ? row.screen_reason ?? ""
        : view === "done"
          ? row.review_status === "pushed"
            ? `Pushed to Weekly Outreach, week of ${fmtDate(row.pushed_week_start)}`
            : `Skipped${row.skip_reason ? `, ${skipLabel(row.skip_reason)}` : ""}`
          : row.screen_status === "unclear"
            ? `Check was unclear: ${row.screen_reason ?? ""}`
            : null;
  const pushLabel = view === "next" ? "Push" : "Push anyway";
  const stop = (e: MouseEvent) => e.stopPropagation();
  // A few words with the skip ("dental labs", "consumer app"): saved with the reason and fed back into the check.
  const [note, setNote] = useState("");
  const skipWith = (reason: string) => onSkip(note.trim() ? `${reason}: ${note.trim()}` : reason);

  return (
    <div className="border-b border-line last:border-b-0">
      <div className="flex items-start gap-3 px-4 py-3 hover:bg-surface-3 sm:items-center">
        {/* The whole text block opens and closes the details; links inside keep their own click. */}
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={onToggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggle();
            }
          }}
          className="min-w-0 flex-1 cursor-pointer select-none"
        >
          <div className="flex flex-wrap items-baseline gap-x-2">
            {row.account_url ? (
              <a href={row.account_url} target="_blank" rel="noreferrer" onClick={stop} className="text-[15px] font-medium text-ink no-underline hover:underline">
                {row.account_name}
              </a>
            ) : (
              <span className="text-[15px] font-medium text-ink">{row.account_name}</span>
            )}
            {site ? (
              <a href={site} target="_blank" rel="noreferrer" onClick={stop} className="text-[13px] text-info no-underline hover:underline">
                {hostOf(row.website)}
              </a>
            ) : null}
            <a
              href={row.screen_facts?.linkedin ?? `https://www.google.com/search?q=${encodeURIComponent(`${row.account_name} ${hostOf(row.website) ?? ""} linkedin`.trim())}`}
              target="_blank"
              rel="noreferrer"
              onClick={stop}
              className="text-[13px] text-info no-underline hover:underline"
              title={row.screen_facts?.linkedin ? "LinkedIn company page" : "Google the company's LinkedIn page"}
            >
              {row.screen_facts?.linkedin ? "LinkedIn" : "Find on LinkedIn"}
            </a>
          </div>
          {lineTwo ? <p className="truncate text-[13px] text-ink-secondary">{lineTwo}</p> : null}
          <p className="flex items-center gap-1 text-[13px] text-ink-secondary">
            <span className="truncate">{lastContact}</span>
            <ChevronDown size={14} strokeWidth={1.5} className={`shrink-0 text-ink-muted transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
          </p>
          {lineThree ? <p className="mt-0.5 text-[13px] text-ink-muted">{lineThree}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isOpen ? (
            <>
              <Button size="sm" loading={busy} onClick={onPush}>
                {pushLabel}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={onSkipToggle}>
                Skip
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" loading={busy} onClick={onReopen}>
              Put back
            </Button>
          )}
        </div>
      </div>
      {skipOpen && isOpen ? (
        <div className="border-t border-line bg-surface-3 px-4 py-2">
          <div className="flex flex-wrap gap-1.5">
            {SKIP_REASONS.map((reason) => (
              <button key={reason} type="button" disabled={busy} onClick={() => skipWith(reason)} className="rounded-sm border border-line bg-white px-2 py-1 text-[13px] text-ink hover:bg-surface-3">
                {reason}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onClick={stop}
            maxLength={120}
            placeholder="Optional: a few words on why (e.g. dental labs, consumer app). The check learns from these."
            className="mt-2 w-full rounded-sm border border-line bg-white px-2 py-1 text-[13px] text-ink placeholder:text-ink-muted focus:border-ink focus:outline-none focus:ring-2 focus:ring-surface-4"
          />
        </div>
      ) : null}
      {expanded ? (
        <div className="border-t border-line bg-surface-3 px-4 py-3 text-[13px] text-ink-secondary">
          <p><span className="text-ink">Rule:</span> {row.rule_reason}</p>
          {row.screen_reason ? <p className="mt-1"><span className="text-ink">Check:</span> {row.screen_reason}</p> : null}
          {row.screen_facts?.investment ? <p className="mt-1"><span className="text-ink">Investment:</span> {row.screen_facts.investment}</p> : null}
          {row.sends.length > 0 ? (
            <p className="mt-1"><span className="text-ink">Sends:</span> {row.sends.map((s) => `${s.type} ${fmtDate(s.date)}${s.by ? ` (${firstName(s.by)})` : ""}`).join(" · ")}</p>
          ) : null}
          {row.owner_name ? <p className="mt-1"><span className="text-ink">Salesforce owner:</span> {row.owner_name}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function RulesPanel({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const [form, setForm] = useState({ ...settings, countriesText: settings.countries.join(", "), excludedText: settings.excludedUsers.join(", ") });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const num = (key: keyof Settings) => (e: ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: Number(e.target.value) }));
  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const body = { ...form, countries: form.countriesText.split(",").map((s) => s.trim()).filter(Boolean), excludedUsers: form.excludedText.split(",").map((s) => s.trim()).filter(Boolean) };
      const res = await fetch("/api/outreach/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      onSaved(data.settings);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }
  const field = "mt-1 h-10 w-full rounded-sm border border-line-strong bg-white px-3 text-sm text-ink focus:border-ink focus:outline-none focus:ring-2 focus:ring-surface-4";
  const label = "block text-[13px] text-ink-secondary";
  return (
    <div className="max-w-2xl rounded-md border border-line bg-white p-5">
      <p className="mb-4 text-sm text-ink-secondary">Sends from every user count against the window. Sequence starts counted: E1, RCE1, D-E1, D-RCE1, IB-E1, IB-RCE, Fund-E1, Fund-RCE1, LI.</p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <label className={label}>Window (days)<input type="number" className={field} value={form.windowDays} onChange={num("windowDays")} /></label>
        <label className={label}>Max sends in window<input type="number" className={field} value={form.maxSendsInWindow} onChange={num("maxSendsInWindow")} /></label>
        <label className={label}>Sequence in flight (days)<input type="number" className={field} value={form.inFlightDays} onChange={num("inFlightDays")} /></label>
        <label className={label}>Rows checked per batch<input type="number" className={field} value={form.batchSize} onChange={num("batchSize")} /></label>
        <label className={label}>Check more when ready drops below<input type="number" className={field} value={form.refillBelow} onChange={num("refillBelow")} /></label>
        <label className={label}>E1 lookback (months)<input type="number" className={field} value={form.lookbackMonths} onChange={num("lookbackMonths")} /></label>
        <label className={label}>Account record type<input type="text" className={field} value={form.recordType} onChange={(e) => setForm((f) => ({ ...f, recordType: e.target.value }))} /></label>
        <label className={label}>Min employees<input type="number" className={field} value={form.minEmployees} onChange={num("minEmployees")} /></label>
        <label className={label}>Max employees<input type="number" className={field} value={form.maxEmployees} onChange={num("maxEmployees")} /></label>
        <label className={`${label} col-span-2 sm:col-span-3`}>Countries<input type="text" className={field} value={form.countriesText} onChange={(e) => setForm((f) => ({ ...f, countriesText: e.target.value }))} /></label>
        <label className={`${label} col-span-2 sm:col-span-3`}>Users whose E1s do not create candidates<input type="text" className={field} value={form.excludedText} onChange={(e) => setForm((f) => ({ ...f, excludedText: e.target.value }))} /></label>
      </div>
      {err ? <p className="mt-3 text-sm text-danger">{err}</p> : null}
      <div className="mt-5 flex justify-end">
        <Button loading={saving} onClick={() => void save()}>Save</Button>
      </div>
    </div>
  );
}

function CheckList({ onPushed }: { onPushed: () => void }) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<CheckRow[]>([]);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [pushed, setPushed] = useState<Set<string>>(new Set());

  async function check() {
    const names = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) return;
    setChecking(true);
    setErr(null);
    try {
      const res = await fetch("/api/outreach/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ names }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Check failed");
      setRows(data.rows ?? []);
      setPushed(new Set());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Check failed");
    } finally {
      setChecking(false);
    }
  }

  async function push(row: CheckRow) {
    if (!row.accountId) return;
    const id = row.accountId;
    setBusy((p) => new Set(p).add(id));
    try {
      const res = await fetch("/api/weekly-outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outreachType: "E1", accountId: id, source: "outreach", sourceReference: `Check a list: ${row.input}` }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not push");
      setPushed((p) => new Set(p).add(id));
      onPushed();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not push");
    } finally {
      setBusy((p) => {
        const n = new Set(p);
        n.delete(id);
        return n;
      });
    }
  }

  return (
    <div className="max-w-2xl">
      <label className="block text-[13px] text-ink-secondary" htmlFor="check-names">Company names, one per line</label>
      <textarea
        id="check-names"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        className="mt-1 w-full rounded-sm border border-line-strong bg-white p-3 text-sm text-ink focus:border-ink focus:outline-none focus:ring-2 focus:ring-surface-4"
      />
      <div className="mt-3 flex justify-end">
        <Button loading={checking} onClick={() => void check()}>Check</Button>
      </div>
      {err ? <p className="mt-3 text-sm text-danger">{err}</p> : null}
      {rows.length > 0 ? (
        <div className="mt-5 rounded-md border border-line bg-white">
          {rows.map((row) => {
            const v = row.verdict;
            const state = row.status === "not_found" ? "No Salesforce match" : !v ? "" : v.status === "eligible" ? "Eligible" : v.status === "wait" ? `Wait until ${fmtDate(v.eligibleOn)}` : "Blocked";
            const isPushed = !!row.accountId && pushed.has(row.accountId);
            return (
              <div key={row.input} className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0 sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    {row.accountUrl ? (
                      <a href={row.accountUrl} target="_blank" rel="noreferrer" className="text-[15px] font-medium text-ink no-underline hover:underline">{row.accountName ?? row.input}</a>
                    ) : (
                      <span className="text-[15px] font-medium text-ink">{row.accountName ?? row.input}</span>
                    )}
                    {row.status === "multiple" ? <span className="text-[13px] text-warn">{row.matchCount} matches, verify</span> : null}
                    {row.accountName && row.accountName !== row.input ? <span className="text-[13px] text-ink-muted">pasted as “{row.input}”</span> : null}
                  </div>
                  <p className="text-[13px] text-ink-secondary">{[state, v?.reason].filter(Boolean).join(" · ")}</p>
                </div>
                {row.accountId ? (
                  isPushed ? (
                    <span className="text-[13px] text-ok">Pushed</span>
                  ) : (
                    <Button size="sm" variant={v?.status === "eligible" ? "primary" : "secondary"} loading={busy.has(row.accountId)} onClick={() => void push(row)}>
                      {v?.status === "eligible" ? "Push" : "Push anyway"}
                    </Button>
                  )
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
