"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { PageContent } from "@/app/components/ui/PageContent";
import { Button } from "@/app/components/ui/Button";
import { STAGES, newestFirst, stageOf, statusLine, type Stage, type Tone } from "@/lib/send-queue-view";

/**
 * Send queue: this week's sourced E1s, checked before Seb looks, moved through
 * four stages on one screen: To review → Ready to send → Scheduled → Sent
 * (Rejected behind a link).
 *
 * To review: approve or reject, tap a card to edit subject, body, contact,
 * sequence or restaurant in place. Ready to send: newest first, each one
 * marked not sent; the one orange button sends them all, or send or pull back
 * one at a time. Scheduled shows each send time in the recipient's zone.
 * The send rules themselves (time windows, spacing, contact choice, flags,
 * dry run) live on the server and are unchanged by this page.
 */

type Status = "pending" | "review" | "ready" | "approved" | "scheduling" | "dry_run" | "scheduled" | "sent" | "failed" | "rejected";
type Flag = { kind: string; message: string; severity: "red" | "yellow" };
type Hook = { text: string | null; anchor: string | null; sourceUrl: string | null; sourceLabel: string | null; level: "high" | "medium" | "low" | "none"; note: string };
type Contact = { id: string; name: string; firstName: string | null; lastName: string | null; title: string | null; email: string | null; rank: number };
type Row = {
  id: string;
  sf_account_id: string;
  outreach_prospect_id: string | null;
  account_name: string;
  website: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  group_name: string | null;
  sequence_id: string | null;
  sequence_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_first_name: string | null;
  contact_title: string | null;
  contact_email: string | null;
  contact_options: Contact[];
  verify_result: string | null;
  review_flags: Flag[];
  hook: Hook | null;
  restaurant_options: Array<{ name: string; description: string }>;
  subject: string | null;
  body: string | null;
  status: Status;
  status_reason: string | null;
  scheduled_for: string | null;
  time_zone: string | null;
  outreach_mailing_id: string | null;
  approved_at: string | null;
  updated_at: string | null;
};
type Sequence = { id: string; name: string };
type Settings = { dryRun: boolean; manualSend: boolean; sequenceMap: Record<string, string>; signatureText: string; reviewWithModel: boolean };
type JobInfo = { id: string; kind: string; status: string; progress?: { step?: string; pct?: number } | null } | null;
type Tab = Stage;

const VERIFY_LABEL: Record<string, { text: string; tone: string }> = {
  valid: { text: "Email verified", tone: "text-ok" },
  accept_all: { text: "Catch-all, unproven", tone: "text-warn" },
  unknown: { text: "Could not verify", tone: "text-warn" },
  error: { text: "Verifier error", tone: "text-warn" },
  invalid: { text: "Email invalid", tone: "text-danger" },
  role: { text: "Role address", tone: "text-danger" },
  disposable: { text: "Disposable address", tone: "text-danger" },
};

const TONE: Record<Tone, string> = { neutral: "text-ink", ok: "text-ok", warn: "text-warn", danger: "text-danger" };

// Inputs are 16px on phones so iOS does not zoom in on focus; 13px from sm up.
const INPUT = "mt-1 w-full rounded-sm border border-line-strong bg-white px-3 py-2 text-base text-ink focus:border-ink focus:outline-none focus:ring-2 focus:ring-surface-4 disabled:bg-surface-3 sm:px-2 sm:py-1 sm:text-[13px]";
// Text buttons keep a 44px tap area on phones.
const TEXT_BTN = "inline-flex min-h-[44px] items-center text-info underline-offset-2 hover:underline disabled:text-ink-muted sm:min-h-0";

function place(row: Pick<Row, "city" | "state" | "country">): string {
  return [row.city, row.state].filter(Boolean).join(", ") || row.country || "";
}

function sequenceShort(name: string | null): string {
  return name ? name.replace(/^\s*\[E\]\s*-?\s*/, "") : "";
}

