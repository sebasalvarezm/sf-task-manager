"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";
import { Button } from "@/app/components/ui/Button";
import { Card } from "@/app/components/ui/Card";
import { Alert } from "@/app/components/ui/Alert";
import { Badge } from "@/app/components/ui/Badge";
import { Spinner } from "@/app/components/ui/Spinner";
import { Table } from "@/app/components/ui/Table";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { MIN_LEVEL, type OutcomesReport, type FeatureReport, type LevelStat } from "@/lib/outcomes-analysis";

/**
 * What gets replies: every sequence start of the last year next to what
 * happened after it, and which facts known at send time moved the reply rate.
 * The numbers come from lib/outcomes-analysis.ts; the page only draws them.
 */

type Job = { id: string; status: string; progress?: { step?: string; pct?: number } | null } | null;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmtDate = (ymd: string | null) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" }) : "");

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return narrow;
}

export default function RepliesPage() {
  const narrow = useNarrow();
  const [report, setReport] = useState<OutcomesReport | null>(null);
  const [job, setJob] = useState<Job>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [openFeature, setOpenFeature] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/outcomes", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load");
      setReport(data.report ?? null);
      setJob(data.job ?? null);
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

  // Poll while a build runs.
  useEffect(() => {
    if (!job) return;
    const id = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(id);
  }, [job, load]);

  async function start(skipMailings: boolean) {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/outcomes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skipMailings }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not start the build");
      setJob({ id: data.jobId, status: data.status });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the build");
    } finally {
      setStarting(false);
    }
  }

  const ranked = useMemo(() => (report ? [...report.features].sort((a, b) => b.spread - a.spread) : []), [report]);

  return (
    <>
      <PageHeader
        title="What gets replies"
        subtitle={
          report
            ? `${report.sends.toLocaleString()} sequence starts, ${fmtDate(report.firstSend)} to ${fmtDate(report.lastSend)} · built ${new Date(report.builtAt).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
            : "Every E1, RCE1 and D-E1 of the last year, next to whether it got a reply or a call."
        }
        actions={
          <div className="flex items-center gap-2">
            {report ? (
              <Button variant="ghost" size="sm" disabled={!!job || starting} onClick={() => void start(true)} title="Re-match Salesforce without re-reading Outreach (faster)">
                Quick rebuild
              </Button>
            ) : null}
            <Button size="sm" loading={starting} disabled={!!job} onClick={() => void start(false)} leftIcon={<RefreshCw className="h-4 w-4" strokeWidth={1.75} />}>
              {report ? "Rebuild" : "Build"}
            </Button>
          </div>
        }
      />
      <PageContent>
        {error ? <Alert variant="danger" className="mb-4" onDismiss={() => setError(null)}>{error}</Alert> : null}
        {job ? (
          <Alert variant="info" className="mb-4">
            Building… {job.progress?.step ?? "starting"}{typeof job.progress?.pct === "number" ? ` (${job.progress.pct}%)` : ""}. The first build reads a year of Outreach mail and takes a few minutes; this page updates on its own.
          </Alert>
        ) : null}

        {loading ? <Spinner center label="Loading…" /> : null}

        {!loading && !report && !job ? (
          <Card>
            <p className="text-sm text-ink-secondary">
              Nothing built yet. Press Build to pull the last twelve months of sends from Salesforce, match each one to its Outreach mailing, and work out what predicted a reply.
            </p>
          </Card>
        ) : null}

        {report && report.sends > 0 && report.matchedToOutreach === 0 ? (
          <Alert variant="warn" className="mb-4" title="No Outreach mailings matched">
            Salesforce sends loaded, but none could be joined to an Outreach mailing, so reply rates are all zero. Until that's fixed only the call rate means anything.
          </Alert>
        ) : null}

        {report ? (
          <>
            {/* Headline numbers */}
            <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
              <Stat label="Sequence starts" value={report.sends.toLocaleString()} note={`${report.matchedToOutreach.toLocaleString()} tracked in Outreach · ${report.untracked.toLocaleString()} untracked`} />
              <Stat label="Reply rate (tracked)" value={pct(report.replyRate)} note={`${report.replies.toLocaleString()} replies within 45 days`} />
              <Stat label="Reply → call" value={pct(report.replyToCall)} note="replies that became a C1 or RCC within 90 days" />
              <Stat label="Clean replies per 100 sends" value={report.cleanRepliesPer100.toFixed(1)} note="replies from companies passing all 3 BS checks" />
              <Stat
                label="Quality of tracked sends"
                value={`${report.matchedToOutreach ? Math.round((report.qualityMix.clean / report.matchedToOutreach) * 100) : 0}% clean`}
                note={`${report.qualityMix.potential.toLocaleString()} potential · ${report.qualityMix.flagged.toLocaleString()} flagged`}
              />
              <Stat
                label="Can we predict replies?"
                value={report.model.auc == null ? "n/a" : report.model.auc.toFixed(2)}
                note={report.model.auc == null ? "needs more sends" : "0.5 = coin flip · 1.0 = perfect"}
              />
            </div>

            {/* Sender scorecard */}
            {report.senders.length > 0 ? (
              <Card padded={false} className="mb-6">
                <div className="px-4 pt-4">
                  <h2 className="text-[15px] font-medium text-ink">Sender scorecard</h2>
                  <p className="mt-0.5 text-[13px] text-ink-muted">Ranked on replies from clean companies per 100 sends. Raw reply rate is shown for reference only; it rewards emailing small or off-profile companies.</p>
                </div>
                <div className="mt-3 overflow-x-auto">
                  <Table>
                    <Table.Head>
                      <Table.HeadRow>
                        <Table.HeadCell>Sender</Table.HeadCell>
                        <Table.HeadCell className="text-right">Sends</Table.HeadCell>
                        <Table.HeadCell className="text-right">Clean share</Table.HeadCell>
                        <Table.HeadCell className="text-right">Clean replies / 100</Table.HeadCell>
                        <Table.HeadCell className="text-right">Reply → call</Table.HeadCell>
                        <Table.HeadCell className="text-right">Calls</Table.HeadCell>
                        <Table.HeadCell className="text-right text-ink-muted">Raw reply</Table.HeadCell>
                      </Table.HeadRow>
                    </Table.Head>
                    <Table.Body>
                      {report.senders.map((p, i) => (
                        <Table.Row key={p.sender}>
                          <Table.Cell className="font-medium text-ink">{i + 1}. {p.sender}</Table.Cell>
                          <Table.Cell className="text-right tabular-nums text-ink-secondary">{p.sends.toLocaleString()}</Table.Cell>
                          <Table.Cell className={`text-right tabular-nums ${p.cleanShare < 0.6 ? "text-warn" : "text-ink-secondary"}`}>{Math.round(p.cleanShare * 100)}%</Table.Cell>
                          <Table.Cell className="text-right tabular-nums font-medium text-ink">{p.cleanPer100.toFixed(1)}</Table.Cell>
                          <Table.Cell className="text-right tabular-nums text-ink-secondary">{p.replyToCall == null ? "–" : `${Math.round(p.replyToCall * 100)}%`}</Table.Cell>
                          <Table.Cell className="text-right tabular-nums text-ink-secondary">{p.calls}</Table.Cell>
                          <Table.Cell className="text-right tabular-nums text-ink-muted">{pct(p.replyRate)}</Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                </div>
              </Card>
            ) : null}

            {/* Weekly trend */}
            {report.weekly.length >= 4 ? (
              <Card className="mb-6">
                <h2 className="text-[15px] font-medium text-ink">Clean replies per 100 sends, by week</h2>
                <p className="mb-3 mt-0.5 text-[13px] text-ink-muted">Tracked sends only, weeks with {MIN_LEVEL}+ sends. The last six weeks are still collecting replies, so they read low for now.</p>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={report.weekly.map((w) => ({ ...w, label: new Date(`${w.week}T00:00:00`).toLocaleDateString("en-CA", { month: "short", day: "numeric" }), cleanPer100: Number(w.cleanPer100.toFixed(1)), replyPct: Number((w.replyRate * 100).toFixed(1)) }))} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                    <CartesianGrid stroke="#E7E5E0" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#5F5E5A" }} axisLine={false} tickLine={false} interval={narrow ? Math.max(0, Math.ceil(report.weekly.length / 5) - 1) : "preserveStartEnd"} minTickGap={12} />
                    <YAxis tick={{ fontSize: 11, fill: "#5F5E5A" }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #E7E5E0" }} formatter={(v: number, name: string) => [name === "cleanPer100" ? v.toFixed(1) : `${v}%`, name === "cleanPer100" ? "Clean replies / 100" : "Raw reply rate"]} labelFormatter={(l, payload) => `Week of ${l} · ${(payload?.[0]?.payload as { sends?: number } | undefined)?.sends ?? ""} sends`} />
                    <Line type="monotone" dataKey="cleanPer100" stroke="#2F6B3F" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="replyPct" stroke="#B9B6AE" strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
                  </LineChart>
                </ResponsiveContainer>
              </Card>
            ) : null}

            {/* Findings */}
            <Card className="mb-6">
              <h2 className="mb-2 text-[15px] font-medium text-ink">What the numbers say</h2>
              <p className="mb-3 text-[13px] text-ink-muted">
                Patterns are learned on sends before {fmtDate(report.holdoutFrom)} and checked on the ones after. {report.model.verdict}
              </p>
              {report.findings && report.findings.length > 0 ? (
                <ul className="space-y-2">
                  {report.findings.map((f, i) => (
                    <li key={i} className="flex gap-2 text-sm text-ink">
                      <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-secondary">Not enough sends yet to say anything with confidence. The tables below still show the raw rates.</p>
              )}
            </Card>

            {/* One card per feature, strongest spread first */}
            <div className="grid gap-4 md:grid-cols-2">
              {ranked.map((f) => (
                <FeatureCard key={f.key} feature={f} base={report.replyRate} open={openFeature === f.key} onToggle={() => setOpenFeature((k) => (k === f.key ? null : f.key))} />
              ))}
            </div>

            <p className="mt-6 text-[13px] text-ink-muted">
              How to read a row: reply rate with its 95% range, lift against the {pct(report.replyRate)} tracked average, whether the direction held on the most recent quarter, then the quality line: what share of the sends went to clean companies, replies from clean companies per 100 sends (the number that rewards quality over volume), and how many replies became calls. Rows under {MIN_LEVEL} sends are shown but not trusted. Only sends matched to an Outreach mailing are counted; a reply anywhere in the sequence within 45 days counts for the start that opened it.
            </p>
          </>
        ) : null}
      </PageContent>
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Card>
      <p className="text-[13px] text-ink-secondary">{label}</p>
      <p className="mt-1 text-2xl font-medium tabular-nums text-ink">{value}</p>
      <p className="mt-1 text-[12px] text-ink-muted">{note}</p>
    </Card>
  );
}

function FeatureCard({ feature, base, open, onToggle }: { feature: FeatureReport; base: number; open: boolean; onToggle: () => void }) {
  const solid = feature.levels.filter((l) => l.sends >= MIN_LEVEL);
  const shown = open ? feature.levels : feature.levels.slice(0, 6);
  const maxRate = Math.max(base, ...solid.map((l) => l.high), 0.0001);
  return (
    <Card padded={false}>
      <div className="flex items-baseline justify-between px-4 pt-4">
        <h3 className="text-[15px] font-medium text-ink">{feature.label}</h3>
        <span className="text-[12px] text-ink-muted">{solid.length >= 2 ? `${pct(feature.spread)} spread` : "too few to compare"}</span>
      </div>
      <div className="px-4 pb-3 pt-2">
        {shown.length === 0 ? <p className="py-3 text-sm text-ink-muted">No data for this one yet.</p> : null}
        {shown.map((l) => (
          <LevelRow key={l.level} level={l} base={base} maxRate={maxRate} />
        ))}
        {feature.levels.length > 6 ? (
          <button type="button" onClick={onToggle} className="mt-1 text-[13px] text-info hover:underline">
            {open ? "Show fewer" : `Show all ${feature.levels.length}`}
          </button>
        ) : null}
      </div>
    </Card>
  );
}

function LevelRow({ level, base, maxRate }: { level: LevelStat; base: number; maxRate: number }) {
  const thin = level.sends < MIN_LEVEL;
  const above = level.rate >= base;
  const width = Math.min(100, (level.rate / maxRate) * 100);
  const baseX = Math.min(100, (base / maxRate) * 100);
  return (
    <div className={`py-2 ${thin ? "opacity-60" : ""}`}>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="truncate text-ink">{level.level}</span>
        <span className="shrink-0 tabular-nums text-ink-secondary">
          {level.sends.toLocaleString()} sends · <span className={thin ? "" : above ? "text-ok" : "text-danger"}>{pct(level.rate)}</span>
          <span className="text-ink-muted"> ({pct(level.low)} to {pct(level.high)})</span>
        </span>
      </div>
      <div className="relative mt-1 h-1.5 w-full rounded-sm bg-surface-4">
        <div className={`h-1.5 rounded-sm ${thin ? "bg-ink-muted" : above ? "bg-ok" : "bg-danger"}`} style={{ width: `${width}%` }} />
        <div className="absolute top-[-2px] h-[10px] w-px bg-ink" style={{ left: `${baseX}%` }} title="Average" />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-muted">
        <span>{level.lift ? `${level.lift.toFixed(2)}x average` : ""}</span>
        {level.holds === true ? <Badge variant="ok" size="sm">Held on recent quarter</Badge> : null}
        {level.holds === false ? <Badge variant="warn" size="sm">Did not hold recently</Badge> : null}
        {level.holds == null && !thin ? <span>too few recent sends to check</span> : null}
      </div>
      {!thin ? (
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] tabular-nums text-ink-muted">
          <span>{Math.round((level.cleanSends / level.sends) * 100)}% clean companies</span>
          <span>· <span className="text-ink-secondary">{((level.cleanReplies / level.sends) * 100).toFixed(1)}</span> clean replies / 100 sends</span>
          <span>· {level.replies > 0 ? `${Math.round((level.callsAfterReply / level.replies) * 100)}% of replies → call` : "no replies"}</span>
          {level.calls > 0 ? <span>· {level.calls} calls</span> : null}
        </div>
      ) : null}
    </div>
  );
}
