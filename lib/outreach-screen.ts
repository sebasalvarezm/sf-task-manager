import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, MODELS, stripCites } from "./anthropic";
import { trackedCreate } from "./model-cost";
import { getSupabaseAdmin } from "./supabase";
import { fetchPageText, loadGroupFiles, matchGroup, type GroupMatch } from "./scout";
import type { CandidateRow, ScreenStatus } from "./outreach-candidates";

/**
 * Outreach prescreen: the checks Seb used to do by hand on every account in
 * the E1 report before deciding to email again. Is it a software business
 * (a product, not a services shop), and has it been acquired since we last
 * wrote? One site read through Jina and one model call on the site text;
 * then, only for companies that pass, one model call with one web search for
 * an acquisition or investment. The verdict plus a one-line reason lands on the candidate row
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
    /** bootstrapped | pe_backed | vc_backed | public | subsidiary | unknown */
    ownership: string | null;
    /** A funding round or investment in the last 18 months, when found. */
    investment: string | null;
    /** One line for the card: "Ag retailer ERP, Canada, bootstrapped, no acquisition or investment on record." */
    summary: string | null;
    group: GroupMatch | null;
    /** The company's LinkedIn page: from the site's footer, else one web search. */
    linkedin: string | null;
    /** True once the web lookup ran, so a miss is not retried on every batch. */
    linkedinChecked?: boolean;
    confidence: "high" | "medium" | "low";
    source: string[];
  };
};

const SYSTEM = `You screen companies for Valstone, a permanent-capital acquirer of vertical market software (VMS) businesses serving industrial sectors. Given a company's website text and basic facts, answer three questions only:

1. Is this a software business? "software" means the company's core offering is its own software product (SaaS or on-premise) that customers run or subscribe to. "software_plus_services" means a real product plus implementation or managed services around it (still fine). "services" means consulting, integration of other vendors' software, staffing, agencies, or IT services with no product of their own. "hardware" means the revenue is devices or equipment with software as a feature. "other" is everything else (distributor, media, non-profit, marketplace).
2. Is the end market one Valstone goes after? Valstone buys software that runs an industrial, agricultural, construction, transportation, manufacturing, or similar B2B operating business. Consumer apps, software for dentists, lawyers, schools, churches, gyms, restaurants, real estate agents, marketing teams, HR, and generic horizontal tools are not the target. After these instructions you may get a list of markets Seb has excluded by hand before, with his own words on why; treat those as the rule, and apply the same judgement to close cousins. Otherwise lean to "software": a wrong_market verdict needs a clear, specific reason, not a hunch.
3. Does the site itself show the company was acquired or merged in the last 18 months, took outside investment (a funding round, PE or VC money) in the last 18 months, or is now a subsidiary or brand of a larger group? Look for "part of", "a [Group] company", "acquired by", "now [New name]", "joined", "backed by", "raised", press releases, or a redirect to a parent site. Use the site text only. A separate web search check runs afterwards on every company you pass as "software", so when the site says nothing, set acquired_by and investment to null and ownership to what the site shows (often "unknown"), and judge questions 1 and 2 on their own.

Verdict rules:
- "acquired": clear evidence of an acquisition or merger in the last 18 months, or now owned by a PE firm or strategic group since then.
- "not_software": business model is services, hardware, or other.
- "wrong_market": it is software, but the end market is one Valstone does not go after (question 2).
- "software": software or software_plus_services, a target end market, and no acquisition evidence (question 3).
- "unclear": the site text is too thin, blocked, parked, or you cannot tell. Never guess.

Also classify ownership: "bootstrapped" (founder or privately owned, no outside capital found), "pe_backed", "vc_backed", "public", "subsidiary", or "unknown".

Output ONLY a JSON object:
{"verdict":"software|not_software|wrong_market|acquired|unclear","business_model":"software|software_plus_services|services|hardware|other|null","software_type":"<one short phrase, e.g. 'fleet maintenance software for rail'>|null","acquired_by":"<name>|null","acquired_when":"<month year or year>|null","ownership":"bootstrapped|pe_backed|vc_backed|public|subsidiary|unknown","investment":"<e.g. 'Series A, March 2026'>|null","employees_on_site":<number|null>,"confidence":"high|medium|low","what":"<what they sell in 3 to 6 words, e.g. 'Ag retailer ERP'>","summary":"<what they sell in 3 to 6 words, then ownership and deal status, e.g. 'Ag retailer ERP, bootstrapped, no acquisition or investment on record'>","reason":"<one plain sentence, max 160 characters, no dashes>"}`;

