import ExcelJS from "exceljs";
import type { ExportCell, ExportColumn, ExportColumnType, ExportRequest, ExportSheet, ExportTone, ExportValue } from "./xlsx-export-types";

/**
 * Turns what a table shows on screen into a formatted Excel file, in the same
 * house style as the Weekly Outreach export: navy header with a coral rule,
 * Aptos, frozen header, filters on, links clickable, numbers and dates as real
 * Excel values. Formatting only: it reads and writes nothing else.
 */

export const EXPORT_LIMITS = { sheets: 10, columns: 40, rows: 20_000, text: 32_000, filename: 100 } as const;

const NAVY = "1B2A4A";
const CORAL = "F28C64";
const LINE = "D9E1F2";
const STRIPE = "F7F9FC";
const MUTED = "6B7280";
const TONE_COLOR: Record<ExportTone, string> = { warn: "B45309", bad: "C0392B", good: "2E7D32", muted: "8A94A6" };
const COLUMN_TYPES = new Set<ExportColumnType>(["text", "wrap", "integer", "year", "number", "money", "percent", "date"]);
const TONES = new Set<ExportTone>(["warn", "bad", "good", "muted"]);
const FONT = "Aptos";

export class ExportError extends Error {}

function cleanText(v: unknown, max: number = EXPORT_LIMITS.text): string {
  return String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, max);
}

/** Only web and mail links become hyperlinks; anything else is dropped. */
export function safeUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const u = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) && u.length <= 2000 ? u : null;
}

function cleanValue(v: unknown): ExportValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  return cleanText(v);
}

function cleanCell(c: unknown): ExportCell {
  if (c && typeof c === "object" && !Array.isArray(c)) {
    const o = c as { value?: unknown; url?: unknown; tone?: unknown };
    const tone = typeof o.tone === "string" && TONES.has(o.tone as ExportTone) ? (o.tone as ExportTone) : null;
    return { value: cleanValue(o.value), url: safeUrl(o.url), tone };
  }
  return cleanValue(c);
}

/** Excel sheet names: 31 characters, none of []:*?/\ , unique in the workbook. */
export function sheetName(name: string, taken: Set<string>): string {
  const base = cleanText(name, 200).replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Sheet";
  let out = base;
  for (let i = 2; taken.has(out.toLowerCase()); i++) out = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
  taken.add(out.toLowerCase());
  return out;
}

