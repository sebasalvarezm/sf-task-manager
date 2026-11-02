"use client";

/**
 * Discovery settings: the pause switch, the hard caps, and the theses
 * (one FindAll search per sub-group). Every paid action here asks twice.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageContent } from "@/app/components/ui/PageContent";
import { Button } from "@/app/components/ui/Button";

type Condition = { name: string; description: string };
type Thesis = {
  id: string;
  name: string;
  group_name: string;
  main_group: string | null;
  sequence_name: string | null;
  sf_industry: string | null;
  sf_group: string | null;
  exclude_industries: string[];
  objective: string;
  match_conditions: Condition[];
  generator: "base" | "core" | "pro";
  weekly_share: number;
  enabled: boolean;
  findall_id: string | null;
  run_state: string | null;
  matched_total: number;
  preview: { at: string; candidates: Array<{ name: string; url: string; matched: boolean; reason: string | null; inSalesforce?: string | null }> } | null;
};
type Settings = { paused: boolean; matchesPerWeek: number; maxMatchesPerWeek: number; maxSpendPerWeek: number; pushesPerWeek: number; pdlCreditsPerMonth: number; alwaysExclude: string[] };
type Payload = {
  theses: Thesis[];
  settings: Settings;
  week: string;
  usage: { matches: number; spend: number };
  pushed: number;
  month: { parallel: number };
  pdlCredits: number;
  lastRun: { summary: string; at: string; week: string } | null;
  keys: { parallel: boolean; pdl: boolean };
};

const INPUT = "w-full rounded-sm border border-line bg-white px-2 py-1.5 text-sm text-ink focus:border-ink focus:outline-none focus:ring-2 focus:ring-surface-4";

export default function DiscoveryPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/discovery");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not load");
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setError(null);
    try {
      const res = await fetch("/api/discovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save");
      return json;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      return null;
    }
  }

  if (!data) return <PageContent>{error ? <p className="text-sm text-danger">{error}</p> : <p className="text-sm text-ink-secondary">Loading…</p>}</PageContent>;
  const s = data.settings;

  return (
    <PageContent>
      <div className="mb-6">
        <h1 className="text-2xl font-normal tracking-tight text-ink">Discovery</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          {s.paused ? "Paused" : "On, runs Sunday 10pm"} · week of {data.week}: ${data.usage.spend.toFixed(2)} of ${s.maxSpendPerWeek}, {data.usage.matches} of {s.maxMatchesPerWeek} matches · {data.pushed} of {s.pushesPerWeek} pushed · this month: Parallel ${data.month.parallel.toFixed(2)}, PDL {data.pdlCredits} of {s.pdlCreditsPerMonth} credits ·{" "}
          <Link href="/outreach?tab=discovery" className="text-info no-underline hover:underline">Review candidates</Link>
        </p>
        {!data.keys.parallel || !data.keys.pdl ? (
          <p className="mt-1 text-sm text-warn">Missing in Vercel: {[!data.keys.parallel && "PARALLEL_API_KEY", !data.keys.pdl && "PDL_API_KEY"].filter(Boolean).join(", ")}. Nothing can run until it is added.</p>
        ) : null}
        {data.lastRun ? <p className="mt-1 text-sm text-ink-muted">Last run {new Date(data.lastRun.at).toLocaleString()}: {data.lastRun.summary}</p> : null}
      </div>
      {error ? <p className="mb-4 rounded-sm border border-danger bg-white px-3 py-2 text-sm text-ink">{error}</p> : null}
      {notice ? <p className="mb-4 text-sm text-ink-secondary">{notice}</p> : null}

      <SettingsCard
        settings={s}
        onSave={async (next) => {
          const r = await post({ action: "settings", settings: next });
          if (r) {
            setNotice("Saved.");
            await load();
          }
        }}
      />

      <h2 className="mb-2 mt-8 text-lg font-normal text-ink">Theses</h2>
      <div className="space-y-4">
        {data.theses.map((t) => (
          <ThesisCard
            key={t.id}
            thesis={t}
            onSave={async (patch) => {
              const r = await post({ action: "thesis", id: t.id, thesis: patch });
              if (r) {
                setNotice(`${t.name} saved.`);
                await load();
              }
            }}
            onPreview={async () => {
              const r = await post({ action: "preview", thesisId: t.id });
              if (r) setNotice(`Preview started for ${t.name} ($0.10). Results show on the card in a few minutes; reload to see them.`);
            }}
            onDryRun={async () => {
              const r = await post({ action: "dry_run", thesisId: t.id, matchLimit: 5 });
              if (r) setNotice(`Dry run started for ${t.name}: 5 matches, up to $${t.findall_id ? "0.75" : "2.75"}. Candidates land in Outreach → Discovery when it finishes.`);
            }}
          />
        ))}
      </div>
    </PageContent>
  );
}

function SettingsCard({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => Promise<void> }) {
  const [f, setF] = useState(settings);
  const [exclude, setExclude] = useState(settings.alwaysExclude.join("\n"));
  const [saving, setSaving] = useState(false);
  const num = (k: keyof Settings) => ({ value: String(f[k] as number), onChange: (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: Number(e.target.value) })) });
  return (
    <div className="rounded-md border border-line bg-white p-4">
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={!f.paused} onChange={(e) => setF((x) => ({ ...x, paused: !e.target.checked }))} />
        Run every Sunday night
      </label>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <label className="text-[13px] text-ink-secondary">Matches to ask for<input type="number" min={0} className={INPUT} {...num("matchesPerWeek")} /></label>
        <label className="text-[13px] text-ink-secondary">Max matches a week<input type="number" min={0} max={100} className={INPUT} {...num("maxMatchesPerWeek")} /></label>
        <label className="text-[13px] text-ink-secondary">Max $ a week<input type="number" min={0} max={50} step="0.5" className={INPUT} {...num("maxSpendPerWeek")} /></label>
        <label className="text-[13px] text-ink-secondary">Pushes a week<input type="number" min={0} className={INPUT} {...num("pushesPerWeek")} /></label>
        <label className="text-[13px] text-ink-secondary">PDL credits a month<input type="number" min={0} className={INPUT} {...num("pdlCreditsPerMonth")} /></label>
      </div>
      <label className="mt-3 block text-[13px] text-ink-secondary">
        Never surface these websites (one per line, e.g. portfolio companies not in Salesforce)
        <textarea rows={3} value={exclude} onChange={(e) => setExclude(e.target.value)} className={INPUT} />
      </label>
      <div className="mt-3">
        <Button size="sm" loading={saving} onClick={async () => { setSaving(true); await onSave({ ...f, alwaysExclude: exclude.split(/\s+/).filter(Boolean) }); setSaving(false); }}>Save limits</Button>
      </div>
    </div>
  );
}

function ThesisCard({ thesis, onSave, onPreview, onDryRun }: { thesis: Thesis; onSave: (p: Partial<Thesis>) => Promise<void>; onPreview: () => Promise<void>; onDryRun: () => Promise<void> }) {
  const [t, setT] = useState(thesis);
  const [saving, setSaving] = useState(false);
  const [armed, setArmed] = useState<"preview" | "dry" | null>(null);
  const set = <K extends keyof Thesis>(k: K, v: Thesis[K]) => setT((x) => ({ ...x, [k]: v }));
  const setCond = (i: number, k: keyof Condition, v: string) => setT((x) => ({ ...x, match_conditions: x.match_conditions.map((c, j) => (j === i ? { ...c, [k]: v } : c)) }));
  const arm = async (which: "preview" | "dry", go: () => Promise<void>) => {
    if (armed !== which) {
      setArmed(which);
      window.setTimeout(() => setArmed((a) => (a === which ? null : a)), 4000);
      return;
    }
    setArmed(null);
    await go();
  };
  return (
    <div className="rounded-md border border-line bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[15px] font-medium text-ink">{t.name}</span>
        <span className="text-[13px] text-ink-muted">{t.group_name}{t.sequence_name ? ` · ${t.sequence_name}` : ""}</span>
        <label className="ml-auto flex items-center gap-1.5 text-[13px] text-ink-secondary">
          <input type="checkbox" checked={t.enabled} onChange={(e) => set("enabled", e.target.checked)} /> In rotation
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-ink-secondary">
          Weight <input type="number" min={0} max={10} value={t.weekly_share} onChange={(e) => set("weekly_share", Number(e.target.value))} className="w-14 rounded-sm border border-line px-1.5 py-1 text-sm" />
        </label>
      </div>
      <p className="mt-1 text-[13px] text-ink-muted">
        {t.findall_id ? `Standing run: ${t.matched_total} matches so far · ${t.run_state ?? ""}` : t.run_state ? t.run_state : "No run yet: the first run costs $2 plus $0.15 a match."}
      </p>
      <label className="mt-3 block text-[13px] text-ink-secondary">Objective<textarea rows={2} value={t.objective} onChange={(e) => set("objective", e.target.value)} className={INPUT} /></label>
      <div className="mt-3 space-y-2">
        {t.match_conditions.map((c, i) => (
          <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[160px_1fr_auto]">
            <input value={c.name} onChange={(e) => setCond(i, "name", e.target.value)} className={INPUT} />
            <textarea rows={2} value={c.description} onChange={(e) => setCond(i, "description", e.target.value)} className={INPUT} />
            <button type="button" onClick={() => setT((x) => ({ ...x, match_conditions: x.match_conditions.filter((_, j) => j !== i) }))} className="text-[13px] text-ink-muted hover:text-danger">Remove</button>
          </div>
        ))}
        <button type="button" onClick={() => setT((x) => ({ ...x, match_conditions: [...x.match_conditions, { name: "new_condition", description: "" }] }))} className="text-[13px] text-info hover:underline">Add a condition</button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="text-[13px] text-ink-secondary">Salesforce Industry on Push<input value={t.sf_industry ?? ""} onChange={(e) => set("sf_industry", e.target.value || null)} className={INPUT} /></label>
        <label className="text-[13px] text-ink-secondary">Salesforce Group on Push<input value={t.sf_group ?? ""} onChange={(e) => set("sf_group", e.target.value || null)} className={INPUT} /></label>
        <label className="text-[13px] text-ink-secondary">
          Generator
          <select value={t.generator} onChange={(e) => set("generator", e.target.value as Thesis["generator"])} className={INPUT}>
            <option value="base">base ($0.25 + $0.03 a match)</option>
            <option value="core">core ($2 + $0.15 a match)</option>
            <option value="pro">pro ($10 + $1 a match)</option>
          </select>
        </label>
      </div>
      <label className="mt-3 block text-[13px] text-ink-secondary">
        Salesforce industries to exclude first (one per line). FindAll takes 10,000 exclusions and Salesforce has about 43,000 accounts, so the closest industries go first.
        <textarea rows={3} value={(t.exclude_industries ?? []).join("\n")} onChange={(e) => set("exclude_industries", e.target.value.split("\n").map((x) => x.trim()).filter(Boolean))} className={INPUT} />
      </label>
      <p className="mt-2 text-[12px] text-ink-muted">Changing the objective, conditions or generator ends the standing run; the next run starts fresh ($2 again).</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" loading={saving} onClick={async () => { setSaving(true); await onSave(t); setSaving(false); }}>Save</Button>
        <Button size="sm" variant="secondary" onClick={() => void arm("preview", onPreview)}>{armed === "preview" ? "Tap again: $0.10" : "Preview"}</Button>
        <Button size="sm" variant="secondary" onClick={() => void arm("dry", onDryRun)}>{armed === "dry" ? `Tap again: up to $${t.findall_id ? "0.75" : "2.75"}` : "Dry run, 5 matches"}</Button>
      </div>
      {t.preview ? (
        <div className="mt-3 border-t border-line pt-2 text-[13px] text-ink-secondary">
          <p className="text-ink">
            Preview {new Date(t.preview.at).toLocaleDateString()}: {t.preview.candidates.filter((c) => c.matched).length} of {t.preview.candidates.length} matched,{" "}
            {t.preview.candidates.filter((c) => c.matched && c.inSalesforce).length} of those already in Salesforce
          </p>
          {t.preview.candidates.map((c) => (
            <p key={c.url} className="mt-0.5">
              <span className={c.matched ? "text-ok" : "text-ink-muted"}>{c.matched ? "Match" : "No"}</span> · <a href={c.url} target="_blank" rel="noreferrer" className="text-info no-underline hover:underline">{c.name}</a>
              {c.matched && c.inSalesforce ? <span className="text-warn"> · already in Salesforce as {c.inSalesforce}</span> : null}
              {c.reason && !c.matched ? ` · ${c.reason}` : ""}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
