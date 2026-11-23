import { FACTOR_LIBRARY, accountInGroupA, isAccountFactor, type AccountFacts, type FactorSpec } from "./outcomes-factors";
import { loadFactorState, type FactorState } from "./outcomes-factors-store";
import { scoreAccountQuality, type QualityThresholds } from "./outreach-quality";

/**
 * Factor fit: ranks accounts by the "Act on it" factors from What gets replies.
 *
 * Only factors about the company itself count (country, founded, size,
 * clean or not, earlier sends); email, timing and contact factors cannot rank a
 * list. Each matching factor adds its measured effect (replies per 100 sends),
 * so an Australian company founded in 2014 scores about +14.6 + 6.5. Factors
 * that say "avoid" subtract. The list is read fresh from the latest Sunday
 * results, so a factor that stops holding drops out on its own.
 *
 * Read only: nothing is written anywhere.
 */

export type FitFactor = { id: string; label: string; short: string; effect: number; spec: FactorSpec };
export type FitHit = { id: string; label: string; short: string; effect: number };
export type Fit = { score: number; hits: FitHit[] };
export type FitContext = {
  factors: Array<Omit<FitFactor, "spec">>;
  /** One line about who to email on a re-contact, when a contact factor says so. */
  contactNote: string | null;
  testedAt: string | null;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Pure: the factors that can rank accounts, strongest first, plus the contact note. */
export function fitFactorsFrom(state: FactorState): { factors: FitFactor[]; contactNote: string | null } {
  const specs = new Map<string, FactorSpec>();
  for (const s of FACTOR_LIBRARY) specs.set(s.id, s);
  for (const p of state.proposals) if (p.status === "approved") specs.set(p.spec.id, p.spec);
  const factors: FitFactor[] = [];
  let contactNote: string | null = null;
  for (const [id, entry] of Object.entries(state.results ?? {})) {
    const r = entry?.latest;
    const spec = specs.get(id);
    if (!r || !spec || r.verdict !== "act" || typeof r.effectPer100 !== "number" || r.effectPer100 === 0) continue;
    if (isAccountFactor(spec)) {
      factors.push({ id, label: spec.label, short: spec.aLabel, effect: round1(r.effectPer100), spec });
      continue;
    }
    // "Re-contact a different person": a contact choice, so a note rather than a score.
    const same = spec.test.find((c) => c.field === "same_person" && c.op === "is");
    if (same && same.op === "is" && !contactNote) {
      const testIsSame = same.value === true;
      const sameBetter = testIsSame ? r.effectPer100 > 0 : r.effectPer100 < 0;
      contactNote = sameBetter
        ? `On re-contacts, email the same person again (${Math.abs(round1(r.effectPer100))} more replies per 100 than a new person).`
        : `On re-contacts, try a different person (${Math.abs(round1(r.effectPer100))} more replies per 100 than the same one).`;
    }
  }
  factors.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  return { factors, contactNote };
}

/** Pure: the account's fit, its matching factors biggest first. */
export function fitFor(facts: AccountFacts, factors: FitFactor[]): Fit {
  const hits = factors
    .filter((f) => accountInGroupA(f.spec, facts))
    .map((f) => ({ id: f.id, label: f.label, short: f.short, effect: f.effect }))
    .sort((a, b) => b.effect - a.effect);
  return { score: round1(hits.reduce((n, h) => n + h.effect, 0)), hits };
}

/** Same rule as the BS meter and What gets replies: 2+ flags flagged, 1 potential, 0 clean. */
export function qualityOf(country: string | null, founded: number | null, employees: number | null, thresholds: QualityThresholds): "clean" | "potential" | "flagged" {
  const v = scoreAccountQuality({ country, yearEstablished: founded != null ? String(founded) : null, numberOfEmployees: employees }, thresholds);
  return v.isBs ? "flagged" : v.flags.length > 0 ? "potential" : "clean";
}

export async function loadFitFactors(): Promise<{ factors: FitFactor[]; context: FitContext }> {
  const state = await loadFactorState().catch(() => null);
  if (!state) return { factors: [], context: { factors: [], contactNote: null, testedAt: null } };
  const { factors, contactNote } = fitFactorsFrom(state);
  return {
    factors,
    context: { factors: factors.map(({ spec: _spec, ...f }) => f), contactNote, testedAt: state.testedAt ?? null },
  };
}

/** Adds fit to account rows for the Outreach screens. Factors or thresholds failing to load leaves every fit at 0. */
export async function withFit<T>(
  rows: T[],
  facts: (row: T) => (Omit<AccountFacts, "quality"> & { quality?: string | null }) | null,
  loadThresholds: () => Promise<QualityThresholds>,
): Promise<{ rows: Array<T & { fit: Fit | null }>; fit: FitContext }> {
  const [{ factors, context }, thresholds] = await Promise.all([loadFitFactors(), loadThresholds().catch(() => null)]);
  return {
    fit: context,
    rows: rows.map((row) => {
      const f = facts(row);
      if (!f) return { ...row, fit: null };
      const quality = f.quality ?? (thresholds ? qualityOf(f.country, f.founded, f.employees, thresholds) : null);
      return { ...row, fit: fitFor({ ...f, quality }, factors) };
    }),
  };
}