export default function SendQueuePage() {
  const [items, setItems] = useState<Row[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [job, setJob] = useState<JobInfo>(null);
  const [sfUrl, setSfUrl] = useState<string | null>(null);
  const [verifierConfigured, setVerifierConfigured] = useState(true);
  const [week, setWeek] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [tab, setTab] = useState<Tab | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  // Rows handed to Outreach by this page while the job runs: shown as scheduled at once.
  const [sending, setSending] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch("/api/send");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load");
      setItems(data.items ?? []);
      setSettings(data.settings ?? null);
      setSequences(data.sequences ?? []);
      setJob(data.job ?? null);
      if (!data.job) setSending(new Set());
      if (typeof data.sfInstanceUrl === "string") setSfUrl(data.sfInstanceUrl);
      setWeek(data.week ?? null);
      setVerifierConfigured(data.verifierConfigured !== false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!job) return;
    const id = window.setInterval(() => void load(true), 3000);
    return () => window.clearInterval(id);
  }, [job, load]);
  // "2 min ago" stays true without a reload.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);

  const byStage = useMemo(() => {
    const out: Record<Stage, Row[]> = { review: [], ready: [], scheduled: [], sent: [], rejected: [] };
    for (const r of items) out[stageOf(r, now, sending.has(r.id))].push(r);
    out.ready = newestFirst(out.ready);
    out.rejected = newestFirst(out.rejected);
    const at = (r: Row) => (r.scheduled_for ? new Date(r.scheduled_for).getTime() : Number.MAX_SAFE_INTEGER);
    out.scheduled = [...out.scheduled].sort((a, b) => at(a) - at(b));
    out.sent = [...out.sent].sort((a, b) => at(b) - at(a));
    return out;
  }, [items, now, sending]);
  const sendable = useMemo(() => byStage.ready.filter((r) => r.status === "approved"), [byStage]);
  const clean = useMemo(() => byStage.review.filter((r) => r.status === "ready"), [byStage]);
  const scheduleRunning = job?.kind === "e1_schedule";
  const prepareRunning = job?.kind === "e1_prepare";

  // Open on the first stage with something in it, once.
  useEffect(() => {
    if (loading || tab) return;
    setTab(byStage.review.length ? "review" : byStage.ready.length ? "ready" : byStage.scheduled.length ? "scheduled" : byStage.sent.length ? "sent" : "review");
  }, [loading, tab, byStage]);
  // Approving the last one in review moves on to what comes next.
  const prevReview = useRef<number | null>(null);
  useEffect(() => {
    const n = byStage.review.length;
    if (prevReview.current !== null && prevReview.current > 0 && n === 0 && tab === "review" && byStage.ready.length > 0) setTab("ready");
    prevReview.current = loading ? null : n;
  }, [byStage, tab, loading]);

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch("/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Request failed");
    return data;
  }
  function replace(item: Row) {
    setItems((prev) => prev.map((r) => (r.id === item.id ? item : r)));
  }
  function setRowBusy(id: string, on: boolean) {
    setBusy((b) => {
      const n = new Set(b);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }
  async function act(id: string, action: "approve" | "reject" | "unapprove" | "cancel" | "recheck" | "rehook" | "add_contact", extra: Record<string, unknown> = {}): Promise<boolean> {
    setRowBusy(id, true);
    setError(null);
    try {
      const data = await post({ action, id, ...extra });
      if (data.item) replace(data.item as Row);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      return false;
    } finally {
      setRowBusy(id, false);
    }
  }
  async function edit(id: string, patch: Record<string, unknown>) {
    try {
      const res = await fetch("/api/send", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...patch }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      if (data.item) replace(data.item as Row);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  }
  async function approveAllClean() {
    const ready = clean;
    let ok = 0;
    for (const r of ready) if (await act(r.id, "approve")) ok++;
    setNotice(`${ok} approved.`);
  }
  async function runChecks() {
    setError(null);
    try {
      const data = await post({ action: "prepare" });
      setJob({ id: String(data.jobId), kind: "e1_prepare", status: "queued" });
      setNotice(null);
      setTab("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start");
    }
  }
  /** Hand approved rows to Outreach. They show under Scheduled straight away. */
  async function send(ids: string[]) {
    if (ids.length === 0) return;
    setError(null);
    try {
      const data = await post({ action: "schedule", ids });
      setSending(new Set(ids));
      setJob({ id: String(data.jobId), kind: "e1_schedule", status: "queued" });
      setNotice(settings?.dryRun ? "Dry run is on: Outreach gets drafts with their times, nothing will send." : null);
      setTab("scheduled");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send");
    }
  }
  async function retry(row: Row) {
    if (await act(row.id, "approve")) await send([row.id]);
  }

  const counts: Record<Stage, number> = { review: byStage.review.length, ready: byStage.ready.length, scheduled: byStage.scheduled.length, sent: byStage.sent.length, rejected: byStage.rejected.length };
  const sendLabel = scheduleRunning ? "Sending to Outreach…" : `Send ${sendable.length || ""} to Outreach`.replace("  ", " ");
  const sendDisabled = sendable.length === 0 || !!job;
  const modeNote = settings?.dryRun
    ? { text: "Dry run on: Outreach gets drafts, nothing sends", tone: "text-warn" }
    : settings?.manualSend
      ? { text: "You send each E1 from Outreach", tone: "text-ink-secondary" }
      : null;
  const weekLabel = week ? `Week of ${new Date(`${week}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "";
  const list = tab ? byStage[tab] : [];
  const showBar = !showSettings && (sendable.length > 0 || scheduleRunning);

  return (
    <PageContent className={showBar ? "pb-24 md:pb-0" : ""}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-normal tracking-tight text-ink">{showSettings ? "Send settings" : "Send queue"}</h1>
          <p className="mt-1 text-[13px] text-ink-secondary">
            {loading ? "Loading…" : weekLabel}
            {modeNote && !loading ? <span className={modeNote.tone}> · {modeNote.text}</span> : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1 md:gap-2">
          {showSettings ? (
            <Button variant="ghost" className="max-md:h-11" onClick={() => setShowSettings(false)}>Back to queue</Button>
          ) : (
            <>
              <Button variant="ghost" className="hidden max-md:h-11 sm:inline-flex" disabled={!!job} onClick={() => void runChecks()}>Run checks</Button>
              <Button variant="ghost" className="max-md:h-11" onClick={() => setShowSettings(true)}>Settings</Button>
              <Button size="lg" className="hidden md:inline-flex" disabled={sendDisabled} onClick={() => void send(sendable.map((r) => r.id))}>{sendLabel}</Button>
            </>
          )}
        </div>
      </div>

      {error ? <p className="rounded-sm border border-danger bg-white px-3 py-2 text-sm text-ink">{error}</p> : null}
      {!verifierConfigured && !showSettings ? <p className="rounded-sm border border-warn bg-white px-3 py-2 text-sm text-ink">Email verification is off: add QUICKEMAILVERIFICATION_API_KEY in Vercel and redeploy.</p> : null}

      {showSettings && settings ? (
        <SettingsPanel settings={settings} sequences={sequences} groups={Array.from(new Set(items.map((r) => r.group_name).filter((g): g is string => !!g)))} onSaved={(s) => { setSettings(s); setNotice("Settings saved."); setShowSettings(false); }} />
      ) : (
        <div>
          <nav aria-label="Stages" className="sticky top-14 z-10 -mx-4 flex border-b border-line bg-surface px-4 md:static md:mx-0 md:gap-8 md:px-0">
            {STAGES.map((s) => {
              const active = tab === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => { setTab(s.key); setOpen(null); }}
                  className={`-mb-px flex min-h-[48px] flex-1 flex-col items-center justify-center border-b-2 text-[13px] transition-colors md:flex-none md:flex-row md:gap-2 md:text-sm ${active ? "border-ink text-ink" : "border-transparent text-ink-secondary hover:text-ink"}`}
                >
                  <span className="md:hidden">{s.short}</span>
                  <span className="hidden md:inline">{s.label}</span>
                  <span className="tabular-nums text-ink">{loading ? "–" : counts[s.key]}</span>
                </button>
              );
            })}
            {counts.rejected > 0 ? (
              <button type="button" onClick={() => setTab("rejected")} className={`ml-auto hidden min-h-[48px] items-center text-[13px] md:flex ${tab === "rejected" ? "text-ink" : "text-ink-muted hover:text-ink"}`}>
                Show rejected ({counts.rejected})
              </button>
            ) : null}
          </nav>

          <StageHeader
            tab={tab}
            job={job}
            sendingCount={sending.size}
            notice={notice}
            cleanCount={clean.length}
            onApproveClean={() => void approveAllClean()}
            onRunChecks={() => void runChecks()}
            listForCopy={[...byStage.scheduled, ...byStage.sent].filter((r) => r.status === "scheduled" || r.status === "sent")}
            onCopied={(n) => setNotice(`${n} rows copied (paste into Excel).`)}
            showRunChecks={!job}
          />

          {loading ? (
            <div className="mt-3 space-y-2" aria-label="Loading">
              {[0, 1, 2].map((i) => <div key={i} className="h-24 rounded-md border border-line bg-surface-4" />)}
            </div>
          ) : list.length === 0 ? (
            <p className="mt-4 text-sm text-ink-secondary">{emptyText(tab, week, counts)}</p>
          ) : (
            <div className="mt-3 space-y-2 md:space-y-0 md:divide-y md:divide-line md:rounded-md md:border md:border-line md:bg-white">
              {list.map((row) =>
                tab === "review" ? (
                  <ReviewCard
                    key={row.id}
                    row={row}
                    sequences={sequences}
                    busy={busy.has(row.id)}
                    open={open === row.id}
                    sfUrl={sfUrl}
                    onToggle={() => setOpen((v) => (v === row.id ? null : row.id))}
                    onApprove={() => { setOpen(null); void act(row.id, "approve"); }}
                    onReject={() => void act(row.id, "reject")}
                    onRecheck={() => void act(row.id, "recheck")}
                    onRehook={() => void act(row.id, "rehook")}
                    onAddContact={(contact) => void act(row.id, "add_contact", { contact })}
                    onEdit={(patch) => void edit(row.id, patch)}
                  />
                ) : (
                  <QueueCard
                    key={row.id}
                    row={row}
                    now={now}
                    sending={sending.has(row.id)}
                    manualSend={!!settings?.manualSend}
                    busy={busy.has(row.id)}
                    jobRunning={!!job}
                    sfUrl={sfUrl}
                    onSend={() => void send([row.id])}
                    onRetry={() => void retry(row)}
                    onPullBack={() => void act(row.id, "unapprove")}
                    onCancel={() => void act(row.id, "cancel")}
                  />
                ),
              )}
            </div>
          )}

          {counts.rejected > 0 && tab !== "rejected" ? (
            <button type="button" onClick={() => setTab("rejected")} className="mt-2 inline-flex min-h-[44px] items-center text-[13px] text-ink-muted md:hidden">
              Show rejected ({counts.rejected})
            </button>
          ) : null}
        </div>
      )}

      {showBar ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] md:hidden">
          <Button size="lg" className="max-md:h-12 w-full text-[15px]" disabled={sendDisabled} onClick={() => void send(sendable.map((r) => r.id))}>{sendLabel}</Button>
        </div>
      ) : null}
    </PageContent>
  );
}