export function exportFilename(name: string): string {
  const base = cleanText(name, 300)
    .replace(/\.xlsx$/i, "")
    .replace(/[^\p{L}\p{N} ._()&,'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, EXPORT_LIMITS.filename);
  return `${base || "Export"}.xlsx`;
}

/** Checks and cleans a request from the browser. Throws ExportError with a plain message. */
export function parseExportRequest(body: unknown): ExportRequest {
  const b = body as { filename?: unknown; sheets?: unknown } | null;
  if (!b || !Array.isArray(b.sheets) || b.sheets.length === 0) throw new ExportError("Nothing to export.");
  if (b.sheets.length > EXPORT_LIMITS.sheets) throw new ExportError(`Too many sheets (max ${EXPORT_LIMITS.sheets}).`);
  let total = 0;
  const sheets: ExportSheet[] = b.sheets.map((raw) => {
    const s = raw as { name?: unknown; title?: unknown; subtitle?: unknown; columns?: unknown; rows?: unknown };
    if (!Array.isArray(s.columns) || s.columns.length === 0) throw new ExportError("A sheet has no columns.");
    if (s.columns.length > EXPORT_LIMITS.columns) throw new ExportError(`Too many columns (max ${EXPORT_LIMITS.columns}).`);
    const rows = Array.isArray(s.rows) ? s.rows : [];
    total += rows.length;
    if (total > EXPORT_LIMITS.rows) throw new ExportError(`Too many rows (max ${EXPORT_LIMITS.rows.toLocaleString("en-US")}).`);
    const keys = new Set<string>();
    const columns: ExportColumn[] = s.columns.map((rc) => {
      const c = rc as { key?: unknown; header?: unknown; type?: unknown; width?: unknown };
      const key = cleanText(c.key, 60);
      if (!key || keys.has(key)) throw new ExportError("Columns need distinct keys.");
      keys.add(key);
      const type = typeof c.type === "string" && COLUMN_TYPES.has(c.type as ExportColumnType) ? (c.type as ExportColumnType) : "text";
      const width = typeof c.width === "number" && Number.isFinite(c.width) ? Math.min(80, Math.max(4, c.width)) : undefined;
      return { key, header: cleanText(c.header, 120), type, width };
    });
    return {
      name: cleanText(s.name, 200) || "Sheet",
      title: s.title ? cleanText(s.title, 300) : undefined,
      subtitle: s.subtitle ? cleanText(s.subtitle, 1000) : undefined,
      columns,
      rows: rows.map((r) => {
        const row = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
        const out: Record<string, ExportCell> = {};
        for (const c of columns) out[c.key] = cleanCell(row[c.key]);
        return out;
      }),
    };
  });
  return { filename: exportFilename(typeof b.filename === "string" ? b.filename : "Export"), sheets };
}

/** "2026-11-18" → a date Excel shows as 2026-11-18 whatever the time zone. */
export function toExcelDate(v: ExportValue): Date | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNumber(v: ExportValue): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const t = v.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?%?$/.test(t)) return null;
  return t.endsWith("%") ? Number(t.slice(0, -1)) / 100 : Number(t);
}

const NUM_FMT: Partial<Record<ExportColumnType, string>> = {
  integer: "#,##0",
  year: "0",
  number: "#,##0.##",
  money: '"$"#,##0',
  percent: "0.0%",
  date: "yyyy-mm-dd",
};

