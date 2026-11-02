"use client";

/**
 * Discovery candidates inside the Outreach module: new companies FindAll
 * found that are not in Salesforce. Push creates the Salesforce Account and
 * the Weekly Outreach row (the only write, on click). Same row shape as the
 * Outreach list, tagged Discovery.
 */
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { Button } from "@/app/components/ui/Button";
import { staffLine, type CompanyStaff } from "@/lib/pdl";

type Candidate = {
  id: string;
  thesis_id: string | null;
  name: string;
  website: string | null;
  domain: string;
  description: string | null;
  citations: Array<{ url: string; title?: string | null }>;
  reasoning: Record<string, string>;
  found_week: string;
  status: "new" | "pushed" | "skipped" | "in_salesforce";
  staff: CompanyStaff | null;
  skip_reason: string | null;
};
type Thesis = { id: string; name: string };
type Payload = { items: Candidate[]; theses: Thesis[]; settings: { pushesPerWeek: number; paused: boolean }; pushed: number; lastRun: { summary: string; at: string } | null };

const SKIP_REASONS = ["Not software", "Services-heavy", "Wrong end market", "Acquired or backed", "Wrong size", "Wrong geography", "Other"];

export default function DiscoveryPanel({ onPushed, onCount }: { onPushed?: () => void; onCount?: (n: number) => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [skipFor, setSkipFor] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/discovery");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not load Discovery");
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load Discovery");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const thesisName = useMemo(() => new Map((data?.theses ?? []).map((t) => [t.id, t.name])), [data]);
  const fresh = useMemo(() => (data?.items ?? []).filter((c) => c.status === "new"), [data]);
  const done = useMemo(() => (data?.items ?? []).filter((c) => c.status !== "new"), [data]);
  useEffect(() => onCount?.(fresh.length), [fresh.length, onCount]);

  async function act(c: Candidate, action: "push" | "skip" | "reopen", reason?: string) {
    setBusy(c.id);
    setError(null);
    try {
      const res = await fetch("/api/discovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id: c.id, reason }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save");
      setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === c.id ? json.item : x)), pushed: d.pushed + (action === "push" ? 1 : 0) } : d));
      setSkipFor(null);
      if (action === "push") {
        onPushed?.();
        setNotice(`${c.name} created in Salesforce and added to Weekly Outreach.${json.note ? ` ${json.note}` : ""} Add the contact in the send queue.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(null);
    }
  }

  if (!data && !error) return <p className="text-sm text-ink-secondary">Loading…</p>;
  const quota = data ? `${data.pushed} of ${data.settings.pushesPerWeek} pushed this week` : "";
  const list = showDone ? done : fresh;

  return (
    <div>
      <p className="mb-3 text-sm text-ink-secondary">
        {quota}
        {data?.settings.paused ? " · Discovery is paused" : ""}
        {" · "}
        <Link href="/discovery" className="text-info no-underline hover:underline">Theses and limits</Link>
        {done.length > 0 ? (
          <>
            {" · "}
            <button type="button" onClick={() => setShowDone((v) => !v)} className="text-info hover:underline">
              {showDone ? `New (${fresh.length})` : `Pushed and skipped (${done.length})`}
            </button>
          </>
        ) : null}
      </p>
      {error ? <p className="mb-4 rounded-sm border border-danger bg-white px-3 py-2 text-sm text-ink">{error}</p> : null}
      {notice ? <p className="mb-4 text-sm text-ink-secondary">{notice}</p> : null}
      {list.length === 0 ? (
        <p className="text-sm text-ink-secondary">
          {showDone ? "Nothing here." : data?.lastRun ? `Nothing new. Last run ${new Date(data.lastRun.at).toLocaleDateString()}: ${data.lastRun.summary}` : "Nothing yet. Discovery runs Sunday night once it is switched on."}
        </p>
      ) : (
        <div className="rounded-md border border-line bg-white">
          {list.map((c) => {
            const isOpen = c.status === "new";
            const stop = (e: MouseEvent) => e.stopPropagation();
            const expanded = open === c.id;
            return (
              <div key={c.id} className="border-b border-line last:border-b-0">
                <div className="flex items-start gap-3 px-4 py-3 hover:bg-surface-3 sm:items-center">
                  <div role="button" tabIndex={0} onClick={() => setOpen(expanded ? null : c.id)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(expanded ? null : c.id); }} className="min-w-0 flex-1 cursor-pointer select-none">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[15px] font-medium text-ink">{c.name}</span>
                      {c.website ? (
                        <a href={c.website} target="_blank" rel="noreferrer" onClick={stop} className="text-[13px] text-info no-underline hover:underline">{c.domain}</a>
                      ) : null}
                      <span className="text-[12px] text-ink-muted">Discovery · {thesisName.get(c.thesis_id ?? "") ?? "thesis"}</span>
                    </div>
                    {c.description ? <p className="text-[13px] text-ink-secondary">{c.description}</p> : null}
                    <p className="flex items-center gap-1 text-[13px] text-ink-secondary">
                      <span className={c.staff?.flag ? "text-warn" : ""}>{c.staff?.flag ?? staffLine(c.staff)}</span>
                      <ChevronDown size={14} strokeWidth={1.5} className={`shrink-0 text-ink-muted transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
                    </p>
                    {!isOpen ? <p className="mt-0.5 text-[13px] text-ink-muted">{c.status === "pushed" ? "Pushed" : `Skipped${c.skip_reason ? `: ${c.skip_reason}` : ""}`}</p> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {isOpen ? (
                      <>
                        <Button size="sm" loading={busy === c.id} onClick={() => void act(c, "push")}>Push</Button>
                        <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => setSkipFor(skipFor === c.id ? null : c.id)}>Skip</Button>
                      </>
                    ) : c.status === "skipped" ? (
                      <Button size="sm" variant="ghost" loading={busy === c.id} onClick={() => void act(c, "reopen")}>Put back</Button>
                    ) : null}
                  </div>
                </div>
                {skipFor === c.id && isOpen ? (
                  <div className="flex flex-wrap gap-1.5 border-t border-line bg-surface-3 px-4 py-2">
                    {SKIP_REASONS.map((r) => (
                      <button key={r} type="button" disabled={busy === c.id} onClick={() => void act(c, "skip", r)} className="rounded-sm border border-line bg-white px-2 py-1 text-[13px] text-ink hover:bg-surface-3">{r}</button>
                    ))}
                  </div>
                ) : null}
                {expanded ? (
                  <div className="border-t border-line bg-surface-3 px-4 py-3 text-[13px] text-ink-secondary">
                    {c.staff?.found ? <p>{staffLine(c.staff)}{c.staff.total ? ` (${c.staff.total} total)` : ""}{c.staff.city ? ` · HQ ${[c.staff.city, c.staff.country].filter(Boolean).join(", ")}` : ""}</p> : null}
                    {Object.entries(c.reasoning).slice(0, 5).map(([k, v]) => (
                      <p key={k} className="mt-1"><span className="text-ink">{k.replace(/_/g, " ")}:</span> {v}</p>
                    ))}
                    {c.citations.length ? (
                      <p className="mt-1">
                        <span className="text-ink">Sources:</span>{" "}
                        {c.citations.map((s, i) => (
                          <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="text-info no-underline hover:underline">{i ? " · " : ""}{s.title || new URL(s.url).hostname}</a>
                        ))}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