function emptyText(tab: Tab | null, week: string | null, counts: Record<Stage, number>): string {
  switch (tab) {
    case "review":
      return counts.ready > 0 ? "Nothing left to review. The approved ones are under Ready to send." : `Nothing to review for the week of ${week ?? "this week"}. Sourced E1s land here on their own, or run the checks.`;
    case "ready":
      return "Nothing approved yet. Approve emails under To review and they appear here.";
    case "scheduled":
      return "Nothing scheduled. Sent emails move here with their send time.";
    case "sent":
      return "Nothing sent yet this week.";
    case "rejected":
      return "Nothing rejected.";
    default:
      return "";
  }
}

/** One quiet line under the tabs: what this stage means, or what is running. */
function StageHeader({ tab, job, sendingCount, notice, cleanCount, onApproveClean, onRunChecks, listForCopy, onCopied, showRunChecks }: {
  tab: Tab | null;
  job: JobInfo;
  sendingCount: number;
  notice: string | null;
  cleanCount: number;
  onApproveClean: () => void;
  onRunChecks: () => void;
  listForCopy: Row[];
  onCopied: (n: number) => void;
  showRunChecks: boolean;
}) {
  const running =
    job?.kind === "e1_prepare"
      ? `Checking this week's E1s${job.progress?.step ? ` · ${job.progress.step}` : "…"}`
      : job?.kind === "e1_schedule"
        ? `${sendingCount ? `Sending ${sendingCount} to Outreach` : "Sending to Outreach"}${job.progress?.step ? ` · ${job.progress.step.toLowerCase()}` : "…"}`
        : null;
  return (
    <div className="mt-3 flex min-h-[32px] flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[13px] text-ink-secondary">
      <p className="min-w-0">
        {running ?? notice ?? (tab === "ready" ? "Newest first. Nothing here has gone to Outreach yet." : tab === "scheduled" ? "Soonest first, in each recipient's time zone." : tab === "review" ? "Tap an email to edit it." : "")}
      </p>
      <div className="flex items-center gap-4">
        {tab === "review" && showRunChecks ? (
          <button type="button" onClick={onRunChecks} className="inline-flex min-h-[44px] items-center text-ink-secondary hover:text-ink sm:hidden">Run checks</button>
        ) : null}
        {tab === "review" && cleanCount > 0 ? (
          <Button variant="secondary" className="max-md:h-11 md:h-8" disabled={!!job} onClick={onApproveClean}>Approve all clean ({cleanCount})</Button>
        ) : null}
        {tab === "sent" && listForCopy.length > 0 ? (
          <button
            type="button"
            className={TEXT_BTN}
            onClick={() => {
              const lines = listForCopy.map((r) => `${r.account_name}\t${r.contact_name ?? ""}\t${r.contact_email ?? ""}\t${r.subject ?? ""}\t${r.sequence_name ?? ""}`);
              void navigator.clipboard?.writeText(["Account\tContact\tEmail\tSubject\tSequence", ...lines].join("\n"));
              onCopied(lines.length);
            }}
          >
            Copy this week&apos;s list for E2 and E3
          </button>
        ) : null}
      </div>
    </div>
  );
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1500);
    });
  };
  return { copied, copy };
}

