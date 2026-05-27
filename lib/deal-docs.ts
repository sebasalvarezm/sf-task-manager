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

function tryParseMetrics(text: string): DealMetrics | null {
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== "object") return null;
    return {
      hq: s(obj.hq),
      revUsd: s(obj.rev_usd),
      arrUsd: s(obj.arr_usd),
      ebitda: s(obj.ebitda),
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
export function parseMetricsJson(raw: string): DealMetrics | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  let parsed = tryParseMetrics(cleaned);
  if (parsed) return parsed;

  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fenceMatch) {
    parsed = tryParseMetrics(fenceMatch[1].trim());
    if (parsed) return parsed;
  }

  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    parsed = tryParseMetrics(braceMatch[0]);
    if (parsed) return parsed;
  }

  return null;
}

const EXTRACTION_PROMPT = `You are reading a company teaser / investment memo. Extract these 7 fields and return ONLY a JSON object — no explanation, no markdown fences. Use exactly this shape:
{
  "hq": "Headquarters location (city, country or state)",
  "rev_usd": "Total or annual revenue in USD",
  "arr_usd": "Annual recurring revenue (ARR) in USD",
  "ebitda": "EBITDA (USD amount or margin %)",
  "num_customers": "Number of customers",
  "growth_rate": "Revenue growth rate (%)",
  "churn": "Customer or revenue churn rate (%)"
}
Rules:
- Keep currency, ranges, and approximations verbatim as text (e.g. "~$5M", "$3-4M", "12%").
- If a value is not stated in the document, use "N/A". Never guess or infer.`;

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

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages,
  });

  const textBlocks = message.content.filter((b) => b.type === "text");
  if (textBlocks.length === 0) return null;
  const last = textBlocks[textBlocks.length - 1];
  const responseText = last.type === "text" ? last.text.trim() : "";
  return parseMetricsJson(responseText);
}
