"use client";

import { Fragment, type ReactNode } from "react";

/**
 * Sorting and "factor fit" display for Outreach lists (Next to contact, Check
 * a list). Fit comes from the server (lib/factor-fit.ts): the sum of the
 * "Act on it" factor effects the account matches, in replies per 100 sends.
 */

export type FitHit = { id: string; label: string; short: string; effect: number };
export type Fit = { score: number; hits: FitHit[] };
export type FitContext = { factors: Array<{ id: string; label: string; short: string; effect: number }>; contactNote: string | null; testedAt: string | null };

export type SortKey = "fit" | "default" | "founded_asc" | "founded_desc" | "employees_asc" | "employees_desc" | "sends_asc" | "sends_desc";

export const SORT_LABEL: Record<SortKey, string> = {
  fit: "Factor fit",
  default: "Longest since contact",
  founded_asc: "Oldest company first",
  founded_desc: "Youngest company first",
  employees_asc: "Fewest employees",
  employees_desc: "Most employees",
  sends_asc: "Fewest sequences sent",
  sends_desc: "Most sequences sent",
};
const SORT_KEYS = Object.keys(SORT_LABEL) as SortKey[];

export type SortFacts = { fit: Fit | null; founded: number | null; employees: number | null; sends: number | null };

/**
 * Stable sort by the chosen key. Unknown values always go last, whichever the
 * direction; "default" keeps the incoming order. Pure.
 */
export function sortRows<T>(rows: T[], key: SortKey, facts: (row: T) => SortFacts): T[] {
  if (key === "default") return rows;
  const pick = (f: SortFacts): number | null => {
    if (key === "fit") return f.fit ? f.fit.score : null;
    if (key.startsWith("founded")) return f.founded;
    if (key.startsWith("employees")) return f.employees;
    return f.sends;
  };
  const desc = key === "fit" || key.endsWith("_desc");
  return rows
    .map((row, i) => ({ row, i, v: pick(facts(row)) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      return (desc ? b.v - a.v : a.v - b.v) || a.i - b.i;
    })
    .map((x) => x.row);
}

export type Band = { key: string; label: string };

/** Groups for the fit sort: strong, good, slight, none, works against. */
export function fitBand(fit: Fit | null): Band {
  const s = fit?.score ?? 0;
  if (!fit || fit.hits.length === 0) return { key: "none", label: "No factor" };
  if (s >= 15) return { key: "strong", label: "Strong fit · +15 or more replies per 100" };
  if (s >= 7) return { key: "good", label: "Good fit · +7 to +15 per 100" };
  if (s > 0) return { key: "slight", label: "Slight fit · under +7 per 100" };
  return { key: "against", label: "Works against" };
}

export function fmtEffect(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(1).replace(/\.0$/, "")}`;
}

/** "Fit +21 · AU/NZ +14.6, founded 2010 to 2019 +6.5", or nothing when no factor applies. */
export function fitText(fit: Fit | null): string | null {
  if (!fit || fit.hits.length === 0) return null;
  return `Fit ${fmtEffect(fit.score)} · ${fit.hits.map((h) => `${h.short} ${fmtEffect(h.effect)}`).join(", ")}`;
}

export function FitLine({ fit }: { fit: Fit | null }) {
  const text = fitText(fit);
  if (!text || !fit) return null;
  return (
    <p className={`truncate text-[13px] ${fit.score > 0 ? "text-ok" : "text-danger"}`} title={fit.hits.map((h) => `${h.label}: ${fmtEffect(h.effect)} replies per 100`).join("\n")}>
      {text}
    </p>
  );
}

const STORAGE = "outreach-sort";

export function loadSort(fallback: SortKey): SortKey {
  try {
    const v = window.localStorage.getItem(STORAGE);
    return v && (SORT_KEYS as string[]).includes(v) ? (v as SortKey) : fallback;
  } catch {
    return fallback;
  }
}

export function saveSort(key: SortKey) {
  try {
    window.localStorage.setItem(STORAGE, key);
  } catch {
    /* a private window just forgets the choice */
  }
}

export function SortSelect({ value, onChange }: { value: SortKey; onChange: (k: SortKey) => void }) {
  return (
    <label className="inline-flex items-center gap-2 text-[13px] text-ink-secondary">
      Sort
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SortKey)}
        className="h-8 rounded-sm border border-line-strong bg-white px-2 text-[13px] text-ink focus:border-ink focus:outline-none focus:ring-2 focus:ring-surface-4"
      >
        {SORT_KEYS.map((k) => (
          <option key={k} value={k}>{SORT_LABEL[k]}</option>
        ))}
      </select>
    </label>
  );
}

/** What fit is made of right now, in one muted line under the sort. */
export function FitLegend({ context }: { context: FitContext | null }) {
  if (!context) return null;
  const parts = context.factors.map((f) => `${f.short} ${fmtEffect(f.effect)}`);
  return (
    <p className="text-xs text-ink-muted">
      {parts.length
        ? `Factor fit adds up the "Act on it" factors from What gets replies, in replies per 100 sends: ${parts.join(" · ")}.`
        : "No company factor is at \"Act on it\" yet, so factor fit is 0 for everyone."}
      {context.contactNote ? ` ${context.contactNote}` : ""}
    </p>
  );
}

/** Renders rows, with a band heading before each new fit band when sorted by fit. */
export function Banded<T>({ rows, on, fit, rowKey, render, bandOf }: { rows: T[]; on: boolean; fit: (row: T) => Fit | null; rowKey: (row: T) => string; render: (row: T) => ReactNode; bandOf?: (row: T) => Band | null }) {
  let last: string | null = null;
  return (
    <>
      {rows.map((row) => {
        const band = on ? bandOf?.(row) ?? fitBand(fit(row)) : null;
        const head = band && band.key !== last ? band : null;
        if (band) last = band.key;
        return (
          <Fragment key={rowKey(row)}>
            {head ? <div className="border-b border-line bg-surface-3 px-4 py-1.5 text-xs font-medium text-ink-secondary">{head.label}</div> : null}
            {render(row)}
          </Fragment>
        );
      })}
    </>
  );
}
