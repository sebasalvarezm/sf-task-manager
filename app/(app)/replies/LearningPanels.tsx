"use client";

import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip } from "recharts";
import { Card } from "@/app/components/ui/Card";
import { Badge } from "@/app/components/ui/Badge";
import { Button } from "@/app/components/ui/Button";
import type { FactorResult, Trends, TrendSide } from "@/lib/outcomes-factors";
import type { FactorState, Snapshot } from "@/lib/outcomes-factors-store";

/**
 * What gets replies, the moving parts (Nov 2026): the last 4 weeks against
 * the 4 before, factor tests with their verdicts, proposals waiting on Seb,
 * and one line per rebuild. Numbers come from lib/outcomes-factors.ts.
 */

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const shortDate = (s: string) => new Date(s.length === 10 ? `${s}T00:00:00` : s).toLocaleDateString("en-CA", { month: "short", day: "numeric" });

// ── Last 4 weeks ────────────────────────────────────────────────────────────

export function TrendsCard({ trends }: { trends: Trends }) {
  const [who, setWho] = useState<"you" | "team">("you");
  const side: TrendSide = trends[who];
  const metrics: Array<{ key: string; label: string; now: number; before: number; fmt: (x: number) => string; series: number[]; note: string }> = [
    { key: "reply", label: "Reply rate (14 days)", now: side.last4.replyRate14, before: side.prev4.replyRate14, fmt: pct, series: side.weeks.map((w) => (w.sends ? w.replies14 / w.sends : 0)), note: "replies within 14 days of sending" },
    { key: "clean", label: "Clean replies per 100", now: side.last4.cleanPer100, before: side.prev4.cleanPer100, fmt: (x) => x.toFixed(1), series: side.weeks.map((w) => (w.sends ? (w.cleanReplies14 / w.sends) * 100 : 0)), note: "from companies passing all 3 checks" },
    { key: "calls", label: "Calls booked", now: side.last4.calls, before: side.prev4.calls, fmt: (x) => String(Math.round(x)), series: side.weeks.map((w) => w.calls), note: "C1 or RCC, by the week they happened" },
    { key: "sends", label: "Tracked sends", now: side.last4.sends, before: side.prev4.sends, fmt: (x) => String(Math.round(x)), series: side.weeks.map((w) => w.sends), note: "sequence starts matched in Outreach" },
  ];
  const first = side.weeks.slice(-4)[0]?.week;
  const last = side.weeks[side.weeks.length - 1]?.week;
  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-medium text-ink">Last 4 weeks vs the 4 before</h2>
          <p className="mt-0.5 text-[13px] text-ink-muted">
            Sends from the weeks of {first ? shortDate(first) : ""} to {last ? shortDate(last) : ""}. Counts replies within 14 days (most replies come in the first two weeks), so a change shows up fast. Lines are the last 12 weeks.
          </p>
        </div>
        <div className="flex rounded-md border border-line p-0.5 text-[13px]">
          {(["you", "team"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setWho(k)} className={`rounded px-3 py-1 ${who === k ? "bg-surface-3 font-medium text-ink" : "text-ink-secondary"}`}>
              {k === "you" ? "You" : "Team"}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {metrics.map((m) => {
          const diff = m.now - m.before;
          const flat = m.before === 0 ? m.now === 0 : Math.abs(diff) / Math.abs(m.before) < 0.05;
          const Icon = flat ? Minus : diff > 0 ? ArrowUpRight : ArrowDownRight;
          const tone = flat ? "text-ink-muted" : diff > 0 ? "text-ok" : "text-danger";
          return (
            <div key={m.key} className="rounded-md border border-line p-3">
              <p className="text-[12px] text-ink-secondary">{m.label}</p>
              <p className="mt-1 flex items-baseline gap-1.5">
                <span className="text-xl font-medium tabular-nums text-ink">{m.fmt(m.now)}</span>
                <span className={`flex items-center text-[12px] tabular-nums ${tone}`}>
                  <Icon size={14} strokeWidth={2} aria-hidden />
                  {m.fmt(m.before)} before
                </span>
              </p>
              <div className="mt-1 h-8">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={m.series.map((v, i) => ({ v, w: side.weeks[i]?.week }))} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
                    <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6, border: "1px solid #E7E5E0", padding: "2px 6px" }} formatter={(v: number) => [m.fmt(v), ""]} labelFormatter={(_, p) => `Week of ${(p?.[0]?.payload as { w?: string } | undefined)?.w ?? ""}`} />
                    <Line type="monotone" dataKey="v" stroke="#2F6B3F" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="text-[11px] text-ink-muted">{m.note}</p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── Factor tests ────────────────────────────────────────────────────────────

const VERDICT: Record<FactorResult["verdict"], { label: string; variant: "ok" | "warn" | "neutral" | "info" }> = {
  act: { label: "Act on it", variant: "ok" },
  promising: { label: "Promising", variant: "warn" },
  nothing: { label: "Nothing there", variant: "neutral" },
  thin: { label: "Not enough data", variant: "neutral" },
};

function FactorRowView({ r, history, isNew }: { r: FactorResult; history: Array<{ testedAt: string; effectPer100: number | null }>; isNew: boolean }) {
  const [open, setOpen] = useState(false);
  const v = VERDICT[r.verdict];
  const effect = r.effectPer100 == null ? null : `${r.effectPer100 >= 0 ? "+" : ""}${r.effectPer100.toFixed(1)} per 100`;
  return (
    <li className="border-b border-line px-4 py-3 last:border-b-0">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-start justify-between gap-3 text-left">
        <span className="min-w-0">
          <span className="text-[14px] text-ink">{r.label}</span>
          {isNew ? <Badge variant="info" className="ml-2">New</Badge> : null}
          <span className="block text-[12px] text-ink-muted">{r.question}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant={v.variant}>{r.verdict === "act" ? `${v.label}: ${r.direction === "up" ? "do more" : "avoid"}` : v.label}</Badge>
          {effect ? <span className={`text-[12px] tabular-nums ${r.verdict === "act" ? (r.direction === "up" ? "text-ok" : "text-danger") : "text-ink-muted"}`}>{effect}</span> : null}
        </span>
      </button>
      {open ? (
        <div className="mt-2 space-y-1 text-[13px] text-ink-secondary">
          <p>{r.sentence}</p>
          {r.youA && r.youB ? <p className="text-ink-muted">Your own sends: {pct(r.youA.rate)} of {r.youA.sends} vs {pct(r.youB.rate)} of {r.youB.sends} (raw, too few to test on their own).</p> : null}
          {history.length > 1 ? (
            <p className="text-ink-muted">
              Over time: {history.slice(-6).map((h) => `${shortDate(h.testedAt)} ${h.effectPer100 == null ? "n/a" : `${h.effectPer100 >= 0 ? "+" : ""}${h.effectPer100.toFixed(1)}`}`).join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function FactorTestsCard({ state, onChange, canDecide }: { state: FactorState; onChange: () => void; canDecide: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showRest, setShowRest] = useState(false);
  const entries = Object.values(state.results ?? {});
  const lastRun = state.testedAt ? state.testedAt.slice(0, 10) : null;
  const isNew = (e: (typeof entries)[number]) => !!lastRun && e.firstTestedAt >= new Date(Date.parse(lastRun) - 6 * 86_400_000).toISOString().slice(0, 10) && e.history.length <= 1;
  const order = (a: (typeof entries)[number], b: (typeof entries)[number]) => Math.abs(b.latest.effectPer100 ?? 0) - Math.abs(a.latest.effectPer100 ?? 0);
  const act = entries.filter((e) => e.latest.verdict === "act").sort(order);
  const promising = entries.filter((e) => e.latest.verdict === "promising").sort(order);
  const rest = entries.filter((e) => e.latest.verdict === "nothing" || e.latest.verdict === "thin").sort(order);
  const waiting = (state.proposals ?? []).filter((p) => p.status === "proposed");

  async function decide(id: string, decision: "approve" | "reject") {
    setBusy(id);
    setNote(null);
    try {
      const res = await fetch("/api/outcomes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "decide_factor", id, decision }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Failed");
      setNote(decision === "approve" ? "Tested on the current data; result below. It is re-tested at every Sunday rebuild." : "Rejected.");
      onChange();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  const list = (items: typeof entries) => (
    <ul>
      {items.map((e) => (
        <FactorRowView key={e.latest.id} r={e.latest} history={e.history} isNew={isNew(e)} />
      ))}
    </ul>
  );

  return (
    <Card padded={false} className="mb-6">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-[15px] font-medium text-ink">Factor tests</h2>
        <p className="mt-0.5 text-[13px] text-ink-muted">
          Each factor is tested after accounting for country, company age, size, quality, sender and contact history, so it cannot look good just because of who it went to. &ldquo;Act on it&rdquo; needs a strong result that also holds in both older and newer sends. Re-tested at every Sunday rebuild{lastRun ? `; last run ${shortDate(lastRun)}` : ""}. Tap a row for the numbers.
        </p>
        {note ? <p className="mt-1 text-[13px] text-ink-secondary">{note}</p> : null}
      </div>

      {waiting.length > 0 ? (
        <div className="border-b border-line bg-surface-3 px-4 py-3">
          <p className="text-[12px] uppercase tracking-wide text-ink-muted">Proposed, waiting on you</p>
          <ul className="mt-1 space-y-2">
            {waiting.map((p) => (
              <li key={p.spec.id} className="flex flex-wrap items-start justify-between gap-3">
                <span className="min-w-0 flex-1">
                  <span className="text-[14px] text-ink">{p.spec.label}</span>
                  <span className="block text-[13px] text-ink-secondary">{p.spec.question}</span>
                  {p.spec.why ? <span className="block text-[12px] text-ink-muted">Why: {p.spec.why}</span> : null}
                  <span className="block text-[12px] text-ink-muted">Compares &ldquo;{p.spec.aLabel}&rdquo; with &ldquo;{p.spec.bLabel}&rdquo;</span>
                </span>
                {canDecide ? (
                  <span className="flex shrink-0 gap-2">
                    <Button size="sm" loading={busy === p.spec.id} disabled={busy !== null} onClick={() => void decide(p.spec.id, "approve")}>Approve</Button>
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void decide(p.spec.id, "reject")}>Reject</Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {entries.length === 0 ? <p className="px-4 py-3 text-[13px] text-ink-muted">No tests yet. They run with the next rebuild.</p> : null}
      {act.length ? (
        <div>
          <p className="px-4 pt-3 text-[12px] uppercase tracking-wide text-ink-muted">Act on it</p>
          {list(act)}
        </div>
      ) : null}
      {promising.length ? (
        <div>
          <p className="px-4 pt-3 text-[12px] uppercase tracking-wide text-ink-muted">Promising, watching</p>
          {list(promising)}
        </div>
      ) : null}
      {rest.length ? (
        <div>
          <button type="button" onClick={() => setShowRest((s) => !s)} className="w-full px-4 py-3 text-left text-[13px] text-info">
            {showRest ? "Hide" : "Show"} {rest.length} with nothing there or not enough data
          </button>
          {showRest ? list(rest) : null}
        </div>
      ) : null}
    </Card>
  );
}

// ── One line per rebuild ────────────────────────────────────────────────────

export function HistoryCard({ history }: { history: Snapshot[] }) {
  const [open, setOpen] = useState(false);
  if (history.length === 0) return null;
  const rows = [...history].reverse();
  return (
    <Card padded={false} className="mb-6">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full px-4 py-3 text-left">
        <span className="text-[15px] font-medium text-ink">Rebuild history</span>
        <span className="ml-2 text-[13px] text-ink-muted">{history.length} rebuild{history.length === 1 ? "" : "s"} · {open ? "hide" : "show"}</span>
      </button>
      {open ? (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-ink-muted">
                <th className="px-4 py-2 font-normal">Built</th>
                <th className="px-2 py-2 text-right font-normal">You, 14-day reply</th>
                <th className="px-2 py-2 text-right font-normal">You, calls (4 wks)</th>
                <th className="px-2 py-2 text-right font-normal">Team, 14-day reply</th>
                <th className="px-2 py-2 text-right font-normal">12-month reply rate</th>
                <th className="px-4 py-2 font-normal">Acting on</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.at} className="border-t border-line text-ink-secondary">
                  <td className="px-4 py-2">{shortDate(s.at)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{s.you ? pct(s.you.last4.replyRate14) : "–"}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{s.you ? s.you.last4.calls : "–"}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{s.team ? pct(s.team.last4.replyRate14) : "–"}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{pct(s.replyRate)}</td>
                  <td className="px-4 py-2 text-ink-muted">{s.act.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
