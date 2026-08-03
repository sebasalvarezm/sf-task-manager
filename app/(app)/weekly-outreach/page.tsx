"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { format, startOfWeek } from "date-fns";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";
import { Button } from "@/app/components/ui/Button";
import { Alert } from "@/app/components/ui/Alert";
import { Spinner } from "@/app/components/ui/Spinner";
import type {
  WeeklyOutreachItem,
  WeeklyOutreachStatus,
} from "@/lib/weekly-outreach";

const STATUSES: Array<{ value: WeeklyOutreachStatus; label: string }> = [
  { value: "queued", label: "Queued" },
  { value: "needs_context", label: "Needs context" },
  { value: "researching", label: "Researching" },
  { value: "draft_ready", label: "Draft ready" },
  { value: "approved", label: "Approved" },
  { value: "sent", label: "Sent" },
];

function thisWeek(): string {
  return format(startOfWeek(new Date(), { weekStartsOn: 1 }), "yyyy-MM-dd");
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export default function WeeklyOutreachPage() {
  const [weekStart, setWeekStart] = useState(thisWeek);
  const [items, setItems] = useState<WeeklyOutreachItem[]>([]);
  const [entry, setEntry] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [preparingRces, setPreparingRces] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/weekly-outreach?weekStart=${weekStart}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load the week");
      setItems(data.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the week");
    } finally {
      setLoading(false);
    }
  }, [weekStart]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(
    () => ({
      total: items.length,
      e1: items.filter((i) => i.outreach_type === "E1").length,
      rce: items.filter((i) => i.outreach_type === "RCE").length,
      ready: items.filter((i) => i.status === "draft_ready").length,
    }),
    [items],
  );

  async function addManual(e: React.FormEvent) {
    e.preventDefault();
    if (!entry.trim() || saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/weekly-outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry, weekStart }),
      });
      const data = await res.json();
      if (!res.ok) {
        const suffix = Array.isArray(data.candidates)
          ? ` Matches: ${data.candidates.join(", ")}`
          : "";
        throw new Error(`${data.error ?? "Could not add company"}${suffix}`);
      }
      setEntry("");
      setMessage(`${data.item.account_name} added as ${data.item.outreach_type}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add company");
    } finally {
      setSaving(false);
    }
  }

  async function updateRow(
    item: WeeklyOutreachItem,
    changes: { status?: WeeklyOutreachStatus; notes?: string | null },
  ) {
    setItems((prev) => prev.map((r) => (r.id === item.id ? { ...r, ...changes } : r)));
    const res = await fetch("/api/weekly-outreach", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, ...changes }),
    });
    if (!res.ok) {
      setError((await res.json()).error ?? "Could not update row");
      await load();
    }
  }

  async function removeRow(item: WeeklyOutreachItem) {
    if (!window.confirm(`Remove ${item.account_name} from this week?`)) return;
    const res = await fetch(`/api/weekly-outreach?id=${item.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError((await res.json()).error ?? "Could not remove row");
      return;
    }
    setItems((prev) => prev.filter((r) => r.id !== item.id));
  }

  async function prepareE1s() {
    const e1s = items.filter(
      (i) => i.outreach_type === "E1" && i.status !== "sent" && !i.sourcing_job_id,
    );
    if (e1s.length === 0) {
      setMessage("There are no unsourced E1s in this week.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/jobs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "sourcing_bulk",
          input: { entries: e1s.map((i) => i.website || i.account_name), weeklyOutreachIds: e1s.map((i) => i.id) },
          label: `Weekly Outreach: ${e1s.length} E1${e1s.length === 1 ? "" : "s"}`,
          resultRoute: "/sourcing?jobId={jobId}",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not create sourcing batch");
      await fetch("/api/weekly-outreach", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: e1s.map((i) => i.id),
          status: "researching",
          sourcingJobId: data.jobId,
        }),
      });
      setMessage(`Created one Sourcing batch for ${e1s.length} E1s. Nothing was sent.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create sourcing batch");
    } finally {
      setSaving(false);
    }
  }

  async function prepareRce(item: WeeklyOutreachItem) {
    setPreparingRces((prev) => new Set(prev).add(item.id));
    setError(null);
    try {
      const res = await fetch("/api/weekly-outreach/prepare-rce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not prepare reconnect");
      setItems((prev) => prev.map((r) => r.id === item.id ? data.item : r));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not prepare reconnect");
    } finally {
      setPreparingRces((prev) => { const next = new Set(prev); next.delete(item.id); return next; });
    }
  }

  async function prepareAllRces() {
    const rces = items.filter((i) => i.outreach_type === "RCE" && i.status !== "sent" && !i.draft);
    for (let i = 0; i < rces.length; i += 3) {
      await Promise.all(rces.slice(i, i + 3).map(prepareRce));
    }
    if (rces.length > 0) setMessage(`Prepared ${rces.length} reconnect draft${rces.length === 1 ? "" : "s"}. Nothing was sent.`);
  }

  async function copyCsv() {
    const headers = ["Week", "Type", "Company", "Industry", "Country", "City", "Tier", "Group", "Source", "RCE Days", "Status", "Notes"];
    const rows = items.map((i) => [
      i.week_start, i.outreach_type, i.account_name, i.industry, i.country,
      i.city, i.tier, i.group_name, i.source, i.rce_days, i.status, i.notes,
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    await navigator.clipboard.writeText(csv);
    setMessage("Weekly Outreach copied as CSV.");
  }

  return (
    <>
      <PageHeader
        title="Weekly Outreach"
        subtitle={`${counts.total} companies · ${counts.rce} RCE · ${counts.e1} E1 · ${counts.ready} drafts ready`}
        actions={
          <input
            type="date"
            value={weekStart}
            onChange={(e) => setWeekStart(e.target.value)}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
          />
        }
      />
      <PageContent>
        <div className="mb-5 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <form onSubmit={addManual} className="flex flex-col gap-3 sm:flex-row">
            <input
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              placeholder="E1 Company Name or RCE Company Name"
              className="min-h-[44px] flex-1 rounded-lg border border-gray-300 px-3 text-sm focus:border-brand-orange focus:outline-none focus:ring-2 focus:ring-brand-orange/20"
            />
            <Button type="submit" loading={saving} disabled={!entry.trim() || saving}>Add from Salesforce</Button>
          </form>
          <p className="mt-2 text-xs text-ink-muted">
            Enter the account name as stored in Salesforce. Website, industry, country, city, tier, and group fill automatically when available.
          </p>
        </div>

        {error && <Alert variant="danger" onDismiss={() => setError(null)}>{error}</Alert>}
        {message && <Alert variant="ok" onDismiss={() => setMessage(null)}>{message}</Alert>}

        <div className="mb-4 flex flex-wrap gap-2">
          <Button onClick={prepareAllRces} disabled={preparingRces.size > 0 || counts.rce === 0}>Prepare RCE Drafts</Button>
          <Button onClick={prepareE1s} disabled={saving || counts.e1 === 0}>Prepare E1 Sourcing Batch</Button>
          <Button variant="secondary" onClick={copyCsv} disabled={items.length === 0}>Copy CSV</Button>
        </div>

        {loading ? (
          <Spinner center label="Loading weekly outreach…" />
        ) : items.length === 0 ? (
          <Alert variant="info">No companies yet. RCEs appear after Open Task actions, E1s can be sent from Re-Contact, or add either type above.</Alert>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
            <table className="min-w-[1180px] w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  {['Type','Company','Industry','Country / City','Tier','Group','Source','RCE','Status','Draft','Notes',''].map((h) => <th key={h} className="px-3 py-3">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((item) => (
                  <tr key={item.id} className="align-top">
                    <td className="px-3 py-3 font-semibold text-brand-orange">{item.outreach_type}</td>
                    <td className="px-3 py-3 font-medium text-ink">
                      {item.account_url ? <a className="underline" href={item.account_url} target="_blank" rel="noreferrer">{item.account_name}</a> : item.account_name}
                      {item.website && <div><a className="text-xs text-ink-muted underline" href={item.website.startsWith('http') ? item.website : `https://${item.website}`} target="_blank" rel="noreferrer">website</a></div>}
                    </td>
                    <td className="px-3 py-3">{item.industry || '—'}</td>
                    <td className="px-3 py-3">{[item.country, item.city].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="px-3 py-3">{item.tier || '—'}</td>
                    <td className="px-3 py-3">{item.group_name || '—'}</td>
                    <td className="px-3 py-3 capitalize">{item.source}</td>
                    <td className="px-3 py-3">{item.rce_days ? `${item.rce_days}d` : '—'}</td>
                    <td className="px-3 py-3">
                      <select value={item.status} onChange={(e) => updateRow(item, { status: e.target.value as WeeklyOutreachStatus })} className="rounded border border-gray-300 bg-white px-2 py-1.5 text-xs">
                        {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                      </select>
                      {item.sourcing_job_id && <div className="mt-1"><Link className="text-xs underline" href={`/sourcing?jobId=${item.sourcing_job_id}`}>Open sourcing run</Link></div>}
                    </td>
                    <td className="px-3 py-3 w-64">
                      {item.outreach_type === "RCE" && !item.draft && (
                        <Button size="sm" variant="secondary" loading={preparingRces.has(item.id)} onClick={() => prepareRce(item)}>Prepare</Button>
                      )}
                      {item.draft && (
                        <details className="text-xs">
                          <summary className="cursor-pointer font-semibold text-brand-orange">View draft</summary>
                          {item.context_summary && <p className="mt-2 text-ink-muted">{item.context_summary}</p>}
                          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 font-sans text-ink">{item.draft}</pre>
                          <button type="button" onClick={() => navigator.clipboard.writeText(item.draft ?? "")} className="mt-1 font-medium underline">Copy draft</button>
                        </details>
                      )}
                    </td>
                    <td className="px-3 py-3"><input defaultValue={item.notes ?? ''} onBlur={(e) => updateRow(item, { notes: e.target.value || null })} className="w-48 rounded border border-gray-200 px-2 py-1.5 text-xs" placeholder="Trip, angle, reminder…" /></td>
                    <td className="px-3 py-3"><button onClick={() => removeRow(item)} className="text-xs font-medium text-red-600 hover:underline">Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageContent>
    </>
  );
}