/**
 * Second pass, only for companies the site check passed as "software": one
 * web search for an acquisition, a merger or outside money. Splitting it out
 * is the cost fix (Oct 2026). A search pastes several result pages into the
 * model's reading, so a check with a search costs about four times one
 * without, and it used to run on companies the site text had already ruled
 * out. It also used to be optional, so roughly half the good candidates never
 * got searched; now every one does.
 */
const OWNERSHIP_SYSTEM = `You check one company for recent ownership changes, for Valstone, a permanent-capital acquirer of vertical market software businesses. Always run exactly ONE web search for the company name with the words acquired, acquisition, investment, funding. Count a result only when it is clearly this company (same name and the same website domain, product or location); a different company with a similar name does not count.

"acquired" is true when there is clear, dated evidence that the company was acquired or merged within the last 18 months, or is now owned by a PE firm or strategic group since then. Otherwise false. Never guess.

Also classify ownership: "bootstrapped" (founder or privately owned, no outside capital found), "pe_backed", "vc_backed", "public", "subsidiary", or "unknown". Report a funding round or investment from the last 18 months in "investment".

After these instructions you may get Seb's own skip rules about ownership (for example skipping a certain kind of backing). If what you found clearly triggers one, name it in "skip_rule"; otherwise null. Do not apply a rule on a loose resemblance.

Output ONLY a JSON object:
{"acquired":true|false,"acquired_by":"<name>|null","acquired_when":"<month year or year>|null","ownership":"bootstrapped|pe_backed|vc_backed|public|subsidiary|unknown","investment":"<e.g. 'Series A, March 2026'>|null","skip_rule":"<the rule, in a few words>|null","evidence":"<one plain sentence, max 160 characters, no dashes>|null"}`;

type OwnershipCheck = {
  acquired: boolean;
  acquiredBy: string | null;
  acquiredWhen: string | null;
  ownership: string | null;
  investment: string | null;
  skipRule: string | null;
  evidence: string | null;
};

const cleanStr = (v: unknown) => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim().replace(/\s*[–—]\s*/g, ", ") : null);

export function parseOwnershipCheck(raw: string): OwnershipCheck | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    acquired: o.acquired === true || o.acquired === "true",
    acquiredBy: cleanStr(o.acquired_by),
    acquiredWhen: cleanStr(o.acquired_when),
    ownership: cleanStr(o.ownership),
    investment: cleanStr(o.investment),
    skipRule: cleanStr(o.skip_rule),
    evidence: cleanStr(o.evidence)?.slice(0, 200) ?? null,
  };
}

const OWNERSHIP_WORDS: Record<string, string> = {
  bootstrapped: "bootstrapped",
  pe_backed: "PE-backed",
  vc_backed: "VC-backed",
  public: "public",
  subsidiary: "subsidiary",
};

/** The card line after the search: "Ag retailer ERP, bootstrapped, no acquisition or investment on record". */
export function ownershipSummary(what: string | null, c: OwnershipCheck | null): string | null {
  if (!what) return null;
  if (!c) return `${what}, acquisition check did not run`;
  const parts = [what];
  const own = c.ownership ? OWNERSHIP_WORDS[c.ownership] : undefined;
  if (own) parts.push(own);
  if (c.acquired) parts.push(`acquired${c.acquiredBy ? ` by ${c.acquiredBy}` : ""}${c.acquiredWhen ? ` (${c.acquiredWhen})` : ""}`);
  else if (c.investment) parts.push(`raised ${c.investment}`);
  else parts.push("no acquisition or investment on record");
  return parts.join(", ").slice(0, 160);
}

