import { getAnthropicClient, MODELS } from "./anthropic";
import { getSupabaseAdmin } from "./supabase";
import { fetchPageText } from "./scout";
import type { CandidateRow, ScreenStatus } from "./outreach-candidates";

/**
 * Outreach prescreen: the checks Seb used to do by hand on every account in
 * the E1 report before deciding to email again. Is it a software business
 * (a product, not a services shop), and has it been acquired since we last
 * wrote? One site read through Jina, one model call with at most one web
 * search, and the verdict plus a one-line reason lands on the candidate row
 * so the review screen can show it and Seb can overrule it.
 */

export type ScreenVerdict = {
  status: ScreenStatus;
  reason: string;
  facts: {
    softwareType: string | null;
    businessModel: "software" | "software_plus_services" | "services" | "hardware" | "other" | null;
    acquiredBy: string | null;
    acquiredWhen: string | null;
    employeesOnSite: number | null;
    confidence: "high" | "medium" | "low";
    source: string[];
  };
};

const SYSTEM = `You screen companies for Valstone, a permanent-capital acquirer of vertical market software (VMS) businesses serving industrial sectors. Given a company's website text and basic facts, answer two questions only:

1. Is this a software business? "software" means the company's core offering is its own software product (SaaS or on-premise) that customers run or subscribe to. "software_plus_services" means a real product plus implementation or managed services around it (still fine). "services" means consulting, integration of other vendors' software, staffing, agencies, or IT services with no product of their own. "hardware" means the revenue is devices or equipment with software as a feature. "other" is everything else (distributor, media, non-profit, marketplace).
2. Has the company been acquired or merged in the last 18 months, or is it now a subsidiary or brand of a larger group? Look for "part of", "a [Group] company", "acquired by", "now [New name]", "joined", press releases, or a redirect to a parent site. If the page does not settle it, you may run ONE web search for "<company name> acquired" and use only clear, dated results.

Verdict rules:
- "acquired": clear evidence of an acquisition or merger in the last 18 months, or now owned by a PE firm or strategic group since then.
- "not_software": business model is services, hardware, or other.
- "software": software or software_plus_services, and no acquisition evidence.
- "unclear": the site text is too thin, blocked, parked, or you cannot tell. Never guess.

Output ONLY a JSON object:
{"verdict":"software|not_software|acquired|unclear","business_model":"software|software_plus_services|services|hardware|other|null","software_type":"<one short phrase, e.g. 'fleet maintenance software for rail'>|null","acquired_by":"<name>|null","acquired_when":"<month year or year>|null","employees_on_site":<number|null>,"confidence":"high|medium|low","reason":"<one plain sentence, max 160 characters, no dashes>"}`;

function parseVerdict(raw: string): ScreenVerdict | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const verdict = typeof o.verdict === "string" ? o.verdict : "unclear";
  const status: ScreenStatus = verdict === "software" || verdict === "not_software" || verdict === "acquired" ? verdict : "unclear";
  const str = (v: unknown) => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim() : null);
  const bm = str(o.business_model);
  const confidence = o.confidence === "high" || o.confidence === "medium" ? o.confidence : "low";
  return {
    status,
    reason: (str(o.reason) ?? "No reason given.").replace(/\s*[–—]\s*/g, ", ").slice(0, 200),
    facts: {
      softwareType: str(o.software_type),
      businessModel: bm === "software" || bm === "software_plus_services" || bm === "services" || bm === "hardware" || bm === "other" ? bm : null,
      acquiredBy: str(o.acquired_by),
      acquiredWhen: str(o.acquired_when),
      employeesOnSite: typeof o.employees_on_site === "number" && Number.isFinite(o.employees_on_site) ? Math.round(o.employees_on_site) : null,
      confidence,
      source: [],
    },
  };
}

