"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LabelList,
} from "recharts";
import RangePicker from "../components/RangePicker";
import ConnectSalesforce from "../components/ConnectSalesforce";
import ActionCard, { ActionRow } from "../components/ActionCard";
import Heatmap from "../components/Heatmap";
import { RangePreset, computeRange } from "@/lib/date-ranges";
import { CDM_OWNER_NAMES } from "@/lib/salesforce-stats";
import { HeatmapData, EnrichedMultiOpen } from "@/lib/analytics-derivations";

// ── Types mirroring API responses ────────────────────────────────────────────

type PersonBreakdown = {
  owner: string;
  e1: number;
  rce1: number;
  outreach: number;
  c1: number;
  f2f: number;
  openBRO: number;
};

type BucketRow = {
  bucketLabel: string;
  bucketStart: string;
  e1: number;
  rce1: number;
  c1: number;
  f2f: number;
};

type StageRow = { stage: string; total: number };
type OriginatorRow = { owner: string; total: number };

type StuckOpp = {
  id: string;
  name: string;
  accountName: string;
  stage: string;
  amount: number;
  daysStuck: number;
  lastStageChangeDate: string;
  owner: string;
};

type ConversionBlock = { outreach: number; c1: number; rate: number };

type StatsResponse = {
  kpis: {
    totalOutreach: number;
    e1: number;
    rce1: number;
    totalCalls: number;
    totalF2F: number;
    totalOpenBRO: number;
    f2fThisYear: number;
  };
  conversion: {
    team: ConversionBlock;
    byPerson: Array<{ owner: string } & ConversionBlock>;
  };
  byPerson: PersonBreakdown[];
  byBucket: BucketRow[];
  byStage: StageRow[];
  byOriginator: OriginatorRow[];
  stuckOpps: StuckOpp[];
};

type EngagementResponse = {
  heatmap: HeatmapData;
  multiOpens: EnrichedMultiOpen[];
  totals: { mailings: number; multiOpenCount: number };
  cdm?: {
    matchedOwners: string[];
    unmatchedOwners: string[];
    mailboxCount: number;
  };
  debug?: {
    rawCount: number;
    withDeliveredAt: number;
    withProspectId: number;
    countFilteredByMailbox: number;
    stateBreakdown: Record<string, number>;
    earliestCreatedAt: string | null;
    latestCreatedAt: string | null;
    countInRange: number;
    countBeforeRange: number;
    countAfterRange: number;
    sampleDates: string[];
    sampleRelationshipKeys: string[];
    requestedRange: { start: string; end: string };
  };
};

// ── Colors ───────────────────────────────────────────────────────────────────
const BLUE = "#6FA8F0";
const GREEN = "#8DD178";
const ORANGE = "#F2B84B";
const NAVY = "#1B2A4A";

// ── Formatters ───────────────────────────────────────────────────────────────

function firstName(full: string): string {
  return full.split(" ")[0];
}

function fmtMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