/** Apply the search result to a "software" verdict. Pure, so it is tested. */
export function applyOwnershipCheck(v: ScreenVerdict, what: string | null, c: OwnershipCheck | null): ScreenVerdict {
  if (!c) {
    return { ...v, facts: { ...v.facts, summary: ownershipSummary(what, null) ?? v.facts.summary, confidence: "low" } };
  }
  const facts = {
    ...v.facts,
    acquiredBy: c.acquiredBy ?? v.facts.acquiredBy,
    acquiredWhen: c.acquiredWhen ?? v.facts.acquiredWhen,
    ownership: c.ownership && c.ownership !== "unknown" ? c.ownership : v.facts.ownership,
    investment: c.investment ?? v.facts.investment,
    summary: ownershipSummary(what, c) ?? v.facts.summary,
  };
  if (c.acquired) {
    const who = c.acquiredBy ? `Acquired by ${c.acquiredBy}${c.acquiredWhen ? ` in ${c.acquiredWhen}` : ""}.` : null;
    return { status: "acquired", reason: (c.evidence ?? who ?? "Recent acquisition found in the web search.").slice(0, 200), facts };
  }
  if (c.skipRule) {
    return { status: "acquired", reason: `Your rule: ${c.skipRule}.${c.evidence ? ` ${c.evidence}` : ""}`.slice(0, 200), facts };
  }
  return { ...v, facts };
}

