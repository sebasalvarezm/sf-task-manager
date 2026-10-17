"use client";

import { Suspense, useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ExternalLink, RefreshCw, Settings2, Send, SkipForward, RotateCcw, ClipboardList } from "lucide-react";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";
import { Button } from "@/app/components/ui/Button";
import { Alert } from "@/app/components/ui/Alert";
import { Badge } from "@/app/components/ui/Badge";

/**
 * Outreach: the review screen for the next accounts to email.
 *
 * The pool is the "GOGOGO" report (E1s in the last year, Valstone record
 * type, headcount band, core countries). Every account carries the
 * rules-of-engagement verdict (lib/outreach-rules.ts). Seb reviews the
 * eligible ones in batches, pushes to Weekly Outreach with one tap or skips
 * with a reason, and the pool refills from the top. "Check a list" is the old
 * Re-Contact paste box, now on the same rule.
 */

type RuleStatus = "eligible" | "wait" | "blocked";
type ReviewStatus = "open" | "pushed" | "skipped";
type ScreenStatus = "pending" | "software" | "not_software" | "acquired" | "unclear" | "error";
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

type Tab = "review" | "waiting" | "done" | "check";

const SKIP_REASONS = ["Not software", "Services-heavy", "Acquired", "Too small or too big", "Wrong geography", "Rule exception", "Other"];

const SCREEN_LABEL: Record<ScreenStatus, { label: string; variant: "neutral" | "ok" | "warn" | "danger" | "info" }> = {
  pending: { label: "Not checked yet", variant: "neutral" },
  software: { label: "Software", variant: "ok" },
  not_software: { label: "Not software", variant: "danger" },
  acquired: { label: "Acquired", variant: "danger" },
  unclear: { label: "Unclear", variant: "warn" },
  error: { label: "Check failed", variant: "warn" },
};

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
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

export default function OutreachPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-navy" />}>
      <OutreachInner />
    </Suspense>
  );
}

