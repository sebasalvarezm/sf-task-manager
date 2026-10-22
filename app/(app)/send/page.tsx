"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { PageContent } from "@/app/components/ui/PageContent";
import { Button } from "@/app/components/ui/Button";

/**
 * Send queue: this week's sourced E1s, checked before Seb looks.
 *
 * Each row carries the proposed contact and its email verdict, the Outreach
 * sequence the group mapped to, the model's review flags, and the editable
 * subject and body. Clean rows need one click (Approve); flagged rows need a
 * decision. "Schedule approved" hands the approved rows to Outreach with send
 * times spread across the recipients' mornings and evenings. Dry run (on by
 * default) stops at the draft so the exact email can be seen in Outreach first.
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
};
type Sequence = { id: string; name: string };
type Settings = { dryRun: boolean; manualSend: boolean; sequenceMap: Record<string, string>; signatureText: string; reviewWithModel: boolean };
type JobInfo = { id: string; kind: string; status: string; progress?: { step?: string; pct?: number } | null } | null;

const STATUS_LABEL: Record<Status, string> = {
  pending: "Checking",
  review: "Needs a decision",
  ready: "Clean, ready to approve",
  approved: "Approved",
  scheduling: "Sending to Outreach…",
  dry_run: "Draft in Outreach (dry run)",
  scheduled: "Scheduled",
  sent: "Sent",
  failed: "Failed",
  rejected: "Rejected",
};

const VERIFY_LABEL: Record<string, { text: string; tone: string }> = {
  valid: { text: "Email verified", tone: "text-ok" },
  accept_all: { text: "Catch-all, unproven", tone: "text-warn" },
  unknown: { text: "Could not verify", tone: "text-warn" },
  error: { text: "Verifier error", tone: "text-warn" },
  invalid: { text: "Email invalid", tone: "text-danger" },
  role: { text: "Role address", tone: "text-danger" },
  disposable: { text: "Disposable address", tone: "text-danger" },
};

function fmtSlot(iso: string | null, tz: string | null): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz ?? undefined, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState<"queue" | "done" | "settings">("queue");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

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
      if (typeof data.sfInstanceUrl === "string") setSfUrl(data.sfInstanceUrl);
      setWeek(data.week ?? null);
      setVerifierConfigured(data.verifierConfigured !== false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
    } finally {
      setLoading(false);
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

  const queue = useMemo(() => items.filter((r) => ["pending", "review", "ready", "approved", "scheduling", "failed"].includes(r.status)), [items]);
  const done = useMemo(() => items.filter((r) => ["dry_run", "scheduled", "sent", "rejected"].includes(r.status)), [items]);
  const counts = useMemo(
    () => ({
      review: items.filter((r) => r.status === "review").length,
      ready: items.filter((r) => r.status === "ready").length,
      approved: items.filter((r) => r.status === "approved").length,
      scheduled: items.filter((r) => r.status === "scheduled" || r.status === "dry_run").length,
      failed: items.filter((r) => r.status === "failed").length,
    }),
    [items],
  );

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch("/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Request failed");
    return data;
  }
  function replace(item: Row) {
    setItems((prev) => prev.map((r) => (r.id === item.id ? item : r)));
  }
  async function act(id: string, action: "approve" | "reject" | "cancel" | "recheck" | "rehook" | "add_contact", extra: Record<string, unknown> = {}) {
    setBusy((b) => new Set(b).add(id));
    setError(null);
    try {
      const data = await post({ action, id, ...extra });
      if (data.item) replace(data.item as Row);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(id);
        return n;
      });
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
    const ready = items.filter((r) => r.status === "ready");
    for (const r of ready) await act(r.id, "approve");
    setNotice(`${ready.length} approved.`);
  }
  async function runChecks() {
    setMenuOpen(false);
    setError(null);
    try {
      const data = await post({ action: "prepare" });
      setJob({ id: String(data.jobId), kind: "e1_prepare", status: "queued" });
      setNotice("Checking this week's E1s…");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start");
    }
  }
  async function scheduleApproved() {
    setError(null);
    try {
      const data = await post({ action: "schedule" });
      setJob({ id: String(data.jobId), kind: "e1_schedule", status: "queued" });
      setNotice(data.manualSend ? `Enrolling ${data.count} in Outreach for you to send.` : data.dryRun ? `Dry run: creating ${data.count} drafts in Outreach, nothing will send.` : `Scheduling ${data.count} emails.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start");
    }
  }

  const subtitle = loading
    ? "Loading…"
    : `${counts.ready} clean · ${counts.review} need a decision · ${counts.approved} approved · ${counts.scheduled} with Outreach${counts.failed ? ` · ${counts.failed} failed` : ""}${settings?.dryRun ? " · dry run on" : ""}`;

  return (
    <PageContent>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-normal tracking-tight text-ink">{view === "settings" ? "Send settings" : view === "done" ? "With Outreach" : "Send queue"}</h1>
          <p className="mt-1 text-sm text-ink-secondary">{subtitle}</p>
          {job ? (
            <div className="mt-2 max-w-md">
              <p className="text-xs text-ink-muted">{job.progress?.step ?? (job.kind === "e1_schedule" ? "Scheduling…" : "Checking contacts, emails, sequences and drafts…")}</p>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-4">
                <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${Math.max(4, Math.min(100, job.progress?.pct ?? 4))}%` }} />
              </div>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {view === "queue" ? (
            <>
              <Button variant="secondary" size="sm" disabled={counts.ready === 0 || !!job} onClick={() => void approveAllClean()}>
                Approve all clean ({counts.ready})
              </Button>
              <Button size="sm" disabled={counts.approved === 0 || !!job} onClick={() => void scheduleApproved()}>
                {settings?.manualSend ? "Enrol" : settings?.dryRun ? "Dry run" : "Schedule"} approved ({counts.approved})
              </Button>
            </>
          ) : null}
          <div className="relative">
            <button type="button" onClick={() => setMenuOpen((v) => !v)} aria-label="More" className="flex h-9 w-9 items-center justify-center rounded-sm border border-line-strong bg-white text-ink-secondary hover:bg-surface-3">
              <MoreHorizontal size={18} strokeWidth={1.5} />
            </button>
            {menuOpen ? (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden />
                <div className="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-md border border-line bg-white shadow-xl">
                  {(["queue", "done", "settings"] as const).map((key) => (
                    <button key={key} type="button" onClick={() => { setView(key); setMenuOpen(false); }} className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-3 ${view === key ? "bg-surface-3 text-ink" : "text-ink-secondary"}`}>
                      <span>{key === "queue" ? "Send queue" : key === "done" ? "With Outreach" : "Settings"}</span>
                      <span className="text-xs text-ink-muted tabular-nums">{key === "queue" ? queue.length : key === "done" ? done.length : ""}</span>
                    </button>
                  ))}
                  <div className="border-t border-line" />
                  <button type="button" disabled={!!job} onClick={() => void runChecks()} className="w-full px-3 py-2 text-left text-sm text-ink-secondary hover:bg-surface-3 disabled:text-ink-muted">
                    Check this week&apos;s E1s now
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <p className="mb-4 rounded-sm border border-danger bg-white px-3 py-2 text-sm text-ink">{error}</p> : null}
      {notice ? <p className="mb-4 text-sm text-ink-secondary">{notice}</p> : null}
      {!verifierConfigured ? <p className="mb-4 rounded-sm border border-warn bg-white px-3 py-2 text-sm text-ink">Email verification is off: add QUICKEMAILVERIFICATION_API_KEY in Vercel and redeploy.</p> : null}

      {view === "done" && done.some((r) => r.status === "scheduled" || r.status === "sent") ? (
        <div className="mb-4 rounded-sm border border-line bg-white px-3 py-2 text-[13px] text-ink">
          <div className="flex items-center justify-between">
            <span className="text-ink-secondary">Sent this week, for the manual E2 and E3 next week:</span>
            <button
              type="button"
              className="text-info underline underline-offset-2 hover:text-ink"
              onClick={() => {
                const lines = done.filter((r) => r.status === "scheduled" || r.status === "sent").map((r) => `${r.account_name}\t${r.contact_name ?? ""}\t${r.contact_email ?? ""}\t${r.subject ?? ""}\t${r.sequence_name ?? ""}`);
                void navigator.clipboard?.writeText(["Account\tContact\tEmail\tSubject\tSequence", ...lines].join("\n"));
                setNotice(`${lines.length} rows copied (paste into Excel).`);
              }}
            >
              Copy list
            </button>
          </div>
          <ul className="mt-1 space-y-0.5">
            {done.filter((r) => r.status === "scheduled" || r.status === "sent").map((r) => (
              <li key={r.id}>{r.account_name} · {r.contact_name ?? "?"} ({r.contact_email ?? "?"}) · {r.subject ?? ""}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {view === "settings" && settings ? (
        <SettingsPanel settings={settings} sequences={sequences} groups={Array.from(new Set(items.map((r) => r.group_name).filter((g): g is string => !!g)))} onSaved={(s) => { setSettings(s); setNotice("Settings saved."); setView("queue"); }} />
      ) : loading ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : (view === "queue" ? queue : done).length === 0 ? (
        <p className="text-sm text-ink-secondary">
          {view === "queue" ? `Nothing in the queue for the week of ${week ?? ""}. Sourced E1s land here on their own; or run the check from the menu.` : "Nothing with Outreach yet."}
        </p>
      ) : (
        <div className="rounded-md border border-line bg-white">
          {(view === "queue" ? queue : done).map((row) => (
            <SendRow
              key={row.id}
              row={row}
              sequences={sequences}
              busy={busy.has(row.id)}
              open={open === row.id}
              sfUrl={sfUrl}
              onToggle={() => setOpen((v) => (v === row.id ? null : row.id))}
              onApprove={() => { setOpen(null); void act(row.id, "approve"); }}
              onReject={() => void act(row.id, "reject")}
              onCancel={() => void act(row.id, "cancel")}
              onRecheck={() => void act(row.id, "recheck")}
              onRehook={() => void act(row.id, "rehook")}
              onAddContact={(contact) => void act(row.id, "add_contact", { contact })}
              onEdit={(patch) => void edit(row.id, patch)}
            />
          ))}
        </div>
      )}
    </PageContent>
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

function SendRow({ row, sequences, busy, open, sfUrl, onToggle, onApprove, onReject, onCancel, onRecheck, onRehook, onAddContact, onEdit }: {
  sfUrl: string | null;
  row: Row;
  sequences: Sequence[];
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  onApprove: () => void;
  onReject: () => void;
  onCancel: () => void;
  onRecheck: () => void;
  onRehook: () => void;
  onAddContact: (contact: { firstName: string; lastName: string; email: string; title: string }) => void;
  onEdit: (patch: Record<string, unknown>) => void;
}) {
  const red = row.review_flags.filter((f) => f.severity === "red");
  const yellow = row.review_flags.filter((f) => f.severity === "yellow");
  const verify = row.verify_result ? VERIFY_LABEL[row.verify_result] : null;
  const editable = ["pending", "review", "ready", "approved", "failed"].includes(row.status);
  const dot = row.status === "ready" || row.status === "approved" ? "bg-ok" : row.status === "review" || row.status === "failed" ? (red.length || row.status === "failed" ? "bg-danger" : "bg-warn") : "bg-ink-muted";
  const [subject, setSubject] = useState(row.subject ?? "");
  const [body, setBody] = useState(row.body ?? "");
  const [adding, setAdding] = useState(false);
  const [newContact, setNewContact] = useState({ firstName: "", lastName: "", email: "", title: "" });
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1500);
    });
  };
  const timer = useRef<number | null>(null);
  useEffect(() => {
    setSubject(row.subject ?? "");
    setBody(row.body ?? "");
  }, [row.id, row.subject, row.body]);
  const queueSave = (next: { subject?: string; body?: string }) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onEdit(next), 800);
  };

  return (
    <div className="border-b border-line last:border-b-0">
      <div role="button" tabIndex={0} onClick={onToggle} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }} className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-surface-3 sm:items-center">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-[15px] text-ink">
            <span className="font-medium">{row.account_name}</span>
            <span className="text-[13px] text-ink-secondary">{STATUS_LABEL[row.status]}</span>
          </p>
          <p className="truncate text-[13px] text-ink-secondary">
            {row.contact_name ? `${row.contact_name}${row.contact_title ? `, ${row.contact_title}` : ""}` : "No contact"}
            {verify ? <span className={` · ${verify.tone}`}> · {verify.text}</span> : null}
            {row.sequence_name ? ` · ${row.sequence_name.replace(/^\s*\[E\]\s*-?\s*/, "")}` : ` · no sequence${row.group_name ? ` for ${row.group_name}` : " (no group)"}`}
            {row.scheduled_for ? ` · ${fmtSlot(row.scheduled_for, row.time_zone)}` : ""}
          </p>
          {red.length + yellow.length > 0 && !open ? (
            <p className={`mt-0.5 truncate text-[13px] ${red.length ? "text-danger" : "text-warn"}`}>{(red[0] ?? yellow[0]).message}{red.length + yellow.length > 1 ? ` (+${red.length + yellow.length - 1})` : ""}</p>
          ) : null}
          {row.status_reason && !open ? <p className="mt-0.5 truncate text-[13px] text-ink-muted">{row.status_reason}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {row.status === "ready" || row.status === "review" || row.status === "failed" ? (
            <>
              <Button size="sm" loading={busy} disabled={red.length > 0 && row.status !== "failed"} title={red.length ? red[0].message : undefined} onClick={onApprove}>Approve</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={onReject}>Reject</Button>
            </>
          ) : row.status === "approved" ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onReject}>Un-approve</Button>
          ) : row.status === "dry_run" || row.status === "scheduled" ? (
            <Button size="sm" variant="ghost" loading={busy} onClick={onCancel}>Cancel</Button>
          ) : null}
        </div>
      </div>
      {open ? (
        <div className="space-y-3 border-t border-line bg-surface-3 px-4 py-3 text-[13px] text-ink-secondary">
          {row.review_flags.length > 0 ? (
            <ul className="space-y-1">
              {row.review_flags.map((f, i) => (
                <li key={i} className={f.severity === "red" ? "text-danger" : "text-warn"}>
                  <span className="uppercase tracking-wide text-[11px]">{f.kind}</span> {f.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ok">No flags from the checks.</p>
          )}
          {row.status_reason ? <p className="text-ink-muted">{row.status_reason}</p> : null}
          {row.hook ? <HookLine hook={row.hook} /> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="block">
              <span className="flex items-center justify-between text-ink-secondary">
                <span>Contact</span>
                <span className="flex items-center gap-3 text-[12px]">
                  {row.contact_email ? <button type="button" onClick={() => copy(row.contact_email ?? "", "email")} className="text-info hover:underline">{copied === "email" ? "Copied" : "Copy email"}</button> : null}
                  {row.contact_options.some((c) => c.email) ? <button type="button" onClick={() => copy(row.contact_options.filter((c) => c.email).map((c) => `${c.name}${c.title ? `, ${c.title}` : ""} <${c.email}>`).join("\n"), "all")} className="text-info hover:underline">{copied === "all" ? "Copied" : "Copy all"}</button> : null}
                  {editable ? <button type="button" onClick={() => setAdding((v) => !v)} className="text-info hover:underline">{adding ? "Cancel" : "Add a contact"}</button> : null}
                </span>
              </span>
              <select disabled={!editable} value={row.contact_id ?? ""} onChange={(e) => onEdit({ contact_id: e.target.value || null })} className="mt-1 w-full rounded-sm border border-line bg-white px-2 py-1 text-[13px] text-ink">
                <option value="">None</option>
                {row.contact_options.map((c) => (
                  <option key={c.id} value={c.id} disabled={!c.email}>{c.name}{c.title ? `, ${c.title}` : ""}{c.email ? ` (${c.email})` : " (no email)"}</option>
                ))}
              </select>
            </div>
            <label className="block">
              <span className="text-ink-secondary">Sequence</span>
              <select disabled={!editable} value={row.sequence_id ?? ""} onChange={(e) => onEdit({ sequence_id: e.target.value || null })} className="mt-1 w-full rounded-sm border border-line bg-white px-2 py-1 text-[13px] text-ink">
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
                <input required placeholder="First name" value={newContact.firstName} onChange={(e) => setNewContact({ ...newContact, firstName: e.target.value })} className="rounded-sm border border-line bg-white px-2 py-1 text-[13px] text-ink" />
                <input required placeholder="Last name" value={newContact.lastName} onChange={(e) => setNewContact({ ...newContact, lastName: e.target.value })} className="rounded-sm border border-line bg-white px-2 py-1 text-[13px] text-ink" />
                <input required type="email" placeholder="Email" value={newContact.email} onChange={(e) => setNewContact({ ...newContact, email: e.target.value })} className="rounded-sm border border-line bg-white px-2 py-1 text-[13px] text-ink" />
                <input placeholder="Title (optional)" value={newContact.title} onChange={(e) => setNewContact({ ...newContact, title: e.target.value })} className="rounded-sm border border-line bg-white px-2 py-1 text-[13px] text-ink" />
              </div>
              <div className="mt-2 flex items-center gap-3">
                <Button size="sm" type="submit" loading={busy} className="whitespace-nowrap">Add and use</Button>
                <span className="text-[12px] text-ink-muted">Created on the account in Salesforce, then verified and used for this email.</span>
              </div>
            </form>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-ink-secondary">Subject</span>
              <input disabled={!editable} value={subject} onChange={(e) => { setSubject(e.target.value); queueSave({ subject: e.target.value }); }} className="mt-1 w-full rounded-sm border border-line bg-white px-2 py-1 text-[13px] text-ink" />
            </label>
            {(row.restaurant_options ?? []).length === 0 ? (
              <p className="self-end text-[12px] text-ink-muted">No restaurant list on this row yet. Re-check email and sequence to load it from Sourcing.</p>
            ) : (
              <label className="block">
                <span className="text-ink-secondary">Restaurant</span>
                <select disabled={!editable} value="" onChange={(e) => { if (e.target.value) onEdit({ restaurant: e.target.value }); }} className="mt-1 w-full rounded-sm border border-line bg-white px-2 py-1 text-[13px] text-ink">
                  <option value="">Swap the restaurant in the subject…</option>
                  {row.restaurant_options.map((r) => (
                    <option key={r.name} value={r.name} title={r.description}>{r.name}{r.description ? ` · ${r.description.slice(0, 60)}` : ""}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <label className="block">
            <span className="text-ink-secondary">Email <span className="text-ink-muted">· sent as “Hi {row.contact_first_name || "there"},” followed by this text and your signature</span></span>
            <textarea disabled={!editable} value={body} rows={Math.min(18, Math.max(8, body.split("\n").length + 2))} onChange={(e) => { setBody(e.target.value); queueSave({ body: e.target.value }); }} className="mt-1 w-full rounded-sm border border-line bg-white px-2 py-1 font-sans text-[13px] leading-relaxed text-ink" />
          </label>
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            {row.website ? <a href={/^https?:/i.test(row.website) ? row.website : `https://${row.website}`} target="_blank" rel="noreferrer" className="text-info no-underline hover:underline">{row.website.replace(/^https?:\/\/(www\.)?/, "")}</a> : null}
            {sfUrl ? <a href={`${sfUrl}/${row.sf_account_id}`} target="_blank" rel="noreferrer" className="text-info no-underline hover:underline">Salesforce</a> : null}
            {row.outreach_prospect_id ? <a href={`https://web.outreach.io/prospects/${row.outreach_prospect_id}/${row.outreach_mailing_id ? "emails" : "sequences"}`} target="_blank" rel="noreferrer" className="text-info no-underline hover:underline">{row.outreach_mailing_id ? "Open draft in Outreach" : "Outreach"}</a> : null}
            <span className="text-ink-muted">{[row.city, row.state, row.country].filter(Boolean).join(", ")}{row.time_zone ? ` · ${row.time_zone}` : ""}</span>
            {editable ? <button type="button" onClick={onRecheck} className="text-info underline underline-offset-2 hover:text-ink">Re-check email and sequence</button> : null}
            {editable ? <button type="button" disabled={busy} onClick={onRehook} className="text-info underline underline-offset-2 hover:text-ink disabled:opacity-60">{busy ? "Researching…" : "Deep research this hook"}</button> : null}
            {row.outreach_mailing_id ? <span className="text-ink-muted">Outreach mailing {row.outreach_mailing_id}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
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
  const field = "mt-1 w-full rounded-sm border border-line bg-white px-2 py-1.5 text-sm text-ink focus:border-ink focus:outline-none focus:ring-2 focus:ring-surface-4";
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
          <span className="block text-[13px] text-ink-secondary">On enrol, the app adds the prospect to the sequence, creates a draft in the prospect&apos;s Outreach outbox with subject, email and send time filled in, and logs the E1 in Salesforce. You open the draft and click Schedule. Off: the app schedules the E1 itself.</span>
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
          <Button variant="secondary" size="sm" loading={sigBusy} onClick={() => void importSignature()}>Import formatted signature from my last sent email</Button>
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
              <select value={form.sequenceMap[g] ?? ""} onChange={(e) => setForm((f) => { const m = { ...f.sequenceMap }; if (e.target.value) m[g] = e.target.value; else delete m[g]; return { ...f, sequenceMap: m }; })} className="rounded-sm border border-line bg-white px-2 py-1 text-[13px] text-ink">
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
      <Button loading={saving} onClick={() => void save()}>Save</Button>
    </div>
  );
}