/** Ready, Scheduled, Sent and Rejected: a simple card, the status in words, and at most two actions. */
function QueueCard({ row, now, sending, manualSend, busy, jobRunning, sfUrl, onSend, onRetry, onPullBack, onCancel }: {
  row: Row;
  now: number;
  sending: boolean;
  manualSend: boolean;
  busy: boolean;
  jobRunning: boolean;
  sfUrl: string | null;
  onSend: () => void;
  onRetry: () => void;
  onPullBack: () => void;
  onCancel: () => void;
}) {
  const line = statusLine(row, { now, sending, manualSend });
  const stage = stageOf(row, now, sending);
  const { copied, copy } = useCopy();
  const ready = stage === "ready";
  const enrolledManual = manualSend && row.status === "scheduled" && !row.scheduled_for && stage === "scheduled";
  const canCancel = (row.status === "scheduled" || row.status === "dry_run") && stage === "scheduled";
  const meta = [row.contact_name ? `${row.contact_name}${row.contact_title ? `, ${row.contact_title}` : ""}` : "No contact", sequenceShort(row.sequence_name), place(row)].filter(Boolean).join(" · ");

  return (
    <div className="rounded-md border border-line bg-white p-4 md:flex md:items-center md:gap-4 md:rounded-none md:border-0">
      <div className="min-w-0 flex-1">
        <p className="break-words text-[15px] font-medium text-ink">{row.account_name}</p>
        <p className="truncate text-[13px] text-ink-secondary">{meta}</p>
        {row.subject ? <p className="mt-0.5 truncate text-[13px] text-ink-secondary" title={row.subject}>Subject: {row.subject}</p> : null}
        <p className={`mt-1 break-words text-[13px] ${TONE[line.tone]}`}>
          {line.tone === "neutral" && row.status === "approved" && !sending ? (
            <>
              {line.text.replace(/ · not sent$/, "")} <span className="text-ink-secondary">· not sent</span>
            </>
          ) : (
            line.text
          )}
        </p>
        {enrolledManual ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-4 text-[13px]">
            {row.outreach_prospect_id ? <a href={`https://web.outreach.io/prospects/${row.outreach_prospect_id}/sequences`} target="_blank" rel="noreferrer" className={TEXT_BTN}>Open in Outreach</a> : null}
            <button type="button" onClick={() => copy(row.subject ?? "", "subject")} className={TEXT_BTN}>{copied === "subject" ? "Copied" : "Copy subject"}</button>
            <button type="button" onClick={() => copy(row.body ?? "", "body")} className={TEXT_BTN}>{copied === "body" ? "Copied" : "Copy email"}</button>
            {sfUrl ? <a href={`${sfUrl}/${row.sf_account_id}`} target="_blank" rel="noreferrer" className={TEXT_BTN}>Salesforce</a> : null}
          </div>
        ) : null}
      </div>
      {ready ? (
        <div className="mt-3 grid shrink-0 grid-cols-2 gap-2 md:mt-0 md:flex">
          <Button variant="secondary" className="max-md:h-11" loading={busy} disabled={jobRunning} title={jobRunning ? "Wait for the current batch to finish" : undefined} onClick={row.status === "failed" ? onRetry : onSend}>
            {row.status === "failed" ? "Retry" : "Send"}
          </Button>
          <Button variant="ghost" className="max-md:h-11" disabled={busy || jobRunning} onClick={onPullBack}>Pull back</Button>
        </div>
      ) : canCancel ? (
        <div className="mt-2 shrink-0 md:mt-0">
          <Button variant="ghost" className="-ml-4 max-md:h-11 md:ml-0" loading={busy} disabled={jobRunning} onClick={onCancel}>Cancel</Button>
        </div>
      ) : null}
    </div>
  );
}

