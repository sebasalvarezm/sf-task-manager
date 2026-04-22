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
import { RangePreset, computeRange } from "@/lib/date-ranges";

// ── Types mirroring /api/salesforce/stats response ───────────────────────────

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
  byPerson: PersonBreakdown[];
  byBucket: BucketRow[];
  byStage: StageRow[];
  byOriginator: OriginatorRow[];
};

// ── Color palette (subset of the first reference image aesthetic) ────────────
const BLUE = "#6FA8F0";
const GREEN = "#8DD178";
const ORANGE = "#F2B84B";
const NAVY = "#1B2A4A";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Page ─────────────────────────────────────────────────────────────────────

export default function StatsPage() {
  const router = useRouter();
  const [preset, setPreset] = useState<RangePreset>("this_week");
  const [connected, setConnected] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<StatsResponse | null>(null);

  const range = useMemo(() => computeRange(preset), [preset]);

  // ── On mount: check Salesforce connection ──────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/salesforce/status");
        if (res.ok) {
          const d = await res.json();
          setConnected(Boolean(d.connected));
        } else {
          setConnected(false);
        }
      } catch {
        setConnected(false);
      }
    })();
  }, []);

  // ── Load stats when connected or range changes ─────────────────────────────
  useEffect(() => {
    if (!connected) return;
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, preset]);

  async function loadStats() {
    setLoading(true);
    setError(null);
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
          setConnected(false);
          return;
        }
        throw new Error(body.error ?? "Failed to load stats");
      }
      const json = (await res.json()) as StatsResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  async function handleDisconnect() {
    await fetch("/api/salesforce/status", { method: "DELETE" });
    setConnected(false);
    setData(null);
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
        {connected !== null && (
          <ConnectSalesforce connected={connected} onDisconnect={handleDisconnect} />
        )}
      </header>

      {/* Main */}
      <main className="flex-1 px-8 py-8 max-w-[1400px] w-full mx-auto">
        {/* Range picker */}
        <div className="mb-2">
          <RangePicker value={preset} onChange={setPreset} />
        </div>
        <p className="text-sm text-gray-500 mb-6">
          Showing <span className="font-medium text-navy">{range.label}</span> · team: Sebastian, Nate, Tyson
        </p>

        {connected === false && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 text-center">
            <p className="text-sm text-amber-700 mb-3">
              Salesforce is not connected. Connect to see stats.
            </p>
          </div>
        )}

        {connected === true && loading && (
          <div className="flex justify-center py-16">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-orange" />
          </div>
        )}

        {connected === true && error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700 mb-6">
            {error}
          </div>
        )}

        {connected === true && !loading && data && (
          <>
            {/* KPI row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
              <KpiCard
                label="Total Outreach"
                sublabel={`${fmtNumber(data.kpis.e1)} E1 · ${fmtNumber(data.kpis.rce1)} RCE1`}
                value={fmtNumber(data.kpis.totalOutreach)}
              />
              <KpiCard
                label="Total Calls (C1)"
                sublabel="Completed"
                value={fmtNumber(data.kpis.totalCalls)}
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

            {/* Row 1: Outreach by Person + Trend */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
              <ChartCard title="Outreach by Person">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={outreachByPersonData}>
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
                    <BarChart data={trendData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                      <Tooltip />
                      <Bar dataKey="Outreach" fill={BLUE} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={e1VsRce1Data}>
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

            {/* Row 2: Calls + F2F */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
              <ChartCard title="Calls (C1) + F2F by Person">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={callsF2FByPersonData}>
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

              <ChartCard title={showTrend ? "Calls + F2F Trend" : "E1 vs RCE1 by Person"}>
                {showTrend ? (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={trendData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="Calls" fill={BLUE} radius={[4, 4, 0, 0]} />
                      <Bar dataKey="F2F" fill={ORANGE} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={e1VsRce1Data}>
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

            {/* Row 3: BRO (always snapshot, not range-dependent) */}
            <h2 className="text-lg font-semibold text-navy mt-4 mb-3">
              BRO Pipeline <span className="text-xs font-normal text-gray-400">· current open snapshot</span>
            </h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
              <ChartCard title="Open BRO by Originator">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={originatorData}>
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
                  <BarChart data={stageData}>
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

function KpiCard({
  label,
  sublabel,
  value,
}: {
  label: string;
  sublabel: string;
  value: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="text-3xl font-semibold text-navy mt-2">{value}</p>
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