function fmtNumber(n: number): string {
  return n.toLocaleString();
}

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function daysAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const d = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (d <= 0) return "today";
  if (d === 1) return "1d ago";
  return `${d}d ago`;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function StatsPage() {
  const router = useRouter();
  const [preset, setPreset] = useState<RangePreset>("this_week");
  const [trailingN, setTrailingN] = useState<number>(4);

  const [sfConnected, setSfConnected] = useState<boolean | null>(null);
  const [outreachConnected, setOutreachConnected] = useState<boolean | null>(null);

  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [data, setData] = useState<StatsResponse | null>(null);

  const [engagementLoading, setEngagementLoading] = useState(false);
  const [engagementError, setEngagementError] = useState<string | null>(null);
  const [engagement, setEngagement] = useState<EngagementResponse | null>(null);

  const range = useMemo(
    () => computeRange(preset, new Date(), trailingN),
    [preset, trailingN]
  );

  // ── Connection checks ──────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const [sfRes, oRes] = await Promise.all([
          fetch("/api/salesforce/status"),
          fetch("/api/outreach/status"),
        ]);
        const sfJson = sfRes.ok ? await sfRes.json() : { connected: false };
        const oJson = oRes.ok ? await oRes.json() : { connected: false };
        setSfConnected(Boolean(sfJson.connected));
        setOutreachConnected(Boolean(oJson.connected));
      } catch {
        setSfConnected(false);
        setOutreachConnected(false);
      }
    })();
  }, []);

  // ── Load stats + engagement when connected or range changes ────────────────
  useEffect(() => {
    if (sfConnected) loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sfConnected, preset, trailingN]);

  useEffect(() => {
    if (outreachConnected) loadEngagement();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outreachConnected, preset, trailingN]);

  async function loadStats() {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const params = new URLSearchParams({
        start: range.start,
        end: range.end,
        buckets: JSON.stringify(range.buckets),
      });
      const res = await fetch(`/api/salesforce/stats?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.error === "NOT_CONNECTED") {
          setSfConnected(false);
          return;
        }
        throw new Error(body.error ?? "Failed to load stats");
      }
      setData((await res.json()) as StatsResponse);
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setStatsLoading(false);
    }
  }

  async function loadEngagement() {
    setEngagementLoading(true);
    setEngagementError(null);
    try {
      const params = new URLSearchParams({
        start: range.start,
        end: range.end,
      });
      const res = await fetch(`/api/outreach/engagement?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.error === "OUTREACH_NOT_CONNECTED") {
          setOutreachConnected(false);
          return;
        }
        throw new Error(body.error ?? "Failed to load engagement");
      }
      setEngagement((await res.json()) as EngagementResponse);
    } catch (err) {
      setEngagementError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setEngagementLoading(false);
    }
  }

  async function handleSfDisconnect() {
    await fetch("/api/salesforce/status", { method: "DELETE" });
    setSfConnected(false);
    setData(null);
  }

  function handleRefresh() {
    if (sfConnected) loadStats();
    if (outreachConnected) loadEngagement();
  }

  // ── Derived chart data ─────────────────────────────────────────────────────

  const outreachByPersonData = useMemo(() => {
    if (!data) return [];
    return data.byPerson.map((p) => ({
      name: firstName(p.owner),
      Outreach: p.outreach,
    }));
  }, [data]);

  const e1VsRce1Data = useMemo(() => {
    if (!data) return [];
    return data.byPerson.map((p) => ({
      name: firstName(p.owner),
      E1: p.e1,
      RCE1: p.rce1,
    }));
  }, [data]);

  const callsF2FByPersonData = useMemo(() => {
    if (!data) return [];
    return data.byPerson.map((p) => ({
      name: firstName(p.owner),
      Calls: p.c1,
      F2F: p.f2f,
    }));
  }, [data]);

  const trendData = useMemo(() => {
    if (!data) return [];
    return data.byBucket.map((b) => ({
      name: b.bucketLabel,
      Outreach: b.e1 + b.rce1,
      Calls: b.c1,
      F2F: b.f2f,
    }));
  }, [data]);

  const originatorData = useMemo(() => {
    if (!data) return [];
    return data.byOriginator.map((o) => ({
      name: firstName(o.owner),
      Amount: o.total,
    }));
  }, [data]);

  const stageData = useMemo(() => {
    if (!data) return [];
    return data.byStage.map((s) => ({ name: s.stage, Amount: s.total }));
  }, [data]);

  const showTrend = range.buckets.length > 1;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header
        className="flex items-center justify-between px-8 py-4 shadow-lg"
        style={{ background: "var(--navy)" }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/")}
            className="text-gray-300 hover:text-white mr-3"
            aria-label="Back"
          >
            ←
          </button>
          <img src="/valstone-logo.png" alt="Valstone" className="h-8 w-auto rounded" />
          <span className="text-sm font-normal text-gray-300">
            Weekly Stats · CDM Group
          </span>
        </div>
        <div className="flex items-center gap-3">
          {outreachConnected !== null && (
            <span
              className={
                "inline-flex items-center gap-1.5 text-xs rounded-full px-3 py-1 border " +
                (outreachConnected
                  ? "text-green-400 bg-green-950/40 border-green-700"
                  : "text-amber-300 bg-amber-950/40 border-amber-700")
              }
            >
              <span
                className={
                  "w-1.5 h-1.5 rounded-full " +
                  (outreachConnected ? "bg-green-400" : "bg-amber-400")
                }
              />
              Outreach {outreachConnected ? "connected" : "not connected"}
            </span>
          )}
          {sfConnected !== null && (
            <ConnectSalesforce
              connected={sfConnected}
              onDisconnect={handleSfDisconnect}
            />
          )}
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 px-8 py-8 max-w-[1400px] w-full mx-auto">
        {/* Top controls */}
        <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
          <RangePicker
            value={preset}
            trailingN={trailingN}
            onChange={(p, n) => {
              setPreset(p);
              setTrailingN(n);
            }}
          />
          <div className="flex items-center gap-3">
            <button
              onClick={handleRefresh}
              className="text-sm font-medium text-navy bg-white border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50"
            >
              Refresh
            </button>
            <CdmTeamBadge />
          </div>
        </div>
        <p className="text-sm text-gray-500 mb-8">
          Showing <span className="font-medium text-navy">{range.label}</span>
        </p>

        {sfConnected === false && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 text-center mb-6">
            <p className="text-sm text-amber-700">
              Salesforce is not connected. Connect to see stats.
            </p>
          </div>
        )}

        {/* ── ACTIVITY SUMMARY ─────────────────────────────────────────────── */}
        <SectionHeader title="Activity Summary" color="bg-blue-500" />

        {sfConnected === true && statsLoading && !data && <LoadingSpinner />}
        {sfConnected === true && statsError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700 mb-6">
            {statsError}
          </div>
        )}

        {sfConnected === true && data && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-10">
              <KpiCard
                label="Total Outreach"
                sublabel={`${fmtNumber(data.kpis.e1)} E1 · ${fmtNumber(data.kpis.rce1)} RCE1`}
                value={fmtNumber(data.kpis.totalOutreach)}
              />
              <KpiCard
                label="Total Calls"
                sublabel="C1 completed"
                value={fmtNumber(data.kpis.totalCalls)}
              />
              <KpiCard
                label="Conversion"
                sublabel={`${fmtNumber(data.conversion.team.c1)} calls / ${fmtNumber(data.conversion.team.outreach)} outreach`}
                value={fmtPct(data.conversion.team.rate)}
                accent="text-green-600"
              />
              <KpiCard
                label="F2F This Year"
                sublabel={`${fmtNumber(data.kpis.totalF2F)} in selected range`}
                value={fmtNumber(data.kpis.f2fThisYear)}
              />
              <KpiCard
                label="Total Open BRO"
                sublabel="All stages combined"
                value={fmtMoney(data.kpis.totalOpenBRO)}
              />
            </div>

            {/* ── ACTION ITEMS ───────────────────────────────────────────── */}
            <SectionHeader title="Action Items" color="bg-red-500" />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-10">
              <ActionCard
                pill="FIX"
                tone="fix"
                value={fmtNumber(data.stuckOpps.length)}
                title="Stuck 30+ days in stage"
                subtitle={
                  data.stuckOpps.length === 0
                    ? "No opportunities flagged — pipeline is moving."
                    : `${data.stuckOpps.length} open opportunit${data.stuckOpps.length === 1 ? "y" : "ies"} without a stage change in 30+ days`
                }
              >
                {data.stuckOpps.slice(0, 10).map((o) => (
                  <ActionRow
                    key={o.id}
                    title={o.accountName}
                    subtitle={`${o.stage} · ${fmtMoney(o.amount)} · ${firstName(o.owner)}`}
                    right={<span className="text-red-600 font-semibold">{o.daysStuck}d</span>}
                  />
                ))}
              </ActionCard>

              <ActionCard
                pill="WARM"
                tone="warm"
                value={
                  engagement ? fmtNumber(engagement.totals.multiOpenCount) : "—"
                }
                title="Highly engaged — opened an email 3+ times"
                subtitle={
                  !outreachConnected
                    ? "Outreach not connected — connect to see warm leads."
                    : engagementError
                    ? engagementError
                    : engagementLoading
                    ? "Loading..."
                    : engagement
                    ? `${engagement.totals.multiOpenCount} prospect${engagement.totals.multiOpenCount === 1 ? "" : "s"} with a single email opened 3+ times` +
                      (engagement.cdm && engagement.cdm.unmatchedOwners.length > 0
                        ? ` · ⚠ couldn't find Outreach mailbox for: ${engagement.cdm.unmatchedOwners.join(", ")}`
                        : "")
                    : undefined
                }
              >
                {engagement &&
                  engagement.multiOpens.slice(0, 10).map((m) => (
                    <ActionRow
                      key={m.prospectId}
                      title={
                        `${m.firstName} ${m.lastName}`.trim() || "(unknown)"
                      }
                      subtitle={`${m.company || "—"} · sent ${daysAgo(m.sentAt)}`}
                      right={
                        <span className="text-amber-600 font-semibold">
                          {m.openCount} opens
                        </span>
                      }
                    />
                  ))}
              </ActionCard>
            </div>

            {/* ── TEAM BREAKDOWN ─────────────────────────────────────────── */}
            <SectionHeader title="Team Breakdown" color="bg-navy" />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
              <ChartCard title="Outreach by Person">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={outreachByPersonData} margin={{ top: 24, right: 16, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="Outreach" fill={BLUE} radius={[4, 4, 0, 0]}>
                      <LabelList dataKey="Outreach" position="top" style={{ fontSize: 12, fill: NAVY }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title={showTrend ? "Outreach Trend" : "E1 vs RCE1"}>
                {showTrend ? (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={trendData} margin={{ top: 24, right: 16, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                      <Tooltip />
                      <Bar dataKey="Outreach" fill={BLUE} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={e1VsRce1Data} margin={{ top: 24, right: 16, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="E1" fill={BLUE} radius={[4, 4, 0, 0]} />
                      <Bar dataKey="RCE1" fill={GREEN} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
              <ChartCard title="Calls (C1) + F2F by Person">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={callsF2FByPersonData} margin={{ top: 24, right: 16, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="Calls" fill={BLUE} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="F2F" fill={ORANGE} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="Conversion Rate by Person">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart
                    data={data.conversion.byPerson.map((p) => ({
                      name: firstName(p.owner),
                      Rate: parseFloat((p.rate * 100).toFixed(1)),
                    }))}
                    margin={{ top: 24, right: 16, left: 0, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `${v}%`} />
                    <Tooltip formatter={(v) => `${v}%`} />
                    <Bar dataKey="Rate" fill={GREEN} radius={[4, 4, 0, 0]}>
                      <LabelList dataKey="Rate" position="top" formatter={(v: number) => `${v}%`} style={{ fontSize: 12, fill: NAVY }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            {/* ── BEST SEND TIMES ────────────────────────────────────────── */}
            <SectionHeader title="Best Send Times (ET)" color="bg-green-500" />

            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 mb-10">
              {!outreachConnected ? (
                <p className="text-sm text-gray-500">
                  Connect Outreach.io to see the send-times heatmap.
                </p>
              ) : engagementLoading && !engagement ? (
                <p className="text-sm text-gray-500">Loading engagement data…</p>
              ) : engagementError ? (
                <p className="text-sm text-red-700">{engagementError}</p>
              ) : engagement && engagement.totals.mailings === 0 ? (
                <div>
                  <p className="text-sm text-gray-500">
                    No sends in this range yet. Try a wider range.
                  </p>
                  {engagement.debug && (
                    <pre className="text-xs text-gray-400 mt-3 bg-gray-50 rounded p-2 overflow-x-auto whitespace-pre-wrap">
                      {[
                        `Outreach returned ${engagement.debug.rawCount} raw mailings, ${engagement.debug.withDeliveredAt} with deliveredAt, ${engagement.debug.withProspectId} with prospectId.`,
                        `Requested: ${engagement.debug.requestedRange.start} → ${engagement.debug.requestedRange.end}`,
                        `createdAt span: ${engagement.debug.earliestCreatedAt ?? "—"} → ${engagement.debug.latestCreatedAt ?? "—"}`,
                        `In range: ${engagement.debug.countInRange} · Before: ${engagement.debug.countBeforeRange} · After: ${engagement.debug.countAfterRange}`,
                        `Relationship keys on first record: ${engagement.debug.sampleRelationshipKeys.join(", ") || "(none)"}`,
                        `Sample dates: ${engagement.debug.sampleDates.join(", ")}`,
                        `States: ${JSON.stringify(engagement.debug.stateBreakdown)}`,
                      ].join("\n")}
                    </pre>
                  )}
                </div>
              ) : engagement ? (
                <Heatmap data={engagement.heatmap} />
              ) : null}
            </div>

            {/* ── BRO PIPELINE ───────────────────────────────────────────── */}
            <SectionHeader
              title="BRO Pipeline"
              color="bg-purple-500"
              subtitle="current open snapshot"
            />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
              <ChartCard title="Open BRO by Originator">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={originatorData} margin={{ top: 24, right: 16, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => fmtMoney(Number(v))} />
                    <Tooltip formatter={(v) => fmtMoney(Number(v))} />
                    <Bar dataKey="Amount" fill={BLUE} radius={[4, 4, 0, 0]}>
                      <LabelList
                        dataKey="Amount"
                        position="top"
                        formatter={(v: number) => fmtMoney(Number(v))}
                        style={{ fontSize: 12, fill: NAVY }}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="All BRO by Stage">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={stageData} margin={{ top: 24, right: 16, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => fmtMoney(Number(v))} />
                    <Tooltip formatter={(v) => fmtMoney(Number(v))} />
                    <Bar dataKey="Amount" fill={BLUE} radius={[4, 4, 0, 0]}>
                      <LabelList
                        dataKey="Amount"
                        position="top"
                        formatter={(v: number) => fmtMoney(Number(v))}
                        style={{ fontSize: 12, fill: NAVY }}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ── Small presentational components ──────────────────────────────────────────

function SectionHeader({
  title,
  color,
  subtitle,
}: {
  title: string;
  color: string;
  subtitle?: string;
}) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <span className={`inline-block w-1 h-5 rounded-full ${color}`} />
      <h2 className="text-xs font-semibold uppercase tracking-widest text-navy">
        {title}
      </h2>
      {subtitle && (
        <span className="text-xs text-gray-400 font-normal normal-case tracking-normal">
          · {subtitle}
        </span>
      )}
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="flex justify-center py-12">
      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-orange" />
    </div>
  );
}

function KpiCard({
  label,
  sublabel,
  value,
  accent,
}: {
  label: string;
  sublabel: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={`text-3xl font-semibold mt-2 tabular-nums ${accent ?? "text-navy"}`}>
        {value}
      </p>
      <p className="text-xs text-gray-400 mt-1">{sublabel}</p>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <h3 className="text-sm font-semibold text-navy mb-3">{title}</h3>
      {children}
    </div>
  );
}

function CdmTeamBadge() {
  return (
    <div className="relative group inline-block">
      <span className="inline-flex items-center gap-2 text-xs font-medium text-navy bg-white border border-gray-200 rounded-full px-3 py-1.5 cursor-help select-none">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
        CDM Team
        <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </span>
      <div className="absolute right-0 top-full mt-2 w-56 bg-white rounded-xl border border-gray-200 shadow-lg p-3 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-opacity z-20 pointer-events-none">
        <p className="text-xs font-semibold text-navy mb-2 uppercase tracking-wide">Team Members</p>
        <ul className="text-sm text-gray-700 space-y-1">
          {CDM_OWNER_NAMES.map((n) => (
            <li key={n} className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-navy" />
              {n}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