function parseVerdict(raw: string): (ScreenVerdict & { what: string | null }) | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const verdict = typeof o.verdict === "string" ? o.verdict : "unclear";
  const status: ScreenStatus = verdict === "software" || verdict === "not_software" || verdict === "wrong_market" || verdict === "acquired" ? verdict : "unclear";
  const str = (v: unknown) => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim() : null);
  const bm = str(o.business_model);
  const confidence = o.confidence === "high" || o.confidence === "medium" ? o.confidence : "low";
  return {
    what: str(o.what)?.replace(/\s*[\u2013\u2014]\s*/g, ", ").replace(/\.$/, "").slice(0, 80) ?? null,
    status,
    reason: (str(o.reason) ?? "No reason given.").replace(/\s*[–—]\s*/g, ", ").slice(0, 200),
    facts: {
      softwareType: str(o.software_type),
      businessModel: bm === "software" || bm === "software_plus_services" || bm === "services" || bm === "hardware" || bm === "other" ? bm : null,
      acquiredBy: str(o.acquired_by),
      acquiredWhen: str(o.acquired_when),
      employeesOnSite: typeof o.employees_on_site === "number" && Number.isFinite(o.employees_on_site) ? Math.round(o.employees_on_site) : null,
      ownership: str(o.ownership),
      investment: str(o.investment),
      summary: (str(o.summary) ?? null)?.replace(/\s*[\u2013\u2014]\s*/g, ", ").replace(/\.$/, "").slice(0, 160) ?? null,
      group: null,
      linkedin: null,
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
  const excluded = await excludedMarkets().catch(() => "");
  const lessons = await skipLessons().catch(() => "");
  const today = new Date().toISOString().slice(0, 10);
  // Seb's rules are the same for every company in a batch, so they sit in the
  // system prompt behind a cache marker: after the first call of a batch the
  // model re-reads them at a tenth of the price. Only the company changes.
  const rules = [
    ...(excluded ? ["Markets Seb has excluded by hand (company: his note):", excluded, ""] : []),
    ...(lessons
      ? [
          "Other companies Seb skipped by hand, with his reason and note. Treat each note as a rule: if this company has the same problem (for example most staff outside the target geography, or too small, or mostly services), exclude it with verdict wrong_market (or acquired for ownership) and say which rule in the reason. Do not exclude on a loose resemblance.",
          lessons,
        ]
      : []),
  ].join("\n").trim();
  const system: Anthropic.Messages.TextBlockParam[] = [
    { type: "text", text: SYSTEM },
    ...(rules ? [{ type: "text" as const, text: rules }] : []),
  ];
  system[system.length - 1] = { ...system[system.length - 1], cache_control: { type: "ephemeral" } };
  const user = [
    `Today: ${today}`,
    `Company: ${input.name}`,
    `Website: ${input.website ?? "unknown"}`,
    `Salesforce industry: ${input.industry ?? "unknown"}`,
    `Salesforce employees: ${input.employees ?? "unknown"}`,
    "",
    "Website text:",
    site.text.slice(0, 7000),
  ].join("\n");
  // Step 1: the site alone. No web search here: most companies fail on
  // business model or end market, which the site settles, and a search would
  // quadruple the cost of every one of those.
  const ask = async () => {
    const response = await trackedCreate(client, "outreach_screen", {
      model: MODELS.drafting,
      max_tokens: 500,
      system,
      messages: [{ role: "user", content: user }],
    });
    return stripCites(response.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
  };
  let parsed = parseVerdict(await ask());
  if (!parsed) parsed = parseVerdict(await ask());
  if (!parsed) return { status: "error", reason: "The model did not return a readable verdict.", facts: { ...emptyFacts(), source: site.pages } };
  const { what, ...rest } = parsed;
  let verdict: ScreenVerdict = rest;
  verdict.facts.source = site.pages;
  verdict.facts.linkedin = findLinkedInCompanyUrl(site.text);
  // Step 2: only for companies that passed, one web search for an acquisition
  // or outside money. Many small VMS companies never put either on their site
  // (Seb, Oct 2026), so every passing company gets it.
  if (verdict.status === "software") {
    const check = await checkOwnership(client, input.name, input.website, lessons, today).catch(() => null);
    verdict = applyOwnershipCheck(verdict, what ?? verdict.facts.softwareType, check);
  }
  if (verdict.status === "software") {
    if (!verdict.facts.linkedin) {
      verdict.facts.linkedin = await lookupLinkedInUrl(input.name, input.website).catch(() => null);
      verdict.facts.linkedinChecked = true;
    }
    // Same portfolio-group classifier Sourcing uses, run once here so the push
    // carries the group and Sourcing can skip its own classification step.
    verdict.facts.group = await matchGroup(client, site.text, loadGroupFiles()).catch(() => null);
  }
  return verdict;
}

async function checkOwnership(client: Anthropic, name: string, website: string | null, lessons: string, today: string): Promise<OwnershipCheck | null> {
  const system: Anthropic.Messages.TextBlockParam[] = [
    { type: "text", text: OWNERSHIP_SYSTEM },
    ...(lessons ? [{ type: "text" as const, text: `Seb's skip rules (reason, company: note). Only the ones about ownership or backing apply here:\n${lessons}` }] : []),
  ];
  system[system.length - 1] = { ...system[system.length - 1], cache_control: { type: "ephemeral" } };
  const host = (() => {
    const home = homepageOf(website);
    try {
      return home ? new URL(home).hostname.replace(/^www\./, "") : null;
    } catch {
      return null;
    }
  })();
  const response = await trackedCreate(client, "outreach_screen", {
    model: MODELS.drafting,
    max_tokens: 600,
    system,
    tools: [{ type: "web_search_20250305" as const, name: "web_search" as const, max_uses: 1 }],
    messages: [{ role: "user", content: `Today: ${today}\nCompany: ${name}\nWebsite: ${host ?? website ?? "unknown"}` }],
  });
  return parseOwnershipCheck(stripCites(response.content.map((b) => (b.type === "text" ? b.text : "")).join("")));
}

/**
 * Seb's own "Wrong end market: <note>" skips, newest first, as examples for
 * the check. Cached for ten minutes so a batch of 60 screens reads them once.
 */
let excludedCache: { at: number; text: string } | null = null;
export async function excludedMarkets(): Promise<string> {
  if (excludedCache && Date.now() - excludedCache.at < 10 * 60 * 1000) return excludedCache.text;
  const { data, error } = await getSupabaseAdmin()
    .from("outreach_candidates")
    .select("account_name, skip_reason, screen_facts")
    .eq("review_status", "skipped")
    .ilike("skip_reason", "Wrong end market%")
    .order("reviewed_at", { ascending: false })
    .limit(60);
  if (error) throw new Error(error.message);
  const text = formatExcluded((data ?? []) as Array<{ account_name: string; skip_reason: string | null; screen_facts: { softwareType?: string | null } | null }>);
  excludedCache = { at: Date.now(), text };
  return text;
}

let lessonsCache: { at: number; text: string } | null = null;
/** Every other skip reason that came with a note, newest first. */
export async function skipLessons(): Promise<string> {
  if (lessonsCache && Date.now() - lessonsCache.at < 10 * 60 * 1000) return lessonsCache.text;
  const { data, error } = await getSupabaseAdmin()
    .from("outreach_candidates")
    .select("account_name, skip_reason")
    .eq("review_status", "skipped")
    .like("skip_reason", "%:%")
    .not("skip_reason", "ilike", "Wrong end market%")
    .order("reviewed_at", { ascending: false })
    .limit(60);
  if (error) throw new Error(error.message);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const r of (data ?? []) as Array<{ account_name: string; skip_reason: string | null }>) {
    const raw = (r.skip_reason ?? "").trim();
    const i = raw.indexOf(":");
    const reason = raw.slice(0, i).trim();
    const note = raw.slice(i + 1).trim();
    if (!note) continue;
    const key = `${reason}|${note}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${reason}, ${r.account_name}: ${note}`);
    if (lines.length >= 40) break;
  }
  const text = lines.join("\n");
  lessonsCache = { at: Date.now(), text };
  return text;
}