function OutreachInner() {
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.get("tab") === "check" ? "check" : "review");
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [skipFor, setSkipFor] = useState<string | null>(null);
  const [weekCount, setWeekCount] = useState<number | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shown, setShown] = useState(50);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, weekRes, setRes] = await Promise.all([fetch("/api/outreach/candidates"), fetch("/api/weekly-outreach"), fetch("/api/outreach/settings")]);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load");
      setItems(data.items ?? []);
      const week = await weekRes.json().catch(() => null);
      setWeekCount(Array.isArray(week?.items) ? week.items.length : null);
      const set = await setRes.json().catch(() => null);
      if (set?.settings) {
        setSettings(set.settings);
        setShown(set.settings.batchSize ?? 50);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/outreach/candidates", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Refresh failed");
      setItems(data.items ?? []);
      const s = data.summary;
      setMessage(`Refreshed: ${s.inPool} accounts in the pool, ${s.eligible} eligible now, ${s.waiting} waiting, ${s.blocked} blocked${s.droppedFromPool ? `, ${s.droppedFromPool} left the pool` : ""}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
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
        setMessage(`${row.account_name} added to Weekly Outreach (week of ${fmtDate(data.weekly?.week_start)}).`);
      }
      if (action === "reopen") setWeekCount(null);
      setSkipFor(null);
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

  const eligible = useMemo(() => items.filter((r) => r.review_status === "open" && r.rule_status === "eligible"), [items]);
  const waiting = useMemo(
    () => items.filter((r) => r.review_status === "open" && r.rule_status !== "eligible").sort((a, b) => (a.eligible_on ?? "9999") < (b.eligible_on ?? "9999") ? -1 : 1),
    [items],
  );
  const done = useMemo(() => items.filter((r) => r.review_status !== "open").sort((a, b) => ((a.reviewed_at ?? "") < (b.reviewed_at ?? "") ? 1 : -1)), [items]);
  const pushedThisWeek = useMemo(() => {
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    return items.filter((r) => r.review_status === "pushed" && (r.pushed_week_start ?? "") >= key).length;
  }, [items]);
  const lastRefresh = items[0]?.refreshed_at ?? null;

  return (
    <>
      <PageHeader
        title="Outreach"
        subtitle="Accounts from the E1 report that pass the rules of engagement. Push the good ones to Weekly Outreach, skip the rest."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" leftIcon={<Settings2 size={14} />} onClick={() => setSettingsOpen((v) => !v)}>
              Rules
            </Button>
            <Button size="sm" leftIcon={<RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />} loading={refreshing} onClick={() => void refresh()}>
              Refresh from Salesforce
            </Button>
          </div>
        }
      />
      <PageContent>
        {error ? <Alert variant="danger" className="mb-4">{error}</Alert> : null}
        {message ? <Alert variant="info" className="mb-4">{message}</Alert> : null}

        {settingsOpen && settings ? <SettingsPanel settings={settings} onSaved={(s) => { setSettings(s); setShown(s.batchSize); setSettingsOpen(false); setMessage("Rules saved. Refresh from Salesforce to apply them."); }} /> : null}

        <div className="mb-4 grid grid-cols-3 gap-2 sm:gap-3">
          <Stat label="Ready to review" value={eligible.length} />
          <Stat label="Waiting" value={waiting.length} />
          <Stat label="In Weekly Outreach" value={weekCount ?? pushedThisWeek} hint="this week · target 70" />
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {(
            [
              ["review", `Review (${eligible.length})`],
              ["waiting", `Waiting (${waiting.length})`],
              ["done", `Done (${done.length})`],
              ["check", "Check a list"],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${tab === key ? "bg-navy text-white" : "bg-surface-3 text-ink hover:bg-line"}`}
            >
              {label}
            </button>
          ))}
          {lastRefresh ? <span className="w-full text-xs text-ink-muted sm:ml-auto sm:w-auto">Pool refreshed {new Date(lastRefresh).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span> : null}
        </div>

        {tab === "check" ? (
          <CheckList onPushed={() => setWeekCount((n) => (n === null ? null : n + 1))} />
        ) : loading ? (
          <p className="text-sm text-ink-muted">Loading…</p>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line bg-white p-10 text-center text-sm text-ink-muted">
            Nothing here yet. Click Refresh from Salesforce to build the pool from the E1 report.
          </div>
        ) : (
          <div className="space-y-3">
            {(tab === "review" ? eligible.slice(0, shown) : tab === "waiting" ? waiting : done).map((row) => (
              <CandidateCard
                key={row.sf_account_id}
                row={row}
                busy={busy.has(row.sf_account_id)}
                skipOpen={skipFor === row.sf_account_id}
                onSkipToggle={() => setSkipFor((v) => (v === row.sf_account_id ? null : row.sf_account_id))}
                onPush={() => void act(row, "push")}
                onSkip={(reason) => void act(row, "skip", reason)}
                onReopen={() => void act(row, "reopen")}
              />
            ))}
            {tab === "review" && eligible.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-line bg-white p-10 text-center text-sm text-ink-muted">
                Nothing eligible right now. {waiting.length > 0 ? `${waiting.length} account${waiting.length === 1 ? " is" : "s are"} waiting on the 60-day window.` : ""}
              </div>
            ) : null}
            {tab === "review" && eligible.length > shown ? (
              <div className="flex justify-center pt-2">
                <Button variant="secondary" onClick={() => setShown((n) => n + (settings?.batchSize ?? 50))}>
                  Show next {Math.min(settings?.batchSize ?? 50, eligible.length - shown)} of {eligible.length - shown} more
                </Button>
              </div>
            ) : null}
          </div>
        )}
        <p className="mt-8 text-center text-xs text-ink-muted">
          Need the old queue with the direct Outreach.io push? <Link href="/outreach/legacy" className="text-brand hover:underline">Open the legacy view</Link>.
        </p>
      </PageContent>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-white px-3 py-3 text-center sm:px-4">
      <div className="text-[11px] leading-tight text-ink-muted sm:text-xs">{label}</div>
      <div className="text-2xl font-semibold text-ink">{value}</div>
      {hint ? <div className="text-[11px] text-ink-muted">{hint}</div> : null}
    </div>
  );
}

