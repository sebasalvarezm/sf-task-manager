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
import RangePicker from "../../components/RangePicker";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";
import ConnectSalesforce from "../../components/ConnectSalesforce";
import ActionCard, { ActionRow } from "../../components/ActionCard";
import Heatmap from "../../components/Heatmap";
import { RangePreset, computeRange } from "@/lib/date-ranges";
import { CDM_OWNER_NAMES } from "@/lib/salesforce-stats";
import { Modal } from "@/app/components/ui/Modal";
import { Table } from "@/app/components/ui/Table";
import { Spinner } from "@/app/components/ui/Spinner";
import { ExternalLink } from "lucide-react";
import { HeatmapData, EnrichedMultiOpen } from "@/lib/analytics-derivations";

// ── Types mirroring API responses ────────────────────────────────────────────

type PersonBreakdown = {
  owner: string;
  e1: number;
  rce1: number;
  outreach: number;
  c1: number;
  rcc: number;
  f2f: number;
  openBRO: number;
};

type BucketRow = {
  bucketLabel: string;
  bucketStart: string;
  e1: number;
  rce1: number;
  c1: number;
  rcc: number;
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

type DrillDimension =
  | "outreach_by_person"
  | "e1_by_person"
  | "rce1_by_person"
  | "calls_by_person"
  | "conversion_by_person"
  | "bro_by_originator"
  | "bro_by_stage";

type DrillTarget = {
  dimension: DrillDimension;
  title: string;
  owner?: string;
  stage?: string;
  callType?: "c1" | "rcc" | "f2f";
};

type DrillRow = {
  accountId: string | null;
  accountName: string;
  website: string | null;
  numberOfEmployees: number | null;
  country: string | null;
  lastActivityDate: string | null;
  opportunityId?: string | null;
  opportunityName?: string | null;
  stage?: string | null;
  amount?: number | null;
};

type StatsResponse = {
  kpis: {
    totalOutreach: number;
    e1: number;
    rce1: number;
    totalCalls: number;
    c1: number;
    rcc: number;
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
const TEAL = "#5EC4C4";
const NAVY = "#1B2A4A";

// ── Formatters ───────────────────────────────────────────────────────────────

function fullNameFromFirst(first: string): string | null {
  return CDM_OWNER_NAMES.find((n) => n.startsWith(first + " ")) ?? null;
}

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

  const [drill, setDrill] = useState<DrillTarget | null>(null);

  // Open the drill modal — convert chart's first-name string to a Salesforce
  // full owner name. If the first name doesn't match a CDM owner, no-op.
  const openOwnerDrill = (
    payload: Partial<{ name: string }> | null | undefined,
    base: Omit<DrillTarget, "owner" | "title">,
    titleFn: (firstName: string) => string,
  ) => {
    const first = payload?.name ?? "";
    const full = fullNameFromFirst(first);
    if (!full || !first) return;
    setDrill({ ...base, owner: full, title: titleFn(first) } as DrillTarget);
  };

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
      C1: p.c1,
      RCC: p.rcc,
      F2F: p.f2f,
    }));
  }, [data]);

  const trendData = useMemo(() => {
    if (!data) return [];
    return data.byBucket.map((b) => ({
      name: b.bucketLabel,
      Outreach: b.e1 + b.rce1,
      Calls: b.c1 + b.rcc,
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
    <>
      <PageHeader
        title="Weekly Stats"
        subtitle="CDM Group"
        actions={
          <>
            {outreachConnected !== null && (
              <span
                className={
                  "inline-flex items-center gap-1.5 text-xs rounded-md px-3 h-9 border " +
                  (outreachConnected
                    ? "text-ok bg-ok-soft border-ok/20"
                    : "text-warn bg-warn-soft border-warn/20")
                }
              >
                <span
                  className={
                    "w-1.5 h-1.5 rounded-full " +
                    (outreachConnected ? "bg-ok" : "bg-warn")
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
          </>
        }
      />
      <PageContent>
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
                sublabel="C1 + RCC"
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
                    <Bar
                      dataKey="Outreach"
                      fill={BLUE}
                      radius={[4, 4, 0, 0]}
                      cursor="pointer"
                      onClick={(d) =>
                        openOwnerDrill(
                          d as { name?: string },
                          { dimension: "outreach_by_person" },
                          (n) => `Outreach by ${n}`,
                        )
                      }
                    >
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
                      <Bar
                        dataKey="E1"
                        fill={BLUE}
                        radius={[4, 4, 0, 0]}
                        cursor="pointer"
                        onClick={(d) =>
                          openOwnerDrill(
                            d as { name?: string },
                            { dimension: "e1_by_person" },
                            (n) => `E1 by ${n}`,
                          )
                        }
                      />
                      <Bar
                        dataKey="RCE1"
                        fill={GREEN}
                        radius={[4, 4, 0, 0]}
                        cursor="pointer"
                        onClick={(d) =>
                          openOwnerDrill(
                            d as { name?: string },
                            { dimension: "rce1_by_person" },
                            (n) => `RCE1 by ${n}`,
                          )
                        }
                      />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
              <ChartCard title="Calls + F2F by Person">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={callsF2FByPersonData} margin={{ top: 24, right: 16, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar
                      dataKey="C1"
                      fill={BLUE}
                      radius={[4, 4, 0, 0]}
                      cursor="pointer"
                      onClick={(d) =>
                        openOwnerDrill(
                          d as { name?: string },
                          { dimension: "calls_by_person", callType: "c1" },
                          (n) => `C1 calls by ${n}`,
                        )
                      }
                    />
                    <Bar
                      dataKey="RCC"
                      fill={TEAL}
                      radius={[4, 4, 0, 0]}
                      cursor="pointer"
                      onClick={(d) =>
                        openOwnerDrill(
                          d as { name?: string },
                          { dimension: "calls_by_person", callType: "rcc" },
                          (n) => `RCC calls by ${n}`,
                        )
                      }
                    />
                    <Bar
                      dataKey="F2F"
                      fill={ORANGE}
                      radius={[4, 4, 0, 0]}
                      cursor="pointer"
                      onClick={(d) =>
                        openOwnerDrill(
                          d as { name?: string },
                          { dimension: "calls_by_person", callType: "f2f" },
                          (n) => `F2F by ${n}`,
                        )
                      }
                    />
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
                    <Bar
                      dataKey="Rate"
                      fill={GREEN}
                      radius={[4, 4, 0, 0]}
                      cursor="pointer"
                      onClick={(d) =>
                        openOwnerDrill(
                          d as { name?: string },
                          { dimension: "conversion_by_person" },
                          (n) => `Calls converted by ${n}`,
                        )
                      }
                    >
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
                    <Bar
                      dataKey="Amount"
                      fill={BLUE}
                      radius={[4, 4, 0, 0]}
                      cursor="pointer"
                      onClick={(d) =>
                        openOwnerDrill(
                          d as { name?: string },
                          { dimension: "bro_by_originator" },
                          (n) => `Open BROs originated by ${n}`,
                        )
                      }
                    >
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
                    <Bar
                      dataKey="Amount"
                      fill={BLUE}
                      radius={[4, 4, 0, 0]}
                      cursor="pointer"
                      onClick={(d) => {
                        const stage = (d as { name?: string })?.name;
                        if (stage) {
                          setDrill({
                            dimension: "bro_by_stage",
                            stage,
                            title: `Open BROs in ${stage}`,
                          });
                        }
                      }}
                    >
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

        {drill && (
          <DrillModal
            target={drill}
            rangeStart={range.start}
            rangeEnd={range.end}
            onClose={() => setDrill(null)}
          />
        )}
      </PageContent>
    </>
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

// ─────────────────────────────────────────────────────────────────────────────
// Drill modal — fetches /api/salesforce/stats/drill and renders the company
// table for the clicked bar.
// ─────────────────────────────────────────────────────────────────────────────

function DrillModal({
  target,
  rangeStart,
  rangeEnd,
  onClose,
}: {
  target: DrillTarget;
  rangeStart: string;
  rangeEnd: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<DrillRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setRows(null);
      setError(null);
      const params = new URLSearchParams({ dimension: target.dimension });
      if (target.owner) params.set("owner", target.owner);
      if (target.stage) params.set("stage", target.stage);
      if (target.callType) params.set("callType", target.callType);
      // BRO drills don't filter by date but the helper accepts them harmlessly.
      params.set("start", rangeStart);
      params.set("end", rangeEnd);
      try {
        const res = await fetch(
          `/api/salesforce/stats/drill?${params.toString()}`,
          { cache: "no-store" },
        );
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? "Failed to load drill data");
        } else {
          setRows((body.rows ?? []) as DrillRow[]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Network error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, rangeStart, rangeEnd]);

  const isOpps =
    target.dimension === "bro_by_originator" ||
    target.dimension === "bro_by_stage";

  // ── Memo lookup (only for opportunity drills) ────────────────────────────
  // For each unique account name, fire one /api/memos/find request and store
  // the result. Outlook search is per-account; results render inline as a
  // "See Memo" link that opens the email in Outlook on the web.
  type MemoState =
    | { status: "loading" }
    | { status: "none" }
    | {
        status: "found";
        webLink: string;
        sentDateTime: string;
        hasAttachments: boolean;
      };
  const [memos, setMemos] = useState<Record<string, MemoState>>({});

  useEffect(() => {
    if (!rows || !isOpps) return;
    const uniqueAccounts = Array.from(
      new Set(
        rows
          .map((r) => r.accountName)
          .filter((n): n is string => !!n && n !== "(no account)"),
      ),
    );
    if (uniqueAccounts.length === 0) return;

    let cancelled = false;
    setMemos((prev) => {
      const next = { ...prev };
      for (const name of uniqueAccounts) {
        if (!next[name]) next[name] = { status: "loading" };
      }
      return next;
    });

    (async () => {
      // Fire all lookups in parallel; cap to avoid hammering Graph if there
      // are dozens of accounts.
      const BATCH = 6;
      for (let i = 0; i < uniqueAccounts.length; i += BATCH) {
        if (cancelled) return;
        const batch = uniqueAccounts.slice(i, i + BATCH);
        await Promise.all(
          batch.map(async (name) => {
            try {
              const res = await fetch(
                `/api/memos/find?accountName=${encodeURIComponent(name)}`,
                { cache: "no-store" },
              );
              if (!res.ok) {
                if (!cancelled) {
                  setMemos((prev) => ({
                    ...prev,
                    [name]: { status: "none" },
                  }));
                }
                return;
              }
              const data = await res.json();
              const m = data.memo;
              if (!cancelled) {
                setMemos((prev) => ({
                  ...prev,
                  [name]: m
                    ? {
                        status: "found",
                        webLink: m.webLink,
                        sentDateTime: m.sentDateTime,
                        hasAttachments: m.hasAttachments,
                      }
                    : { status: "none" },
                }));
              }
            } catch {
              if (!cancelled) {
                setMemos((prev) => ({ ...prev, [name]: { status: "none" } }));
              }
            }
          }),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, isOpps]);

  function renderMemoCell(accountName: string) {
    const state = memos[accountName];
    if (!state || state.status === "loading") {
      return <span className="text-ink-muted text-xs">…</span>;
    }
    if (state.status === "none") {
      return <span className="text-ink-muted">—</span>;
    }
    const dateStr = state.sentDateTime
      ? new Date(state.sentDateTime).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        })
      : "";
    return (
      <a
        href={state.webLink}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-info hover:underline whitespace-nowrap"
      >
        See Memo
        {state.hasAttachments && <span className="text-xs">📎</span>}
        {dateStr && (
          <span className="text-xs text-ink-muted">· {dateStr}</span>
        )}
      </a>
    );
  }

  // Custom stage ordering for opportunity drills (different from the
  // OPPORTUNITY_STAGES enum order — user preference for the stats UI).
  const STAGE_DISPLAY_ORDER = [
    "Incoming",
    "Pre-DD",
    "IOI",
    "LOI",
    "DD",
    "On Ice",
  ] as const;

  // Group opps by stage in the requested order. Rows with an unknown stage
  // bucket into "Other" at the end (rare, but defensive).
  const grouped = (() => {
    if (!rows || !isOpps) return null;
    const map = new Map<string, DrillRow[]>();
    for (const r of rows) {
      const key = r.stage ?? "Other";
      const arr = map.get(key) ?? [];
      arr.push(r);
      map.set(key, arr);
    }
    const sorted: Array<{ stage: string; rows: DrillRow[] }> = [];
    for (const stage of STAGE_DISPLAY_ORDER) {
      const arr = map.get(stage);
      if (arr && arr.length > 0) {
        sorted.push({ stage, rows: arr });
        map.delete(stage);
      }
    }
    // Anything left over (unknown stages)
    for (const [stage, arr] of map) {
      sorted.push({ stage, rows: arr });
    }
    return sorted;
  })();

  function renderTable(visibleRows: DrillRow[], includeStageColumn: boolean) {
    return (
      <Table>
        <Table.Head>
          <Table.HeadRow>
            <Table.HeadCell>Company</Table.HeadCell>
            <Table.HeadCell>URL</Table.HeadCell>
            <Table.HeadCell className="text-right">Employees</Table.HeadCell>
            <Table.HeadCell>Country</Table.HeadCell>
            {includeStageColumn && <Table.HeadCell>Stage</Table.HeadCell>}
            {isOpps && (
              <Table.HeadCell className="text-right">Amount</Table.HeadCell>
            )}
            {isOpps && <Table.HeadCell>Memo</Table.HeadCell>}
            {!isOpps && <Table.HeadCell>Last Activity</Table.HeadCell>}
          </Table.HeadRow>
        </Table.Head>
        <Table.Body>
          {visibleRows.map((r, i) => (
            <Table.Row key={(r.opportunityId ?? r.accountId ?? "") + i}>
              <Table.Cell className="font-medium text-ink">
                {r.accountName}
                {r.opportunityName && (
                  <div className="text-xs text-ink-muted mt-0.5">
                    {r.opportunityName}
                  </div>
                )}
              </Table.Cell>
              <Table.Cell>
                {r.website ? (
                  <a
                    href={
                      r.website.startsWith("http")
                        ? r.website
                        : `https://${r.website}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-info hover:underline"
                  >
                    {r.website.replace(/^https?:\/\/(www\.)?/, "")}
                    <ExternalLink className="h-3 w-3" strokeWidth={2} />
                  </a>
                ) : (
                  <span className="text-ink-muted">—</span>
                )}
              </Table.Cell>
              <Table.Cell className="text-right tabular-nums">
                {r.numberOfEmployees != null
                  ? fmtNumber(r.numberOfEmployees)
                  : "—"}
              </Table.Cell>
              <Table.Cell>
                {r.country ?? <span className="text-ink-muted">—</span>}
              </Table.Cell>
              {includeStageColumn && (
                <Table.Cell>{r.stage ?? "—"}</Table.Cell>
              )}
              {isOpps && (
                <Table.Cell className="text-right tabular-nums">
                  {r.amount != null ? fmtMoney(r.amount) : "—"}
                </Table.Cell>
              )}
              {isOpps && (
                <Table.Cell className="whitespace-nowrap">
                  {renderMemoCell(r.accountName)}
                </Table.Cell>
              )}
              {!isOpps && (
                <Table.Cell className="text-ink-muted whitespace-nowrap">
                  {r.lastActivityDate ?? "—"}
                </Table.Cell>
              )}
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={target.title}
      description={
        rows == null
          ? undefined
          : `${rows.length} ${rows.length === 1 ? "company" : "companies"}`
      }
      size="xl"
    >
      {error && (
        <p className="text-sm text-danger mb-4">{error}</p>
      )}
      {rows == null && !error && <Spinner center label="Loading…" />}
      {rows != null && rows.length === 0 && (
        <p className="text-sm text-ink-muted">
          No companies match this filter.
        </p>
      )}
      {rows != null && rows.length > 0 && !isOpps && renderTable(rows, false)}
      {rows != null && rows.length > 0 && isOpps && grouped && (
        <div className="space-y-6">
          {grouped.map(({ stage, rows: stageRows }) => (
            <div key={stage}>
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-ink">
                  {stage}
                </h3>
                <span className="text-xs text-ink-muted">
                  {stageRows.length} opportunit
                  {stageRows.length === 1 ? "y" : "ies"}
                </span>
              </div>
              {renderTable(stageRows, false)}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