function homepageOf(website: string | null): string | null {
  if (!website) return null;
  const raw = website.trim();
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return `${u.protocol}//${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return null;
  }
}

/** Read the homepage and the about page (when it exists). About 6,000 characters is plenty to classify. */
async function readSite(website: string | null): Promise<{ text: string; pages: string[] }> {
  const home = homepageOf(website);
  if (!home) return { text: "", pages: [] };
  const pages: string[] = [];
  let text = "";
  const homeText = await fetchPageText(home, 20000, 1);
  if (homeText) {
    pages.push(home);
    text += homeText.slice(0, 4500);
  }
  const origin = (() => {
    try {
      return new URL(home).origin;
    } catch {
      return null;
    }
  })();
  if (origin) {
    for (const path of ["/about", "/about-us", "/company"]) {
      const t = await fetchPageText(`${origin}${path}`, 15000, 0);
      if (t && t.length > 200) {
        pages.push(`${origin}${path}`);
        text += `\n\n--- ${path} ---\n${t.slice(0, 2000)}`;
        break;
      }
    }
  }
  return { text: text.trim(), pages };
}

export async function screenCompany(input: { name: string; website: string | null; industry: string | null; employees: number | null }): Promise<ScreenVerdict> {
  const client = getAnthropicClient();
  if (!client) return { status: "error", reason: "ANTHROPIC_API_KEY is not set.", facts: emptyFacts() };
  const site = await readSite(input.website);
  if (!site.text || site.text.length < 150) {
    return {
      status: "unclear",
      reason: input.website ? "The website could not be read (blocked, parked, or empty)." : "No website on the Salesforce account.",
      facts: { ...emptyFacts(), source: site.pages },
    };
  }
  const user = [
    `Company: ${input.name}`,
    `Website: ${input.website ?? "unknown"}`,
    `Salesforce industry: ${input.industry ?? "unknown"}`,
    `Salesforce employees: ${input.employees ?? "unknown"}`,
    "",
    "Website text:",
    site.text.slice(0, 7000),
  ].join("\n");
  const response = await client.messages.create({
    model: MODELS.drafting,
    max_tokens: 400,
    system: SYSTEM,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    messages: [{ role: "user", content: user }],
  });
  const text = response.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  const parsed = parseVerdict(text);
  if (!parsed) return { status: "error", reason: "The model did not return a readable verdict.", facts: { ...emptyFacts(), source: site.pages } };
  parsed.facts.source = site.pages;
  return parsed;
}

function emptyFacts(): ScreenVerdict["facts"] {
  return { softwareType: null, businessModel: null, acquiredBy: null, acquiredWhen: null, employeesOnSite: null, confidence: "low", source: [] };
}

// ── Queue ────────────────────────────────────────────────────────────────────

type QueueRow = Pick<CandidateRow, "sf_account_id" | "account_name" | "website" | "industry" | "employees">;

/** Eligible, open, unscreened accounts, oldest last E1 first: the ones Seb will see next. */
export async function nextToScreen(limit: number): Promise<QueueRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("outreach_candidates")
    .select("sf_account_id, account_name, website, industry, employees")
    .eq("in_pool", true)
    .eq("review_status", "open")
    .eq("rule_status", "eligible")
    .in("screen_status", ["pending", "error"])
    .order("last_e1_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as QueueRow[];
}

export async function countUnscreenedEligible(): Promise<number> {
  const { count, error } = await getSupabaseAdmin()
    .from("outreach_candidates")
    .select("sf_account_id", { count: "exact", head: true })
    .eq("in_pool", true)
    .eq("review_status", "open")
    .eq("rule_status", "eligible")
    .eq("screen_status", "pending");
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function screenAndStore(row: QueueRow): Promise<ScreenVerdict> {
  let verdict: ScreenVerdict;
  try {
    verdict = await screenCompany({ name: row.account_name, website: row.website, industry: row.industry, employees: row.employees });
  } catch (err) {
    verdict = { status: "error", reason: `Check failed: ${err instanceof Error ? err.message : "unknown error"}`.slice(0, 200), facts: emptyFacts() };
  }
  const now = new Date().toISOString();
  const { error } = await getSupabaseAdmin()
    .from("outreach_candidates")
    .update({ screen_status: verdict.status, screen_reason: verdict.reason, screen_facts: verdict.facts, screened_at: now, updated_at: now })
    .eq("sf_account_id", row.sf_account_id);
  if (error) throw new Error(error.message);
  return verdict;
}

/** Screen up to `limit` accounts, a few at a time. Returns counts by verdict. */
export async function runScreenBatch(limit: number, onProgress?: (done: number, total: number) => Promise<void>): Promise<Record<ScreenStatus, number> & { total: number }> {
  const rows = await nextToScreen(limit);
  const counts: Record<ScreenStatus, number> & { total: number } = { pending: 0, software: 0, not_software: 0, acquired: 0, unclear: 0, error: 0, total: rows.length };
  let done = 0;
  const width = 4;
  for (let i = 0; i < rows.length; i += width) {
    const results = await Promise.all(rows.slice(i, i + width).map((r) => screenAndStore(r)));
    for (const v of results) counts[v.status]++;
    done += results.length;
    if (onProgress) await onProgress(done, rows.length).catch(() => undefined);
  }
  return counts;
}
