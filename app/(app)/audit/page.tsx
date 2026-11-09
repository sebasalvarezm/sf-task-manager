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

      <ContactNotesSwitch />
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
