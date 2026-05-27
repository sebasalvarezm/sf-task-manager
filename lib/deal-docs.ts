import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "@/lib/anthropic";

// Supabase Storage bucket (private). See supabase/setup.sql for setup steps.
export const DEAL_DOCS_BUCKET = "deal-docs";

// Allowed upload types → file extension. Anything not in this map is rejected
// server-side in the sign-upload route (don't trust the client extension alone).
export const ALLOWED_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

export const PDF_MIME = "application/pdf";

export function extForMime(mime: string): string | null {
  return ALLOWED_MIME[mime] ?? null;
}

// ── Types ──────────────────────────────────────────────────────────────────

export type ExtractionStatus = "pending" | "done" | "failed" | "skipped";

// The 7 metrics, all free-text (values may be ranges, "~$5M", "N/A").
export type DealMetrics = {
  hq: string | null;
  revUsd: string | null;
  arrUsd: string | null;
  ebitda: string | null;
  numCustomers: string | null;
  growthRate: string | null;
  churn: string | null;
};

// Shape sent to the browser (camelCase).
export type DealDoc = DealMetrics & {
  accountId: string;
  filename: string;
  mimeType: string;
  fileSize: number | null;
  extractionStatus: ExtractionStatus;
  uploadedAt: string | null;
  updatedAt: string | null;
};

// Row shape as stored in Supabase (snake_case).
export type DealDocRow = {
  sf_account_id: string;
  account_name: string | null;
  storage_path: string;
  filename: string;
  mime_type: string;
  file_size: number | null;
  hq: string | null;
  rev_usd: string | null;
  arr_usd: string | null;
  ebitda: string | null;
  num_customers: string | null;
  growth_rate: string | null;
  churn: string | null;
  extraction_status: ExtractionStatus;
  uploaded_at: string | null;
  updated_at: string | null;
};

// Map a DB row → the camelCase DealDoc the UI consumes.
export function rowToDealDoc(r: DealDocRow): DealDoc {
  return {
    accountId: r.sf_account_id,
    filename: r.filename,
    mimeType: r.mime_type,
    fileSize: r.file_size,
    hq: r.hq,
    revUsd: r.rev_usd,
    arrUsd: r.arr_usd,
    ebitda: r.ebitda,
    numCustomers: r.num_customers,
    growthRate: r.growth_rate,
    churn: r.churn,
    extractionStatus: r.extraction_status,
    uploadedAt: r.uploaded_at,
    updatedAt: r.updated_at,
  };
}

// Map metrics → the snake_case columns for a DB write.
export function metricsToColumns(m: DealMetrics) {
  return {
    hq: m.hq,
    rev_usd: m.revUsd,
    arr_usd: m.arrUsd,
    ebitda: m.ebitda,
    num_customers: m.numCustomers,
    growth_rate: m.growthRate,
    churn: m.churn,
  };
}

// ── AI extraction (PDF only) ─────────────────────────────────────────────────

function s(v: unknown): string | null {
  if (v == null) return null;
  const str = String(v).trim();
  // Treat empty / explicit "N/A" the same way upstream, but keep "N/A" visible
  // so the user sees the model looked and found nothing rather than a blank.
  return str ? str : null;
}

// ── FX conversion (Rev / ARR / EBITDA are normalized to USD) ─────────────────
// Memos sometimes quote figures in GBP, AUD, EUR, etc. We extract the original
// amount + currency, then convert to USD using live rates so the three money
// fields always read in USD, with the original shown alongside for reference.

type UsdRates = Record<string, number>; // units of <currency> per 1 USD

let fxCache: { rates: UsdRates; fetchedAt: number } | null = null;
const FX_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — rates barely move intraday

async function getUsdRates(): Promise<UsdRates | null> {
  if (fxCache && Date.now() - fxCache.fetchedAt < FX_TTL_MS) {
    return fxCache.rates;
  }
  try {
    // Free, no-key endpoint (USD base). { rates: { GBP: 0.79, AUD: 1.5, ... } }
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      const rates = data?.rates as UsdRates | undefined;
      if (rates && typeof rates.USD === "number") {
        fxCache = { rates, fetchedAt: Date.now() };
        return rates;
      }
    }
  } catch {
    /* fall through to last-known rates (may be null) */
  }
  return fxCache?.rates ?? null;
}

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$",
  GBP: "£",
  EUR: "€",
  AUD: "A$",
  CAD: "C$",
  NZD: "NZ$",
  JPY: "¥",
};

function trimZeros(str: string): string {
  return str.replace(/\.?0+$/, "");
}

// 2_193_000 → "2.19M"; 751_000 → "751K"; 51 → "51"
function shortNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return trimZeros((n / 1_000_000_000).toFixed(2)) + "B";
  if (abs >= 1_000_000) return trimZeros((n / 1_000_000).toFixed(2)) + "M";
  if (abs >= 1_000) return String(Math.round(n / 1_000)) + "K";
  return String(Math.round(n));
}

function fmtOriginal(amount: number, currency: string): string {
  const sym = CURRENCY_SYMBOL[currency];
  return sym
    ? `${sym}${shortNumber(amount)}`
    : `${shortNumber(amount)} ${currency}`;
}

