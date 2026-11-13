"use client";

/**
 * Weekly check: the read-only sweep for mistakes (lib/audit.ts). Runs Sunday
 * evening on its own; "Run now" runs it on demand. Nothing here changes any
 * data except the pause switch.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageContent } from "@/app/components/ui/PageContent";
import { Button } from "@/app/components/ui/Button";
import type { AuditReport } from "@/lib/audit";

type Payload = { report: AuditReport | null; settings: { paused: boolean } };

export default function AuditPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/audit");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not load the weekly check");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the weekly check");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>) {
    setError(null);
    const res = await fetch("/api/audit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? "The check failed");
    return json;
  }

  async function runNow() {
    setRunning(true);
    try {
      const json = await post({ action: "run" });
      setData((d) => ({ settings: d?.settings ?? { paused: false }, report: json.report }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The check failed");
    } finally {
      setRunning(false);
    }
  }

  async function togglePause() {
    if (!data) return;
    try {
      const json = await post({ action: "settings", paused: !data.settings.paused });
      setData({ ...data, settings: json.settings });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  }

  const report = data?.report ?? null;

  return (
    <PageContent>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-normal tracking-tight text-ink">Weekly check</h1>
          <p className="mt-1 text-sm text-ink-secondary">
            Read-only. Runs Sunday evening{data?.settings.paused ? " (paused)" : ""}.
            {report ? ` Last run ${new Date(report.at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}, ${report.issues === 0 ? "nothing to fix" : `${report.issues} to look at`}.` : " Not run yet."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void togglePause()} disabled={!data}>
            {data?.settings.paused ? "Resume Sunday runs" : "Pause Sunday runs"}
          </Button>
          <Button size="sm" loading={running} onClick={() => void runNow()}>Run now</Button>
        </div>
      </div>

      {error ? <p className="rounded-sm border border-danger bg-white px-3 py-2 text-sm text-ink">{error}</p> : null}
      {!data && !error ? <p className="text-sm text-ink-secondary">Loading…</p> : null}

      {report ? (
        <div className="rounded-md border border-line bg-white">
          {report.checks.map((c) => (
            <section key={c.key} className="border-b border-line px-4 py-3 last:border-b-0">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-[15px] font-medium text-ink">{c.title}</h2>
                <span className={`text-[13px] ${c.skipped ? "text-ink-muted" : c.items.length ? "text-warn" : "text-ok"}`}>
                  {c.skipped ? "Not checked" : c.items.length ? `${c.items.length} to look at` : "OK"}
                </span>
              </div>
              {c.skipped ? <p className="mt-1 text-[13px] text-ink-muted">{c.skipped}</p> : null}
              {!c.skipped && c.items.length === 0 ? <p className="mt-1 text-[13px] text-ink-secondary">{c.okText}</p> : null}
              {c.items.length ? (
                <ul className="mt-1 space-y-0.5">
                  {c.items.map((it, i) => (
                    <li key={i} className="text-[13px] text-ink-secondary">
                      {it.href ? (
                        it.href.startsWith("/") ? (
                          <Link href={it.href} className="text-info no-underline hover:underline">{it.label}</Link>
                        ) : (
                          <a href={it.href} target="_blank" rel="noreferrer" className="text-info no-underline hover:underline">{it.label}</a>
                        )
                      ) : (
                        <span className="text-ink">{it.label}</span>
                      )}
                      {": "}
                      {it.detail}
                    </li>
                  ))}
                </ul>
              ) : null}
              {c.notes?.length ? <p className="mt-1 text-[12px] text-ink-muted">{c.notes.join(" · ")}</p> : null}
            </section>
          ))}
        </div>
      ) : null}

      <LearnedRules />
      <OwnerSwitch />
      <ContactNotesSwitch />
      <ReplySearchSwitch />
    </PageContent>
  );
}

/** The pause switch for "Will contact this week" lines in Salesforce descriptions (lib/contact-notes.ts). */
function ContactNotesSwitch() {
  const [state, setState] = useState<{ paused: boolean; active: number } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch("/api/weekly-outreach/contact-notes")
      .then((r) => r.json())
      .then((d) => setState({ paused: Boolean(d.settings?.paused), active: (d.items ?? []).filter((n: { status: string }) => n.status === "active").length }))
      .catch(() => setState(null));
  }, []);
  if (!state) return null;
  async function toggle() {
    if (!state) return;
    setBusy(true);
    try {
      const res = await fetch("/api/weekly-outreach/contact-notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "settings", paused: !state.paused }) });
      const d = await res.json();
      if (res.ok) setState({ ...state, paused: Boolean(d.settings?.paused) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-white px-4 py-3 text-sm">
      <p className="text-ink-secondary">
        <span className="text-ink">&quot;Will contact this week&quot; in Salesforce descriptions:</span>{" "}
        {state.paused ? "paused" : `on, ${state.active} account${state.active !== 1 ? "s" : ""} marked`}
      </p>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void toggle()}>{state.paused ? "Resume" : "Pause"}</Button>
    </div>
  );
}

/** Reply search for Inbox drafts (lib/reply-search.ts): setup state, index size, Index now, pause. */
function ReplySearchSwitch() {
  const [state, setState] = useState<{ paused: boolean; indexed: number | null; tableReady: boolean; keySet: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/inbox/reply-search")
      .then((r) => r.json())
      .then((d) => setState({ paused: Boolean(d.settings?.paused), indexed: d.indexed ?? null, tableReady: Boolean(d.tableReady), keySet: Boolean(d.keySet) }))
      .catch(() => setState(null));
  }, []);
  if (!state) return null;
  async function post(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch("/api/inbox/reply-search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return res.ok ? await res.json() : null;
    } finally {
      setBusy(false);
    }
  }
  async function runIndex() {
    if (!state) return;
    setNote("reading your Sent Items, this can take a few minutes");
    setBusy(true);
    try {
      const res = await fetch("/api/inbox/reply-search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "index" }) });
      const d = await res.json().catch(() => null);
      if (!d) throw new Error("No answer from the server (it may have run out of time). Tap Index now again; it continues where it stopped.");
      if (!res.ok) throw new Error(d.error ?? "Indexing failed");
      setState({ ...state, indexed: d.indexed ?? state.indexed });
      setNote(`${d.summary.added} new replies indexed (${d.summary.scanned} sent emails read, ${d.summary.usable} usable)${d.reason ? `. Stopped early: ${d.reason}` : ""}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Indexing failed");
    } finally {
      setBusy(false);
    }
  }
  const status = !state.keySet
    ? "needs the Voyage key in Vercel (VOYAGE_API_KEY)"
    : !state.tableReady
      ? "needs the one-time database step (supabase/2026-11-reply-search.sql)"
      : state.paused
        ? "paused, drafts use your most recent replies"
        : `on, ${state.indexed ?? 0} past replies indexed`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-white px-4 py-3 text-sm">
      <p className="text-ink-secondary">
        <span className="text-ink">Inbox drafts learn from your most similar past replies:</span> {status}
        {note ? <span className="text-ink-muted"> · {note}</span> : null}
      </p>
      {state.keySet && state.tableReady ? (
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={busy || state.paused} onClick={() => void runIndex()}>{busy ? "Indexing…" : "Index now"}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void post({ action: "settings", paused: !state.paused }).then((d) => d && setState({ ...state, paused: Boolean(d.settings?.paused) }))}>{state.paused ? "Resume" : "Pause"}</Button>
        </div>
      ) : null}
    </div>
  );
}

/** Weekly Outreach accounts owned by Seb in Salesforce (lib/account-owner.ts): pause switch. */
function OwnerSwitch() {
  const [paused, setPaused] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch("/api/weekly-outreach/owners")
      .then((r) => r.json())
      .then((d) => setPaused(Boolean(d.settings?.paused)))
      .catch(() => setPaused(null));
  }, []);
  if (paused === null) return null;
  async function toggle() {
    setBusy(true);
    try {
      const res = await fetch("/api/weekly-outreach/owners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "settings", paused: !paused }) });
      const d = await res.json();
      if (res.ok) setPaused(Boolean(d.settings?.paused));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-white px-4 py-3 text-sm">
      <p className="text-ink-secondary">
        <span className="text-ink">Weekly Outreach accounts become yours in Salesforce:</span> {paused ? "paused" : "on"}
      </p>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void toggle()}>{paused ? "Resume" : "Pause"}</Button>
    </div>
  );
}

type LearnedRuleView = {
  id: string;
  kind: "swap" | "style";
  summary: string;
  emails: number;
  evidence: Array<{ source: string; account: string | null; before: string; after: string }>;
  status: "proposed" | "active" | "rejected" | "removed";
};
const SOURCE_NAME: Record<string, string> = { e1: "E1", rce: "RCE", followup: "Follow-up", nudge: "Nudge", inbox: "Inbox reply" };

/** Learning from Seb's edits (lib/draft-learning.ts): proposals to accept or reject, active rules to remove. */
function LearnedRules() {
  const [data, setData] = useState<{ rules: LearnedRuleView[]; paused: boolean; captured: number | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => {
    fetch("/api/draft-learning")
      .then((r) => r.json())
      .then((d) => setData({ rules: d.rules ?? [], paused: Boolean(d.settings?.paused), captured: d.capturedThisWeek ?? null }))
      .catch(() => setData(null));
  }, []);
  useEffect(() => load(), [load]);
  if (!data) return null;
  async function post(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setNote(null);
    try {
      const res = await fetch("/api/draft-learning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Failed");
      if (d.run) setNote(d.run.note ?? `${d.run.edited} edited emails reviewed, ${d.run.proposed} new proposal${d.run.proposed === 1 ? "" : "s"}.`);
      load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }
  const proposed = data.rules.filter((r) => r.status === "proposed");
  const active = data.rules.filter((r) => r.status === "active");
  return (
    <div className="rounded-md border border-line bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-[15px] font-medium text-ink">Learned from your edits</h2>
          <p className="text-[13px] text-ink-secondary">
            {data.captured === null
              ? "Needs the one-time database step (supabase/2026-11-reply-search.sql)."
              : `${data.captured} email${data.captured === 1 ? "" : "s"} sent through the tool this week. Reviewed Sundays${data.paused ? " (paused)" : ""}; nothing changes until you accept.`}
          </p>
          {note ? <p className="mt-1 text-[13px] text-ink-muted">{note}</p> : null}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={busy !== null || data.paused || data.captured === null} onClick={() => void post("run", { action: "run" })}>{busy === "run" ? "Reviewing…" : "Review now"}</Button>
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void post("pause", { action: "settings", paused: !data.paused })}>{data.paused ? "Resume" : "Pause"}</Button>
        </div>
      </div>
      {proposed.map((r) => (
        <div key={r.id} className="border-b border-line px-4 py-3 last:border-b-0">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[14px] text-ink">{r.summary}</p>
              <p className="text-[12px] text-ink-muted">Seen in {r.emails} emails{r.kind === "swap" ? " · applied as a word fix on every draft" : " · added to the drafting instructions"}</p>
              <ul className="mt-1 space-y-0.5">
                {r.evidence.slice(0, 2).map((e, i) => (
                  <li key={i} className="text-[12px] text-ink-secondary">
                    {SOURCE_NAME[e.source] ?? e.source}{e.account ? `, ${e.account}` : ""}: &ldquo;{e.before}&rdquo; → {e.after ? <>&ldquo;{e.after}&rdquo;</> : <em>deleted</em>}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" disabled={busy !== null} onClick={() => void post(r.id, { action: "decide", id: r.id, decision: "accept" })}>Accept</Button>
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void post(r.id, { action: "decide", id: r.id, decision: "reject" })}>Reject</Button>
            </div>
          </div>
        </div>
      ))}
      {active.length > 0 ? (
        <div className="px-4 py-3">
          <p className="text-[12px] uppercase tracking-wide text-ink-muted">Active rules</p>
          <ul className="mt-1 space-y-1">
            {active.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 text-[13px] text-ink">
                <span className="min-w-0">{r.summary}</span>
                <button type="button" disabled={busy !== null} onClick={() => void post(r.id, { action: "decide", id: r.id, decision: "remove" })} className="shrink-0 text-[13px] text-info disabled:text-ink-muted">Remove</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