const REVIEW_LABEL: Partial<Record<Status, string>> = { pending: "Checking", review: "Needs a decision", ready: "Clean, ready to approve" };
const APPROVE = "max-md:h-11 md:h-8 !bg-ok text-white hover:!bg-[#1A5B3C] disabled:!bg-ok/50";

/** To review: the same fast approve/reject, tap the card to edit in place. */
function ReviewCard({ row, sequences, busy, open, sfUrl, onToggle, onApprove, onReject, onRecheck, onRehook, onAddContact, onEdit }: {
  sfUrl: string | null;
  row: Row;
  sequences: Sequence[];
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  onApprove: () => void;
  onReject: () => void;
  onRecheck: () => void;
  onRehook: () => void;
  onAddContact: (contact: { firstName: string; lastName: string; email: string; title: string }) => void;
  onEdit: (patch: Record<string, unknown>) => void;
}) {
  const red = row.review_flags.filter((f) => f.severity === "red");
  const yellow = row.review_flags.filter((f) => f.severity === "yellow");
  const verify = row.verify_result ? VERIFY_LABEL[row.verify_result] : null;
  const editable = ["pending", "review", "ready"].includes(row.status);
  const [subject, setSubject] = useState(row.subject ?? "");
  const [body, setBody] = useState(row.body ?? "");
  const [adding, setAdding] = useState(false);
  const [newContact, setNewContact] = useState({ firstName: "", lastName: "", email: "", title: "" });
  const { copied, copy } = useCopy();
  const timer = useRef<number | null>(null);
  useEffect(() => {
    setSubject(row.subject ?? "");
    setBody(row.body ?? "");
  }, [row.id, row.subject, row.body]);
  const queueSave = (next: { subject?: string; body?: string }) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onEdit(next), 800);
  };
  const Chevron = open ? ChevronUp : ChevronDown;

  return (
    <div className="overflow-hidden rounded-md border border-line bg-white md:rounded-none md:border-0">
      <div className="p-4 md:flex md:items-start md:gap-4">
        <div
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={onToggle}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
          className="min-w-0 flex-1 cursor-pointer"
        >
          <p className="flex items-start justify-between gap-2">
            <span className="min-w-0 break-words text-[15px] font-medium text-ink">{row.account_name}</span>
            <Chevron size={18} strokeWidth={1.5} className="mt-0.5 shrink-0 text-ink-muted md:hidden" aria-hidden />
          </p>
          <p className="truncate text-[13px] text-ink-secondary">
            {row.contact_name ? `${row.contact_name}${row.contact_title ? `, ${row.contact_title}` : ""}` : "No contact"}
            {verify ? <span className={verify.tone}> · {verify.text}</span> : null}
            {row.sequence_name ? ` · ${sequenceShort(row.sequence_name)}` : ` · no sequence${row.group_name ? ` for ${row.group_name}` : ""}`}
          </p>
          {!open && row.subject ? <p className="mt-0.5 truncate text-[13px] text-ink-secondary" title={row.subject}>Subject: {row.subject}</p> : null}
          {red.length + yellow.length > 0 && !open ? (
            <p className={`mt-1 line-clamp-2 text-[13px] ${red.length ? "text-danger" : "text-warn"}`}>{(red[0] ?? yellow[0]).message}{red.length + yellow.length > 1 ? ` (+${red.length + yellow.length - 1} more)` : ""}</p>
          ) : (
            <p className="mt-1 text-[13px] text-ink-secondary">{REVIEW_LABEL[row.status] ?? ""}</p>
          )}
        </div>
        <div className="mt-3 grid shrink-0 grid-cols-2 gap-2 md:mt-0 md:flex md:items-center">
          <Button className={APPROVE} loading={busy} disabled={red.length > 0 || row.status === "pending"} title={red.length ? red[0].message : undefined} onClick={onApprove}>Approve</Button>
          <Button variant="danger" className="max-md:h-11 md:h-8" disabled={busy} onClick={onReject}>Reject</Button>
        </div>
      </div>
      {open ? (
        <div className="space-y-3 border-t border-line bg-surface-3 px-4 py-3 text-[13px] text-ink-secondary">
          {row.review_flags.length > 0 ? (
            <ul className="space-y-1">
              {row.review_flags.map((f, i) => (
                <li key={i} className={`break-words ${f.severity === "red" ? "text-danger" : "text-warn"}`}>
                  <span className="text-[11px] uppercase tracking-wide">{f.kind}</span> {f.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ok">No flags from the checks.</p>
          )}
          {row.hook ? <HookLine hook={row.hook} /> : null}
          <label className="block">
            <span className="text-ink-secondary">Subject</span>
            <input disabled={!editable} value={subject} onChange={(e) => { setSubject(e.target.value); queueSave({ subject: e.target.value }); }} className={INPUT} />
          </label>
          <label className="block">
            <span className="text-ink-secondary">Email <span className="text-ink-muted">· sent as “Hi {row.contact_first_name || "there"},” followed by this text and your signature</span></span>
            <textarea disabled={!editable} value={body} rows={Math.min(18, Math.max(8, body.split("\n").length + 2))} onChange={(e) => { setBody(e.target.value); queueSave({ body: e.target.value }); }} className={`${INPUT} font-sans leading-relaxed`} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="block min-w-0">
              <span className="flex flex-wrap items-center justify-between gap-x-3 text-ink-secondary">
                <span>Contact</span>
                <span className="flex flex-wrap items-center gap-x-3 text-[12px]">
                  {row.contact_email ? <button type="button" onClick={() => copy(row.contact_email ?? "", "email")} className={TEXT_BTN}>{copied === "email" ? "Copied" : "Copy email"}</button> : null}
                  {editable ? <button type="button" onClick={() => setAdding((v) => !v)} className={TEXT_BTN}>{adding ? "Cancel" : "Add a contact"}</button> : null}
                </span>
              </span>
              <select disabled={!editable} value={row.contact_id ?? ""} onChange={(e) => onEdit({ contact_id: e.target.value || null })} className={INPUT}>
                <option value="">None</option>
                {row.contact_options.map((c) => (
                  <option key={c.id} value={c.id} disabled={!c.email}>{c.name}{c.title ? `, ${c.title}` : ""}{c.email ? ` (${c.email})` : " (no email)"}</option>
                ))}
              </select>
            </div>
            <label className="block min-w-0">
              <span className="text-ink-secondary">Sequence</span>
              <select disabled={!editable} value={row.sequence_id ?? ""} onChange={(e) => onEdit({ sequence_id: e.target.value || null })} className={INPUT}>
                <option value="">None</option>
                {sequences.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
          </div>
          {adding ? (
            <form
              className="rounded-sm border border-line bg-white p-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!newContact.email.trim() || !newContact.lastName.trim()) return;
                onAddContact(newContact);
                setAdding(false);
                setNewContact({ firstName: "", lastName: "", email: "", title: "" });
              }}
            >
              <div className="grid gap-2 sm:grid-cols-4">
                <input required placeholder="First name" value={newContact.firstName} onChange={(e) => setNewContact({ ...newContact, firstName: e.target.value })} className={INPUT} />
                <input required placeholder="Last name" value={newContact.lastName} onChange={(e) => setNewContact({ ...newContact, lastName: e.target.value })} className={INPUT} />
                <input required type="email" placeholder="Email" value={newContact.email} onChange={(e) => setNewContact({ ...newContact, email: e.target.value })} className={INPUT} />
                <input placeholder="Title (optional)" value={newContact.title} onChange={(e) => setNewContact({ ...newContact, title: e.target.value })} className={INPUT} />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Button variant="secondary" className="max-md:h-11 md:h-8 whitespace-nowrap" type="submit" loading={busy}>Add and use</Button>
                <span className="text-[12px] text-ink-muted">Created on the account in Salesforce, then verified and used for this email.</span>
              </div>
            </form>
          ) : null}
          {(row.restaurant_options ?? []).length === 0 ? (
            <p className="text-[12px] text-ink-muted">No restaurant list on this row yet. Re-check to load it from Sourcing.</p>
          ) : (
            <label className="block">
              <span className="text-ink-secondary">Restaurant</span>
              <select disabled={!editable} value="" onChange={(e) => { if (e.target.value) onEdit({ restaurant: e.target.value }); }} className={INPUT}>
                <option value="">Swap the restaurant in the subject…</option>
                {row.restaurant_options.map((r) => (
                  <option key={r.name} value={r.name} title={r.description}>{r.name}{r.description ? ` · ${r.description.slice(0, 60)}` : ""}</option>
                ))}
              </select>
            </label>
          )}
          <div className="flex flex-wrap items-center gap-x-4 text-[13px]">
            {row.website ? <a href={/^https?:/i.test(row.website) ? row.website : `https://${row.website}`} target="_blank" rel="noreferrer" className={`${TEXT_BTN} break-all`}>{row.website.replace(/^https?:\/\/(www\.)?/, "")}</a> : null}
            {sfUrl ? <a href={`${sfUrl}/${row.sf_account_id}`} target="_blank" rel="noreferrer" className={TEXT_BTN}>Salesforce</a> : null}
            {editable ? <button type="button" disabled={busy} onClick={onRecheck} className={TEXT_BTN}>Re-check email and sequence</button> : null}
            {editable ? <button type="button" disabled={busy} onClick={onRehook} className={TEXT_BTN}>{busy ? "Researching…" : "Deep research this hook"}</button> : null}
            <span className="text-ink-muted">{[row.city, row.state, row.country].filter(Boolean).join(", ")}{row.time_zone ? ` · ${row.time_zone}` : ""}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const HOOK_STYLE: Record<Hook["level"], { dot: string; text: string; label: string }> = {
  high: { dot: "bg-ok", text: "text-ok", label: "Hook confirmed" },
  medium: { dot: "bg-warn", text: "text-warn", label: "Hook probable" },
  low: { dot: "bg-danger", text: "text-danger", label: "Hook weak" },
  none: { dot: "bg-danger", text: "text-danger", label: "No hook" },
};

/** One line under the flags: what the opening sentence rests on, colour by confidence. */
function HookLine({ hook }: { hook: Hook }) {
  const st = HOOK_STYLE[hook.level] ?? HOOK_STYLE.none;
  return (
    <p className={`flex items-start gap-2 ${st.text}`}>
      <span className={`mt-[5px] inline-block h-2 w-2 shrink-0 rounded-full ${st.dot}`} aria-hidden />
      <span>
        <span className="uppercase tracking-wide text-[11px]">{st.label}</span>{" "}
        {hook.anchor ? <span className="text-ink">“{hook.anchor}” — </span> : null}
        {hook.note}
        {hook.sourceUrl ? (
          <>
            {" "}
            <a href={hook.sourceUrl} target="_blank" rel="noreferrer" className="text-info no-underline hover:underline">source</a>
          </>
        ) : null}
      </span>
    </p>
  );
}

function SettingsPanel({ settings, sequences, groups, onSaved }: { settings: Settings; sequences: Sequence[]; groups: string[]; onSaved: (s: Settings) => void }) {
  const [form, setForm] = useState<Settings>(settings);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The stored Outlook signature (HTML when imported from a sent email), shared with the Inbox.
  const [sig, setSig] = useState<{ html: string; source: string } | null | undefined>(undefined);
  const [sigBusy, setSigBusy] = useState(false);
  const [sigErr, setSigErr] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/inbox/signature", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setSig(d.signature ? { html: d.signature.html, source: d.signature.source } : null))
      .catch(() => setSig(null));
  }, []);
  async function importSignature() {
    setSigBusy(true);
    setSigErr(null);
    try {
      const res = await fetch("/api/inbox/signature", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "import" }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Could not import");
      setSig(d.signature ? { html: d.signature.html, source: d.signature.source } : null);
    } catch (e) {
      setSigErr(e instanceof Error ? e.message : "Could not import");
    } finally {
      setSigBusy(false);
    }
  }
  const field = "mt-1 w-full rounded-sm border border-line bg-white px-3 py-2 text-base text-ink sm:px-2 sm:py-1.5 sm:text-sm focus:border-ink focus:outline-none focus:ring-2 focus:ring-surface-4";
  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "settings", ...form }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      onSaved(data.settings);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="max-w-2xl space-y-5 rounded-md border border-line bg-white p-5">
      <label className="flex items-start gap-3 text-sm text-ink">
        <input type="checkbox" checked={form.manualSend} onChange={(e) => setForm((f) => ({ ...f, manualSend: e.target.checked }))} className="mt-1 h-4 w-4 accent-ink" />
        <span>
          Send E1 myself from Outreach
          <span className="block text-[13px] text-ink-secondary">On enrol, the app adds the prospect to the sequence (subject in custom1) and logs the E1 in Salesforce. You open the step-1 task in Outreach, paste the subject and email from the row, and send, so the follow-ups run. Off: the app schedules the E1 itself.</span>
        </span>
      </label>
      <label className="flex items-start gap-3 text-sm text-ink">
        <input type="checkbox" checked={form.dryRun} onChange={(e) => setForm((f) => ({ ...f, dryRun: e.target.checked }))} className="mt-1 h-4 w-4 accent-ink" />
        <span>
          <span className="block">Dry run</span>
          <span className="block text-[13px] text-ink-secondary">Create the draft in Outreach with the time attached, but never flip it to scheduled. Turn off once you have seen one real draft and are happy.</span>
        </span>
      </label>
      <label className="flex items-start gap-3 text-sm text-ink">
        <input type="checkbox" checked={form.reviewWithModel} onChange={(e) => setForm((f) => ({ ...f, reviewWithModel: e.target.checked }))} className="mt-1 h-4 w-4 accent-ink" />
        <span>
          <span className="block">Review each draft before I see it</span>
          <span className="block text-[13px] text-ink-secondary">Spelling, town, restaurant and hook checks, flag only. About 2 cents per email.</span>
        </span>
      </label>
      <div className="text-sm text-ink">
        <p>Signature</p>
        <p className="mb-2 text-[13px] text-ink-secondary">Outreach adds your mailbox signature when it sends, so the queue adds none. The plain-text override below is only for a mailbox with no signature set in Outreach.</p>
        {sig === undefined ? (
          <p className="text-[13px] text-ink-muted">Loading…</p>
        ) : sig ? (
          <div className="rounded-sm border border-line bg-surface-3 p-3">
            <div className="text-[13px] text-ink [&_a]:text-info" dangerouslySetInnerHTML={{ __html: sig.html }} />
            <p className="mt-2 text-[12px] text-ink-muted">{sig.source === "imported" ? "Imported from a sent email, formatting kept." : "Pasted as plain text, no formatting."}</p>
          </div>
        ) : (
          <p className="text-[13px] text-ink-muted">No signature stored here; Outreach adds its own.</p>
        )}
        <div className="mt-2 flex items-center gap-3">
          <Button variant="secondary" size="sm" className="h-auto min-h-[44px] py-2 text-left sm:min-h-0" loading={sigBusy} onClick={() => void importSignature()}>Import formatted signature from my last sent email</Button>
          {sigErr ? <span className="text-[13px] text-danger">{sigErr}</span> : null}
        </div>
        <label className="mt-3 block text-[13px] text-ink-secondary">
          Plain-text override (leave empty to use the stored signature above)
          <textarea rows={3} value={form.signatureText} onChange={(e) => setForm((f) => ({ ...f, signatureText: e.target.value }))} className={field} />
        </label>
      </div>
      <div className="text-sm text-ink">
        <p>Sequence overrides</p>
        <p className="mb-2 text-[13px] text-ink-secondary">Groups map to sequences by name. Set one here when the name match is wrong or missing.</p>
        <div className="space-y-2">
          {groups.length === 0 ? <p className="text-[13px] text-ink-muted">No groups in this week&apos;s queue yet.</p> : null}
          {groups.map((g) => (
            <label key={g} className="grid grid-cols-2 items-center gap-2 text-[13px]">
              <span className="truncate text-ink-secondary">{g}</span>
              <select value={form.sequenceMap[g] ?? ""} onChange={(e) => setForm((f) => { const m = { ...f.sequenceMap }; if (e.target.value) m[g] = e.target.value; else delete m[g]; return { ...f, sequenceMap: m }; })} className="min-w-0 rounded-sm border border-line bg-white px-2 py-2 text-base text-ink sm:py-1 sm:text-[13px]">
                <option value="">By name</option>
                {sequences.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>
      {err ? <p className="text-sm text-danger">{err}</p> : null}
      <Button className="max-md:h-11" loading={saving} onClick={() => void save()}>Save</Button>
    </div>
  );
}
