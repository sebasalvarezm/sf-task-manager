/**
 * The shape of an "Export to Excel" request. Any table in the app describes
 * what is on screen with these types; the server only formats it into a
 * styled workbook (lib/xlsx-export.ts). No Salesforce or database reads, no writes.
 *
 * Types only, so client components can import them without pulling in exceljs.
 */

export type ExportValue = string | number | boolean | null | undefined;

/** How a cell is coloured: warn = amber (flagged), bad = red, good = green, muted = grey. */
export type ExportTone = "warn" | "bad" | "good" | "muted";

/** A plain value, or a value with a link and/or a colour. */
export type ExportCell = ExportValue | { value: ExportValue; url?: string | null; tone?: ExportTone | null };

export type ExportColumnType =
  | "text"
  /** Long text: wide column, wrapped. */
  | "wrap"
  /** Whole number, 1,234. */
  | "integer"
  /** A year, 1998 (no thousands comma). */
  | "year"
  | "number"
  /** Dollars, $1,234. */
  | "money"
  /** A fraction (0.073) shown as 7.3%. */
  | "percent"
  /** "2026-11-18" or an ISO timestamp, shown as a real Excel date. */
  | "date";

export type ExportColumn = { key: string; header: string; type?: ExportColumnType; width?: number };

export type ExportSheet = {
  name: string;
  /** Bold line above the table, usually what was on screen ("Potential outreach · Ilan Bernadski"). */
  title?: string;
  /** Muted line under the title: the filters or rule that made the list. */
  subtitle?: string;
  columns: ExportColumn[];
  rows: Array<Record<string, ExportCell>>;
};

export type ExportRequest = { filename: string; sheets: ExportSheet[] };

/** "https://www.acme.com/" or "acme.com" → a link cell showing "acme.com". */
export function websiteCell(website: string | null | undefined): ExportCell {
  if (!website) return null;
  const url = /^https?:\/\//i.test(website) ? website : `https://${website}`;
  return { value: website.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, ""), url };
}

/** A name that links to its Salesforce record when there is one. */
export function linkCell(value: ExportValue, url: string | null | undefined, tone?: ExportTone | null): ExportCell {
  return url || tone ? { value, url: url ?? null, tone: tone ?? null } : value;
}