export function formatExcluded(rows: Array<{ account_name: string; skip_reason: string | null; screen_facts: { softwareType?: string | null } | null }>): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const note = (r.skip_reason ?? "").replace(/^wrong end market:?\s*/i, "").trim();
    const what = r.screen_facts?.softwareType?.trim();
    const line = note ? `${r.account_name}${what ? ` (${what})` : ""}: ${note}` : what ? `${r.account_name} (${what})` : r.account_name;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${line}`);
    if (lines.length >= 40) break;
  }
  return lines.join("\n");
}

/** Jina keeps links in its markdown, so the footer's LinkedIn icon is findable. Company pages only, never a person. */
export function findLinkedInCompanyUrl(text: string): string | null {
  const m = text.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|school|showcase)\/[A-Za-z0-9._%-]+\/?/i);
  if (!m) return null;
  return m[0].replace(/^http:/i, "https:").replace(/\/$/, "");
}

/**
 * The site did not link its LinkedIn page: one web search for "<name> <domain>
 * linkedin" through the small model, and we keep only a company-page URL whose
 * slug the model confirmed. Returns null when nothing convincing comes back.
 */
export async function lookupLinkedInUrl(name: string, website: string | null): Promise<string | null> {
  const client = getAnthropicClient();
  if (!client) return null;
  const host = (() => {
    const home = homepageOf(website);
    try {
      return home ? new URL(home).hostname.replace(/^www\./, "") : null;
    } catch {
      return null;
    }
  })();
  const response = await trackedCreate(client, "outreach_linkedin", {
    model: MODELS.extraction,
    max_tokens: 200,
    system:
      "You find the official LinkedIn company page for a business. Run one web search for the company name, its website domain and the word linkedin. Reply with the single URL of the company's own LinkedIn page (linkedin.com/company/...), nothing else. If no result is clearly that company (same name and same website or location), reply NONE. Never return a person's profile.",
    tools: [{ type: "web_search_20250305" as const, name: "web_search" as const, max_uses: 1 }],
    messages: [{ role: "user", content: `Company: ${name}\nWebsite: ${host ?? website ?? "unknown"}` }],
  });
  const text = stripCites(response.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
  if (/^\s*NONE\b/i.test(text)) return null;
  return findLinkedInCompanyUrl(text);
}

/** Already-checked software rows that never had the web lookup: run it now, a few at a time. */
export async function backfillLinkedIn(limit: number): Promise<number> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("outreach_candidates")
    .select("sf_account_id, account_name, website, screen_facts")
    .eq("in_pool", true)
    .eq("review_status", "open")
    .eq("rule_status", "eligible")
    .eq("screen_status", "software")
    .is("screen_facts->>linkedin", null)
    .is("screen_facts->>linkedinChecked", null)
    .order("last_e1_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ sf_account_id: string; account_name: string; website: string | null; screen_facts: Record<string, unknown> | null }>;
  const width = 4;
  for (let i = 0; i < rows.length; i += width) {
    await Promise.all(
      rows.slice(i, i + width).map(async (r) => {
        const linkedin = await lookupLinkedInUrl(r.account_name, r.website).catch(() => null);
        const facts = { ...(r.screen_facts ?? {}), linkedin, linkedinChecked: true };
        await db.from("outreach_candidates").update({ screen_facts: facts, updated_at: new Date().toISOString() }).eq("sf_account_id", r.sf_account_id);
      }),
    );
  }
  return rows.length;
}

export async function countLinkedInBackfill(): Promise<number> {
  const { count, error } = await getSupabaseAdmin()
    .from("outreach_candidates")
    .select("sf_account_id", { count: "exact", head: true })
    .eq("in_pool", true)
    .eq("review_status", "open")
    .eq("rule_status", "eligible")
    .eq("screen_status", "software")
    .is("screen_facts->>linkedin", null)
    .is("screen_facts->>linkedinChecked", null);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

function emptyFacts(): ScreenVerdict["facts"] {
  return { softwareType: null, businessModel: null, acquiredBy: null, acquiredWhen: null, employeesOnSite: null, ownership: null, investment: null, summary: null, group: null, linkedin: null, confidence: "low", source: [] };
}

// ── Queue ────────────────────────────────────────────────────────────────────

type QueueRow = Pick<CandidateRow, "sf_account_id" | "account_name" | "website" | "industry" | "employees">;

/**
 * Eligible, open, unscreened accounts, oldest last E1 first: the ones Seb will
 * see next. Only "pending": an "error" row stays out until it is reset by
 * hand. Including errors here once put eleven unreadable rows at the front of
 * every batch, re-checked ten times over in an evening.
 */
export async function nextToScreen(limit: number, exclude: string[] = []): Promise<QueueRow[]> {
  let q = getSupabaseAdmin()
    .from("outreach_candidates")
    .select("sf_account_id, account_name, website, industry, employees")
    .eq("in_pool", true)
    .eq("review_status", "open")
    .eq("rule_status", "eligible")
    .eq("screen_status", "pending");
  // Rows this job already handled never come back in the same job, even if a
  // verdict write failed: a row costs one check per job, full stop.
  if (exclude.length > 0) q = q.not("sf_account_id", "in", `(${exclude.map((id) => `"${id.replace(/"/g, "")}"`).join(",")})`);
  const { data, error } = await q.order("last_e1_at", { ascending: true, nullsFirst: true }).limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as QueueRow[];
}

/** Rows the check has written a verdict on since midnight UTC: the number the daily cap is measured against. */
export async function countScreenedToday(): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { count, error } = await getSupabaseAdmin()
    .from("outreach_candidates")
    .select("sf_account_id", { count: "exact", head: true })
    .gte("screened_at", start.toISOString());
  if (error) throw new Error(error.message);
  return count ?? 0;
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

/** Screen up to `limit` accounts, a few at a time. Returns counts by verdict and the ids handled. */
export async function runScreenBatch(limit: number, onProgress?: (done: number, total: number) => Promise<void>, exclude: string[] = []): Promise<Record<ScreenStatus, number> & { total: number; ids: string[] }> {
  const rows = await nextToScreen(limit, exclude);
  const counts: Record<ScreenStatus, number> & { total: number; ids: string[] } = { pending: 0, software: 0, not_software: 0, wrong_market: 0, acquired: 0, unclear: 0, error: 0, total: rows.length, ids: rows.map((r) => r.sf_account_id) };
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