function excelValue(type: ExportColumnType, v: ExportValue): ExcelJS.CellValue {
  if (v === null || v === undefined || v === "") return null;
  if (type === "date") return toExcelDate(v) ?? String(v);
  if (isNumeric(type)) return toNumber(v) ?? String(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return v;
}

function displayLength(type: ExportColumnType, v: ExportValue): number {
  if (v === null || v === undefined) return 0;
  if (type === "date") return 10;
  if (type === "year") return 4;
  const n = typeof v === "number" ? v : null;
  if (n !== null && (type === "integer" || type === "money")) return Math.round(n).toLocaleString("en-US").length + (type === "money" ? 1 : 0);
  if (n !== null && type === "percent") return 6;
  return Math.max(...String(v).split("\n").map((l) => l.length));
}

function addSheet(wb: ExcelJS.Workbook, sheet: ExportSheet, name: string, exportedAt: Date) {
  const ws = wb.addWorksheet(name, {
    properties: { tabColor: { argb: CORAL }, defaultRowHeight: 18 },
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const cols = sheet.columns;
  const n = cols.length;

  // Title block: what this is, how it was filtered, when it was exported.
  let r = 1;
  const intro: Array<{ text: string; font: Partial<ExcelJS.Font>; height: number }> = [];
  if (sheet.title) intro.push({ text: sheet.title, font: { name: FONT, size: 14, bold: true, color: { argb: NAVY } }, height: 24 });
  if (sheet.subtitle) intro.push({ text: sheet.subtitle, font: { name: FONT, size: 10, color: { argb: MUTED } }, height: 18 });
  const when = exportedAt.toLocaleString("en-US", { timeZone: "America/Toronto", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  intro.push({ text: `${sheet.rows.length.toLocaleString("en-US")} ${sheet.rows.length === 1 ? "row" : "rows"} · exported ${when} ET`, font: { name: FONT, size: 9, italic: true, color: { argb: MUTED } }, height: 16 });
  for (const line of intro) {
    const row = ws.getRow(r);
    row.getCell(1).value = line.text;
    row.getCell(1).font = line.font;
    row.getCell(1).alignment = { vertical: "middle" };
    row.height = line.height;
    r++;
  }
  r++; // one blank row before the table
  const headerRow = r;

  // Header.
  const header = ws.getRow(headerRow);
  cols.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: "FFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    cell.alignment = { vertical: "middle", horizontal: hAlign(c.type), wrapText: true, indent: hAlign(c.type) === "center" ? 0 : 1 };
    cell.border = { bottom: { style: "medium", color: { argb: CORAL } } };
  });
  header.height = 26;

  // Rows.
  sheet.rows.forEach((data, idx) => {
    const row = ws.getRow(headerRow + 1 + idx);
    const fill: ExcelJS.Fill | undefined = idx % 2 === 1 ? { type: "pattern", pattern: "solid", fgColor: { argb: STRIPE } } : undefined;
    cols.forEach((c, i) => {
      const raw = data[c.key];
      const obj = raw && typeof raw === "object" ? raw : null;
      const v = obj ? obj.value : (raw as ExportValue);
      const type = c.type ?? "text";
      const cell = row.getCell(i + 1);
      const value = excelValue(type, v);
      const url = obj?.url ?? null;
      cell.value = url && value !== null ? { text: String(typeof value === "object" ? v : value), hyperlink: url, tooltip: url } : value;
      const fmt = NUM_FMT[type];
      if (fmt && value !== null && typeof value !== "string") cell.numFmt = fmt;
      const tone = obj?.tone ?? null;
      cell.font = url
        ? { name: FONT, size: 10, color: { argb: "0563C1" }, underline: true, bold: !!tone && tone !== "muted" }
        : { name: FONT, size: 10, color: { argb: tone ? TONE_COLOR[tone] : NAVY }, bold: tone === "warn" || tone === "bad" };
      cell.alignment = { vertical: "top", horizontal: hAlign(type), wrapText: type === "wrap", indent: hAlign(type) === "center" ? 0 : 1 };
      cell.border = { bottom: { style: "hair", color: { argb: LINE } } };
      if (fill) cell.fill = fill;
    });
  });

  // Widths fit the content, within reason.
  cols.forEach((c, i) => {
    const type = c.type ?? "text";
    const longest = Math.max(c.header.length * 0.9, ...sheet.rows.slice(0, 2000).map((d) => {
      const raw = d[c.key];
      return displayLength(type, raw && typeof raw === "object" ? raw.value : (raw as ExportValue));
    }));
    ws.getColumn(i + 1).width = c.width ?? (type === "wrap" ? Math.min(60, Math.max(30, longest * 0.35)) : Math.min(48, Math.max(9, Math.ceil(longest * 1.1) + 4)));
  });

  // The title lines may be longer than the first column; let them spill rather than wrap.
  ws.views = [{ state: "frozen", xSplit: 0, ySplit: headerRow, showGridLines: false, activeCell: `A${headerRow + 1}` }];
  if (sheet.rows.length > 0) ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow + sheet.rows.length, column: n } };
  ws.pageSetup.printTitlesRow = `${headerRow}:${headerRow}`;
}

function isNumeric(type: ExportColumnType | undefined): boolean {
  return type === "integer" || type === "year" || type === "number" || type === "money" || type === "percent";
}

/** Numbers right, dates centred, text left; indent 1 keeps neighbours from touching. */
function hAlign(type: ExportColumnType | undefined): "left" | "right" | "center" {
  return isNumeric(type) ? "right" : type === "date" ? "center" : "left";
}

export async function buildWorkbook(req: ExportRequest, exportedAt = new Date()): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Valstone Salesforce Agent";
  wb.created = exportedAt;
  wb.modified = exportedAt;
  const taken = new Set<string>();
  for (const s of req.sheets) addSheet(wb, s, sheetName(s.name, taken), exportedAt);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