function CandidateCard({
  row,
  busy,
  skipOpen,
  onSkipToggle,
  onPush,
  onSkip,
  onReopen,
}: {
  row: Row;
  busy: boolean;
  skipOpen: boolean;
  onSkipToggle: () => void;
  onPush: () => void;
  onSkip: (reason: string) => void;
  onReopen: () => void;
}) {
  const screen = SCREEN_LABEL[row.screen_status] ?? SCREEN_LABEL.pending;
  const ruleVariant = row.rule_status === "eligible" ? "ok" : row.rule_status === "wait" ? "warn" : "danger";
  const isOpen = row.review_status === "open";
  const site = hrefOf(row.website);
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-line bg-white p-3 shadow-sm sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-base font-semibold text-ink">{row.account_name}</span>
        {row.employees !== null ? <Badge variant="neutral" size="sm">{row.employees} employees</Badge> : null}
        {row.country ? <Badge variant="neutral" size="sm">{row.country}</Badge> : null}
        <Badge variant={screen.variant} size="sm">{screen.label}</Badge>
        {row.review_status === "pushed" ? <Badge variant="ok" size="sm">Pushed · week of {fmtDate(row.pushed_week_start)}</Badge> : null}
        {row.review_status === "skipped" ? <Badge variant="neutral" size="sm">Skipped{row.skip_reason ? ` · ${row.skip_reason}` : ""}</Badge> : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
        {site ? (
          <a href={site} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
            {hostOf(row.website)} <ExternalLink size={11} />
          </a>
        ) : null}
        {row.account_url ? (
          <a href={row.account_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
            Salesforce <ExternalLink size={11} />
          </a>
        ) : null}
        {row.industry ? <span>{row.industry}</span> : null}
        {row.owner_name ? <span>Owner: {row.owner_name}</span> : null}
      </div>
      <div className="mt-2 flex flex-wrap items-start gap-2 text-sm">
        <Badge variant={ruleVariant} size="sm" dot>
          {row.rule_status === "eligible" ? "Eligible" : row.rule_status === "wait" ? `Wait until ${fmtDate(row.eligible_on)}` : "Blocked"}
        </Badge>
        <span className="min-w-0 break-words text-ink">{row.rule_reason}</span>
      </div>
      {row.sends.length > 0 ? (
        <div className="mt-1.5 break-words text-xs text-ink-muted">
          Sends: {row.sends.slice(0, 5).map((s) => `${s.type} ${fmtDate(s.date)}${s.by ? ` (${s.by.split(" ")[0]})` : ""}`).join(" · ")}
          {row.sends.length > 5 ? ` · +${row.sends.length - 5} more` : ""}
        </div>
      ) : null}
      {row.screen_reason ? <p className="mt-1.5 text-xs text-ink-muted">{row.screen_reason}</p> : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isOpen ? (
          <>
            <Button size="sm" leftIcon={<Send size={14} />} loading={busy} onClick={onPush} className="flex-1 sm:flex-none">
              {row.rule_status === "eligible" ? "Push to Weekly Outreach" : "Push anyway"}
            </Button>
            <Button size="sm" variant="secondary" leftIcon={<SkipForward size={14} />} disabled={busy} onClick={onSkipToggle} className="flex-1 sm:flex-none">
              Skip
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" leftIcon={<RotateCcw size={14} />} loading={busy} onClick={onReopen}>
            Put back in review
          </Button>
        )}
      </div>
      {skipOpen && isOpen ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SKIP_REASONS.map((reason) => (
            <button
              key={reason}
              type="button"
              disabled={busy}
              onClick={() => onSkip(reason)}
              className="rounded-full border border-line bg-surface-2 px-3 py-1 text-xs text-ink hover:bg-surface-3"
            >
              {reason}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SettingsPanel({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const [form, setForm] = useState({
    ...settings,
    countriesText: settings.countries.join(", "),
    excludedText: settings.excludedUsers.join(", "),
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const num = (key: keyof Settings) => (e: ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: Number(e.target.value) }));
  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const body = {
        ...form,
        countries: form.countriesText.split(",").map((s) => s.trim()).filter(Boolean),
        excludedUsers: form.excludedText.split(",").map((s) => s.trim()).filter(Boolean),
      };
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
  const field = "w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm text-ink";
  return (
    <div className="mb-4 rounded-xl border border-line bg-surface-2 p-4">
      <div className="mb-3 text-sm font-semibold text-ink">Rules of engagement and pool filters</div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="text-xs text-ink-muted">Window (days)<input type="number" className={field} value={form.windowDays} onChange={num("windowDays")} /></label>
        <label className="text-xs text-ink-muted">Max sends in window<input type="number" className={field} value={form.maxSendsInWindow} onChange={num("maxSendsInWindow")} /></label>
        <label className="text-xs text-ink-muted">Sequence in flight (days)<input type="number" className={field} value={form.inFlightDays} onChange={num("inFlightDays")} /></label>
        <label className="text-xs text-ink-muted">Cards per batch<input type="number" className={field} value={form.batchSize} onChange={num("batchSize")} /></label>
        <label className="text-xs text-ink-muted">E1 lookback (months)<input type="number" className={field} value={form.lookbackMonths} onChange={num("lookbackMonths")} /></label>
        <label className="text-xs text-ink-muted">Min employees<input type="number" className={field} value={form.minEmployees} onChange={num("minEmployees")} /></label>
        <label className="text-xs text-ink-muted">Max employees<input type="number" className={field} value={form.maxEmployees} onChange={num("maxEmployees")} /></label>
        <label className="text-xs text-ink-muted">Account record type<input type="text" className={field} value={form.recordType} onChange={(e) => setForm((f) => ({ ...f, recordType: e.target.value }))} /></label>
        <label className="col-span-2 text-xs text-ink-muted">Countries (comma separated)<input type="text" className={field} value={form.countriesText} onChange={(e) => setForm((f) => ({ ...f, countriesText: e.target.value }))} /></label>
        <label className="col-span-2 text-xs text-ink-muted">Users whose E1s do not create candidates<input type="text" className={field} value={form.excludedText} onChange={(e) => setForm((f) => ({ ...f, excludedText: e.target.value }))} /></label>
      </div>
      <p className="mt-2 text-xs text-ink-muted">Sends from every user still count against the window. Sequence starts counted: E1, RCE1, D-E1, D-RCE1, IB-E1, IB-RCE, Fund-E1, Fund-RCE1, LI.</p>
      {err ? <Alert variant="danger" className="mt-3">{err}</Alert> : null}
      <div className="mt-3 flex justify-end">
        <Button size="sm" loading={saving} onClick={() => void save()}>Save rules</Button>
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
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Check failed");
    } finally {
      setChecking(false);
    }
  }

  async function push(row: CheckRow) {
    if (!row.accountId) return;
    setBusy((p) => new Set(p).add(row.accountId!));
    try {
      const res = await fetch("/api/weekly-outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outreachType: "E1", accountId: row.accountId, source: "outreach", sourceReference: `Check a list: ${row.input}` }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not push");
      setRows((prev) => prev.map((r) => (r.accountId === row.accountId ? { ...r, input: `${r.input} ✓` } : r)));
      onPushed();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not push");
    } finally {
      setBusy((p) => {
        const n = new Set(p);
        n.delete(row.accountId!);
        return n;
      });
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-white p-3 sm:p-4">
        <label className="text-sm font-medium text-ink" htmlFor="check-names">Company names, one per line</label>
        <textarea
          id="check-names"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder={"Acme Software\nGlaass\nPestBoss"}
          className="mt-2 w-full rounded-lg border border-line bg-white p-2 text-sm text-ink"
        />
        <div className="mt-2 flex justify-end">
          <Button size="sm" leftIcon={<ClipboardList size={14} />} loading={checking} onClick={() => void check()}>Check against the rules</Button>
        </div>
      </div>
      {err ? <Alert variant="danger">{err}</Alert> : null}
      {rows.map((row) => {
        const v = row.verdict;
        const variant = !v ? "neutral" : v.status === "eligible" ? "ok" : v.status === "wait" ? "warn" : "danger";
        return (
          <div key={row.input} className="min-w-0 overflow-hidden rounded-xl border border-line bg-white p-3 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-ink">{row.accountName ?? row.input}</span>
              {row.status === "not_found" ? <Badge variant="danger" size="sm">No Salesforce match</Badge> : null}
              {row.status === "multiple" ? <Badge variant="warn" size="sm">{row.matchCount} matches, verify</Badge> : null}
              {v ? <Badge variant={variant} size="sm" dot>{v.status === "eligible" ? "Eligible" : v.status === "wait" ? `Wait until ${fmtDate(v.eligibleOn)}` : "Blocked"}</Badge> : null}
              {row.accountUrl ? (
                <a href={row.accountUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
                  Salesforce <ExternalLink size={11} />
                </a>
              ) : null}
            </div>
            {row.accountName && row.accountName !== row.input ? <div className="text-xs text-ink-muted">Pasted as “{row.input}”</div> : null}
            {v ? <p className="mt-1 text-sm text-ink">{v.reason}</p> : null}
            {row.accountId ? (
              <div className="mt-2">
                <Button size="sm" variant={v?.status === "eligible" ? "primary" : "secondary"} leftIcon={<Send size={14} />} loading={busy.has(row.accountId)} onClick={() => void push(row)}>
                  {v?.status === "eligible" ? "Push to Weekly Outreach" : "Push anyway"}
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