type RawMoney = {
  amount: number | null;
  currency: string | null;
  note: string | null;
};

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.\-]/g, "");
    if (!cleaned) return null;
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseMoney(v: unknown): RawMoney {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const note = s(o.note);
    return {
      amount: num(o.amount),
      currency: s(o.currency),
      note: note && note.toUpperCase() !== "N/A" ? note : null,
    };
  }
  // String / other → no numeric figure to convert; keep it as a note.
  const t = s(v);
  return {
    amount: null,
    currency: null,
    note: t && t.toUpperCase() !== "N/A" ? t : null,
  };
}

// Build the final USD-denominated text stored in rev_usd / arr_usd / ebitda.
function formatMoneyUsd(rm: RawMoney, rates: UsdRates | null): string | null {
  if (rm.amount == null) return rm.note ?? "N/A";
  const cur = (rm.currency || "USD").toUpperCase();
  const noteSuffix = rm.note ? ` · ${rm.note}` : "";

  if (cur === "USD") return `$${shortNumber(rm.amount)}${noteSuffix}`;

  const rate = rates?.[cur];
  if (!rate) {
    // No rate available — show the original, clearly flagged as unconverted.
    return `${fmtOriginal(rm.amount, cur)} (USD n/a)${noteSuffix}`;
  }
  const usd = rm.amount / rate;
  return `$${shortNumber(usd)} (≈ ${fmtOriginal(rm.amount, cur)})${noteSuffix}`;
}

function tryParseMetrics(
  text: string,
  rates: UsdRates | null,
): DealMetrics | null {
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== "object") return null;
    return {
      hq: s(obj.hq),
      // Accept the new {amount,currency,note} shape; tolerate an old flat string.
      revUsd: formatMoneyUsd(parseMoney(obj.rev ?? obj.rev_usd), rates),
      arrUsd: formatMoneyUsd(parseMoney(obj.arr ?? obj.arr_usd), rates),
      ebitda: formatMoneyUsd(parseMoney(obj.ebitda), rates),
      numCustomers: s(obj.num_customers),
      growthRate: s(obj.growth_rate),
      churn: s(obj.churn),
    };
  } catch {
    return null;
  }
}

// Tolerant parser (mirrors parseOnePagerJson in app/api/prep/generate/route.ts):
// direct parse → fenced block → first brace block.
export function parseMetricsJson(
  raw: string,
  rates: UsdRates | null,
): DealMetrics | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  let parsed = tryParseMetrics(cleaned, rates);
  if (parsed) return parsed;

  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fenceMatch) {
    parsed = tryParseMetrics(fenceMatch[1].trim(), rates);
    if (parsed) return parsed;
  }

  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    parsed = tryParseMetrics(braceMatch[0], rates);
    if (parsed) return parsed;
  }

  return null;
}

const EXTRACTION_PROMPT = `You are reading a company teaser / investment memo. Extract these fields and return ONLY a JSON object — no explanation, no markdown fences. Use exactly this shape:
{
  "hq": "Headquarters location (city, country or state)",
  "rev": { "amount": <number>, "currency": "<ISO 4217 code>", "note": "<short qualifier or empty>" },
  "arr": { "amount": <number>, "currency": "<ISO 4217 code>", "note": "<short qualifier or empty>" },
  "ebitda": { "amount": <number>, "currency": "<ISO 4217 code>", "note": "<short qualifier or empty>" },
  "num_customers": "Number of customers",
  "growth_rate": "Revenue growth rate (%)",
  "churn": "Customer or revenue churn rate (%)"
}
Rules for rev, arr, ebitda:
- PERIOD PREFERENCE: if the document gives a FY2026 forecast/projected/budgeted figure (e.g. "FY26E", "2026 forecast", "2026 budget", "FY2026 projected"), use THAT figure. Only fall back to the most recent actual/historical figure (e.g. FY2025 full-year) when no 2026 forecast is provided.
- "amount" is that chosen figure as a plain number in its ORIGINAL currency units (e.g. £2,193k → 2193000, $4.2M → 4200000). No symbols, commas, or text.
- "currency" is the 3-letter ISO code as stated in the document (e.g. "GBP", "AUD", "EUR", "USD"). If the document never states a currency, use "USD".
- "note" MUST state the period/basis of the figure you chose (e.g. "FY26 forecast", "FY25 actual", "FY26E adjusted"); use "" only if the document states no period at all.
- If a figure is genuinely not in the document, set "amount" to null and "note" to "N/A".
Rules for hq, num_customers, growth_rate, churn:
- Plain text. Keep ranges/approximations verbatim (e.g. "~5%", "20% targeted"). If absent, use "N/A".
- Never guess or infer values that are not in the document.`;

// Send a base64 PDF to Claude and extract the 7 metrics. Returns null if the
// AI is not configured or the response can't be parsed — callers treat that as
// "extraction failed" and fall back to manual entry. Mirrors the Anthropic
// usage in app/api/prep/generate/route.ts.
export async function extractMetricsFromPdf(
  base64: string,
  filename: string,
): Promise<DealMetrics | null> {
  const anthropic = getAnthropicClient();
  if (!anthropic) return null;

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: base64,
          },
          title: filename,
        },
        { type: "text", text: EXTRACTION_PROMPT },
      ],
    },
  ];

  // Fetch FX rates in parallel with the extraction call — both are independent.
  const [message, rates] = await Promise.all([
    anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages,
    }),
    getUsdRates(),
  ]);

  const textBlocks = message.content.filter((b) => b.type === "text");
  if (textBlocks.length === 0) return null;
  const last = textBlocks[textBlocks.length - 1];
  const responseText = last.type === "text" ? last.text.trim() : "";
  return parseMetricsJson(responseText, rates);
}
