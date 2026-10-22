import { getAnthropicClient, MODELS, stripCites } from "./anthropic";
import { getSupabaseAdmin } from "./supabase";
import { sfQuery } from "./sf-query";
import { fetchContactsForAccounts, type SfContact } from "./salesforce-contacts";
import { sfFetch } from "./sf-query";
import { verifyEmail, type VerifyDetail, type VerifyResult } from "./email-verify";
import { listSequences, listMailboxes, findProspectByEmail, createProspect, addProspectToSequence, setProspectCustomFields, outreachRequest, type OutreachSequence } from "./outreach";
import { getValidCredentials } from "./token-manager";
import { getStoredSignature, saveStoredSignature, composeHtmlBody, textToHtml } from "./outlook-signature";
import { importSignatureFromSentItems } from "./microsoft";
import { trackedCreate } from "./model-cost";
import { recipientTimeZone, planSendSlots } from "./send-slots";
import { currentWeekStart, type WeeklyOutreachItem } from "./weekly-outreach";
import { shortenRestaurantName } from "./email-prepackage";
import { getJob, markSucceeded } from "./jobs";
import { rerunHookResearch, reclassifySourcingResult, type SourcingResult } from "./jobs/sourcing-runner";
import { findGroupFileName, loadGroupFiles } from "./scout";

/**
 * The send queue: everything between "Sourcing produced a draft" and "a
 * scheduled mailing sits in Outreach". The app does the checking (contact,
 * email verification, draft review, sequence match) before Seb looks; he
 * confirms or fixes; the scheduler does the Outreach work and picks the time.
 */

export type E1Status = "pending" | "review" | "ready" | "approved" | "scheduling" | "dry_run" | "scheduled" | "sent" | "failed" | "rejected";

export type ReviewFlag = { kind: "spelling" | "town" | "restaurant" | "hook" | "contact" | "email" | "sequence" | "placeholder" | "other"; message: string; severity: "red" | "yellow" };

/** Where the opening hook came from and how far to trust it; shown on the row. */
export type HookInfo = {
  text: string | null;
  anchor: string | null;
  evidence: string | null;
  sourceLabel: string | null;
  sourceUrl: string | null;
  source: "wayback" | "web_research" | null;
  level: "high" | "medium" | "low" | "none";
  /** One plain sentence saying what backs the hook. */
  note: string;
};

export type ContactOption = { id: string; name: string; firstName: string | null; lastName: string | null; title: string | null; email: string | null; rank: number };

export type E1Send = {
  id: string;
  week_start: string;
  weekly_outreach_id: string | null;
  sourcing_job_id: string | null;
  sf_account_id: string;
  account_name: string;
  website: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  group_name: string | null;
  sequence_id: string | null;
  sequence_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_title: string | null;
  contact_email: string | null;
  contact_options: ContactOption[];
  verify_result: VerifyResult | null;
  verify_detail: VerifyDetail | null;
  verified_email: string | null;
  review_flags: ReviewFlag[];
  reviewed_at: string | null;
  hook: HookInfo | null;
  /** The restaurants Sourcing found near the company, for the subject-line pick. */
  restaurant_options: Array<{ name: string; description: string }>;
  subject: string | null;
  body: string | null;
  status: E1Status;
  status_reason: string | null;
  scheduled_for: string | null;
  time_zone: string | null;
  outreach_prospect_id: string | null;
  outreach_state_id: string | null;
  outreach_task_id: string | null;
  outreach_mailing_id: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SendSettings = {
  /** Create the Outreach draft but never flip it to scheduled. On until Seb has seen one real draft. */
  dryRun: boolean;
  /** Bridge mode: on schedule, only enrol the prospect (custom1 set, E1 task logged); Seb sends the E1 himself from Outreach. */
  manualSend: boolean;
  /** Group name → Outreach sequence id, for the groups the name match gets wrong. */
  sequenceMap: Record<string, string>;
  /** Plain-text signature override for Outreach sends; empty means use the stored Outlook signature. */
  signatureText: string;
  /** Send the pre-review flags through the model (about 2 cents per email). */
  reviewWithModel: boolean;
};

const SETTINGS_KEY = "e1_send_settings";
const DEFAULT_SETTINGS: SendSettings = { dryRun: true, manualSend: true, sequenceMap: {}, signatureText: "", reviewWithModel: true };

export async function getSendSettings(): Promise<SendSettings> {
  const { data } = await getSupabaseAdmin().from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
  const v = (data?.value ?? {}) as Partial<SendSettings>;
  return {
    dryRun: typeof v.dryRun === "boolean" ? v.dryRun : DEFAULT_SETTINGS.dryRun,
    manualSend: typeof v.manualSend === "boolean" ? v.manualSend : DEFAULT_SETTINGS.manualSend,
    sequenceMap: v.sequenceMap && typeof v.sequenceMap === "object" ? v.sequenceMap : {},
    signatureText: typeof v.signatureText === "string" ? v.signatureText : "",
    reviewWithModel: typeof v.reviewWithModel === "boolean" ? v.reviewWithModel : true,
  };
}

export async function saveSendSettings(patch: Partial<SendSettings>): Promise<SendSettings> {
  const current = await getSendSettings();
  const next: SendSettings = { ...current, ...patch, sequenceMap: patch.sequenceMap ?? current.sequenceMap };
  const { error } = await getSupabaseAdmin().from("app_settings").upsert({ key: SETTINGS_KEY, value: next, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  return next;
}

// ── Listing and updating ────────────────────────────────────────────────────

export async function listSends(weekStart?: string): Promise<E1Send[]> {
  let q = getSupabaseAdmin().from("e1_sends").select("*").order("created_at", { ascending: true });
  if (weekStart) q = q.eq("week_start", weekStart);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as E1Send[];
}

export async function getSend(id: string): Promise<E1Send | null> {
  const { data, error } = await getSupabaseAdmin().from("e1_sends").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as E1Send | null) ?? null;
}

export async function updateSend(id: string, patch: Partial<E1Send>): Promise<E1Send> {
  const { data, error } = await getSupabaseAdmin()
    .from("e1_sends")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  const row = data as E1Send;
  // Weekly Outreach mirrors the outcome: sent once the E1 is scheduled or
  // enrolled, back to draft_ready if it is cancelled or rejected after that.
  if (patch.status && row.weekly_outreach_id) {
    // A manual-mode enrolment (no scheduled time) is not a send yet: Weekly
    // Outreach waits for Seb's "Confirm sent".
    const weekly = patch.status === "sent" || (patch.status === "scheduled" && row.scheduled_for) ? "sent" : ["rejected", "failed"].includes(patch.status) ? "draft_ready" : null;
    if (weekly) await getSupabaseAdmin().from("weekly_outreach").update({ status: weekly }).eq("id", row.weekly_outreach_id).then(() => null, () => null);
  }
  return row;
}

// ── Creating rows from this week's sourced E1s ──────────────────────────────

/** Split the Weekly Outreach draft ("subject\n\nbody") back into its parts. */
export function splitDraft(draft: string | null): { subject: string | null; body: string | null } {
  if (!draft) return { subject: null, body: null };
  const text = draft.replace(/\r/g, "").trim();
  const i = text.indexOf("\n\n");
  if (i < 0) return { subject: null, body: text };
  return { subject: text.slice(0, i).trim(), body: text.slice(i + 2).trim() };
}

/**
 * One e1_sends row per draft-ready E1 this week that does not have one yet.
 * Returns the ids of the rows created (the prepare job runs the checks).
 */
export async function createSendsForWeek(weekStart = currentWeekStart()): Promise<string[]> {
  const db = getSupabaseAdmin();
  const { data: items, error } = await db
    .from("weekly_outreach")
    .select("*")
    .eq("week_start", weekStart)
    .eq("outreach_type", "E1")
    .in("status", ["draft_ready", "needs_context"]);
  if (error) throw new Error(error.message);
  const rows = (items ?? []) as WeeklyOutreachItem[];
  if (rows.length === 0) return [];
  const { data: existing } = await db
    .from("e1_sends")
    .select("id, weekly_outreach_id, status, subject, body, group_name")
    .in("weekly_outreach_id", rows.map((r) => r.id));
  type Existing = { id: string; weekly_outreach_id: string; status: E1Status; subject: string | null; body: string | null; group_name: string | null };
  const byWeekly = new Map((existing ?? []).map((r) => [(r as Existing).weekly_outreach_id, r as Existing]));

  // A row whose draft was re-sourced since it was queued is refreshed in
  // place (new text, new group, sequence re-matched) and checked again, as
  // long as Seb has not approved or scheduled it. Without this, a re-run on
  // Weekly Outreach left the old draft sitting in the queue.
  const refreshed: string[] = [];
  for (const r of rows) {
    const prev = byWeekly.get(r.id);
    if (!prev || !r.draft || !["pending", "review", "ready"].includes(prev.status)) continue;
    const { subject, body } = splitDraft(r.draft);
    const groupChanged = (r.group_name ?? null) !== (prev.group_name ?? null);
    if (subject === prev.subject && body === prev.body && !groupChanged) continue;
    const { error: updErr } = await db
      .from("e1_sends")
      .update({
        subject,
        body,
        group_name: r.group_name,
        sourcing_job_id: r.sourcing_job_id,
        ...(groupChanged ? { sequence_id: null, sequence_name: null } : {}),
        status: "pending",
        status_reason: null,
        review_flags: [],
        updated_at: new Date().toISOString(),
      })
      .eq("id", prev.id);
    if (updErr) throw new Error(updErr.message);
    refreshed.push(prev.id);
  }

  // Rows still waiting on a decision are checked again too, so "Check this
  // week's E1s" picks up a better sequence match or a filled town without
  // the draft having changed.
  const recheck = (existing ?? [])
    .map((r) => r as Existing)
    .filter((r) => ["pending", "review", "ready"].includes(r.status) && !refreshed.includes(r.id))
    .map((r) => r.id);
  // Sourced rows with no draft (no group matched) come in too: Seb picks the
  // sequence and the email is built from that group's template.
  const fresh = rows.filter((r) => !byWeekly.has(r.id) && (r.draft || r.sourcing_job_id));
  if (fresh.length === 0) return [...refreshed, ...recheck];

  // Billing state is what the time zone needs; Weekly Outreach rows carry country and city only.
  const states = new Map<string, { state: string | null; country: string | null; city: string | null }>();
  const ids = Array.from(new Set(fresh.map((r) => r.sf_account_id)));
  for (let i = 0; i < ids.length; i += 200) {
    const recs = await sfQuery<{ Id: string; BillingState: string | null; BillingCountry: string | null; BillingCity: string | null }>(
      `SELECT Id, BillingState, BillingCountry, BillingCity FROM Account WHERE Id IN (${ids.slice(i, i + 200).map((x) => `'${x}'`).join(",")})`,
    ).catch(() => []);
    for (const r of recs) states.set(r.Id, { state: r.BillingState, country: r.BillingCountry, city: r.BillingCity });
  }

  const created: string[] = [];
  for (const r of fresh) {
    const { subject, body } = splitDraft(r.draft);
    const loc = states.get(r.sf_account_id);
    const { data, error: insErr } = await db
      .from("e1_sends")
      .insert({
        week_start: weekStart,
        weekly_outreach_id: r.id,
        sourcing_job_id: r.sourcing_job_id,
        sf_account_id: r.sf_account_id,
        account_name: r.account_name,
        website: r.website,
        country: r.country ?? loc?.country ?? null,
        state: loc?.state ?? null,
        city: r.city ?? loc?.city ?? null,
        group_name: r.group_name,
        subject,
        body,
        status: "pending",
      })
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);
    created.push((data as { id: string }).id);
  }
  return [...refreshed, ...recheck, ...created];
}

// ── Contact pick ────────────────────────────────────────────────────────────

/** Lower is more senior. Founders first: they answer; a VP of sales does not. */
export function titleRank(title: string | null): number {
  const t = (title ?? "").toLowerCase();
  if (!t) return 8;
  if (/founder|co-founder/.test(t)) return 1;
  if (/\bceo\b|chief executive/.test(t)) return 2;
  if (/\bowner\b|proprietor/.test(t)) return 3;
  if (/president|managing director|\bmd\b|general manager/.test(t)) return 4;
  if (/\bcoo\b|\bcto\b|\bcfo\b|chief/.test(t)) return 5;
  if (/\bvp\b|vice president|director|head of/.test(t)) return 6;
  return 7;
}

export function rankContacts(contacts: SfContact[]): ContactOption[] {
  return contacts
    .map((c) => ({ id: c.Id, name: c.Name, firstName: c.FirstName, lastName: c.LastName, title: c.Title, email: c.Email ? c.Email.trim().toLowerCase() : null, rank: titleRank(c.Title) }))
    .sort((a, b) => a.rank - b.rank || (a.email ? 0 : 1) - (b.email ? 0 : 1) || a.name.localeCompare(b.name));
}

// ── Sequence match ──────────────────────────────────────────────────────────

/** "[E] - Manufacturing → Production Quality" and "Manufacturing — Production Quality" compare equal. */
export function normalizeSequenceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^\s*\[[^\]]*\]\s*-?\s*/, "")
    .replace(/[→—–\-/&]+/g, " ")
    .replace(/\band\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Words that name the main group or add nothing, ignored when comparing a
// subgroup to a sequence name ("[E] - CDM — Waste & Recycling" vs "Waste Recycling").
const SEQUENCE_NOISE = new Set(["cdm", "logistics", "agriculture", "manufacturing", "construction", "diversified", "materials", "the", "of", "services", "solutions", "group"]);

function sequenceTokens(name: string): string[] {
  return normalizeSequenceName(name).split(" ").filter((w) => w && !SEQUENCE_NOISE.has(w));
}

/**
 * The group files and their Outreach sequences, by name as they appear in
 * Outreach. This is the fixed mapping; the word matching below is only the
 * fallback for a group missing here or a sequence that was renamed.
 */
export const GROUP_SEQUENCE_NAMES: Record<string, string> = {
  "Fresh Produce": "[E] - Agriculture — Fresh Produce",
  "Grain Crop": "[E] - Agriculture — Grain & Crop",
  "Protein Livestock": "[E] - Agriculture — Protein & Livestock",
  "Bulk Liquids": "[E] - Bulk Liquids",
  "Bulk Materials": "[E] - Bulk Materials",
  "Contractor Solutions": "[E] - Contractor",
  "Equipment Dealers Rental": "[E] - Equipment",
  "Forestry Lumber": "[E] - Forest & Lumber",
  "Mining": "[E] - Mining",
  "Safety Compliance": "[E] - Safety & Compliance",
  "Structure Design Analysis": "[E] - Structure Design/Analysis",
  "Waste Recycling": "[E] - Waste",
  "Freight Supply Chain Enablement": "[E] - Logistics — Freight & Supply Chain Enablement",
  "Industrial Gate Yard": "[E] - Logistics — Industrial Gate & Yard",
  "Maritime": "[E] - Logistics — Maritime",
  "Rail": "[E] - Logistics — Rail",
  "Aftermarket Service": "[E] - Manufacturing — Aftermarket & Service",
  "Engineering Estimating": "[E] - Manufacturing — Engineering & Estimating",
  "Process Manufacturing": "[E] - Manufacturing → Process Manufacturing",
  "Production Quality": "[E] - Manufacturing → Production Quality",
};

export function matchSequence(groupName: string | null, sequences: OutreachSequence[], overrides: Record<string, string>): OutreachSequence | null {
  if (!groupName) return null;
  const override = overrides[groupName];
  if (override) return sequences.find((s) => String(s.id) === String(override)) ?? null;
  const want = normalizeSequenceName(groupName);
  if (!want) return null;
  // Only the "[E]" sequences are first-touch sequences; "[D-E]" and others are not.
  const pool = sequences.filter((s) => s.enabled && /^\s*\[E\]/i.test(s.name));
  // 1. The fixed mapping, compared on normalized names so punctuation and
  //    stray spaces in Outreach do not matter.
  const mappedName = GROUP_SEQUENCE_NAMES[groupName] ?? Object.entries(GROUP_SEQUENCE_NAMES).find(([g]) => normalizeSequenceName(g) === want)?.[1];
  if (mappedName) {
    const mappedNorm = normalizeSequenceName(mappedName);
    const mapped = pool.find((s) => normalizeSequenceName(s.name) === mappedNorm);
    if (mapped) return mapped;
  }
  // 2. The sequence named exactly like the group.
  const exact = pool.find((s) => normalizeSequenceName(s.name) === want);
  if (exact) return exact;
  const contains = pool.filter((s) => {
    const n = normalizeSequenceName(s.name);
    return n.endsWith(want) || want.endsWith(n) || n.includes(want);
  });
  if (contains.length === 1) return contains[0];
  // Names drift ("Freight & Supply Chain" vs "Freight Supply Chain Enablement",
  // "Waste, Recycling & Environmental Services" vs "Waste Recycling"): score
  // by the share of the subgroup's words the sequence name carries, and take
  // a clear winner.
  const wantWords = sequenceTokens(groupName);
  if (wantWords.length === 0) return null;
  // 3. Shared words. On equal scores the name with the fewest extra words
  //    wins ("… Freight & Supply Chain Enablement" over "… Freight & Supply
  //    Chain Enablement: Outreach"); a dead heat is left for Seb.
  const scored = pool
    .map((s) => {
      const have = sequenceTokens(s.name);
      return { s, score: wordOverlap(wantWords, have), extra: have.filter((h) => !wantWords.some((w) => sameWord(w, h))).length };
    })
    .filter((x) => x.score >= 0.6)
    .sort((a, b) => b.score - a.score || a.extra - b.extra);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score && scored[0].extra === scored[1].extra) return null;
  return scored[0].s;
}

/** "forestry" and "forest" count as the same word; so do "dealers" and "dealer". */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length, 5);
  return n >= 4 && a.slice(0, n) === b.slice(0, n);
}

/**
 * How well two names agree: the share of the group's words the sequence
 * carries, or 1 when every word of a shorter sequence name is in the group
 * ("[E] - Waste" for "Waste Recycling", "[E] - Equipment" for "Equipment
 * Dealers Rental").
 */
function wordOverlap(want: string[], have: string[]): number {
  if (want.length === 0 || have.length === 0) return 0;
  const forward = want.filter((w) => have.some((h) => sameWord(w, h))).length / want.length;
  const reverse = have.filter((h) => want.some((w) => sameWord(w, h))).length / have.length;
  return reverse === 1 ? 1 : forward;
}

/** Why nothing matched, with the nearest names, so the row explains itself. */
export function explainSequenceMiss(groupName: string | null, sequences: OutreachSequence[]): string {
  if (!groupName) return "This row has no group, so no sequence could be matched. Pick one.";
  if (sequences.length === 0) return "The Outreach sequence list could not be loaded, so nothing could be matched. Reconnect Outreach on the Outreach page, then re-check.";
  const wantWords = sequenceTokens(groupName);
  const ranked = sequences
    .map((s) => ({ s, score: wordOverlap(wantWords, sequenceTokens(s.name)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .filter((x) => x.score > 0);
  const eCount = sequences.filter((s) => /^\s*\[E\]/i.test(s.name)).length;
  const nearest = ranked.length
    ? ` Nearest names: ${ranked.map((x) => `"${x.s.name}"${x.s.enabled ? "" : " (disabled)"}${/^\s*\[E\]/i.test(x.s.name) ? "" : " (not an [E] sequence)"}`).join(", ")}.`
    : ` None of the ${sequences.length} sequences (${eCount} starting with [E]) share a word with it.`;
  return `No enabled [E] sequence matched "${groupName}".${nearest} Pick one, or rename the sequence to include the group name.`;
}

// ── Draft review (flag only) ────────────────────────────────────────────────

type SourcingContext = { address: string | null; restaurants: string[]; restaurantOptions: Array<{ name: string; description: string }>; hook: string | null; hookAnchor: string | null; hookInfo: HookInfo; websiteText: string | null } | null;

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

/** Grade the hook from what Sourcing recorded about it. Exported for tests. */
export function hookInfoFrom(r: Pick<SourcingResult, "emailHook" | "hookAnchor" | "hookSource"> | null): HookInfo {
  const text = r?.emailHook?.trim() || null;
  const a = r?.hookAnchor ?? null;
  const base = {
    text,
    anchor: a?.anchor ?? null,
    evidence: a?.evidence ?? null,
    sourceLabel: a?.sourceLabel ?? null,
    sourceUrl: a?.sourceUrl ?? null,
    source: r?.hookSource ?? null,
  };
  if (!text) {
    return { ...base, level: "none", note: "No hook was found, so the draft still carries the placeholder sentence. Write the opening yourself or reject." };
  }
  const where = base.sourceLabel ?? hostOf(base.sourceUrl) ?? (base.source === "wayback" ? "the Wayback Machine" : null);
  const fact = a?.factConfidence ?? (base.source === "wayback" ? "medium" : "low");
  if (fact === "high" && (base.sourceUrl || base.source === "wayback")) {
    return { ...base, level: "high", note: `Confirmed by ${where ?? "a source page"}${base.evidence ? `: ${base.evidence}` : "."}` };
  }
  if (fact === "high" || fact === "medium") {
    return { ...base, level: "medium", note: `Probably right but worth a glance${where ? ` (from ${where})` : ""}${base.evidence ? `: ${base.evidence}` : "."}` };
  }
  return { ...base, level: "low", note: `Thin evidence${where ? ` (from ${where})` : ""}${base.evidence ? `: ${base.evidence}` : ". The model could not point to a source."}` };
}

async function sourcingContextFor(send: E1Send): Promise<SourcingContext> {
  if (!send.sourcing_job_id || !send.weekly_outreach_id) return null;
  const job = await getJob(send.sourcing_job_id).catch(() => null);
  if (!job) return null;
  const input = (job.input ?? {}) as { weeklyOutreachIds?: string[] };
  const idx = (input.weeklyOutreachIds ?? []).indexOf(send.weekly_outreach_id);
  const items = ((job.result ?? {}) as { items?: Array<{ result: SourcingResult | null }> }).items ?? [];
  const r = idx >= 0 ? items[idx]?.result ?? null : null;
  if (!r) return null;
  return {
    address: r.address ?? null,
    restaurants: (r.restaurants ?? []).map((x) => x.name),
    restaurantOptions: (r.restaurants ?? []).map((x) => ({ name: x.name, description: x.description ?? "" })),
    hook: r.emailHook ?? null,
    hookAnchor: r.hookAnchor ? JSON.stringify(r.hookAnchor).slice(0, 600) : null,
    hookInfo: hookInfoFrom(r),
    websiteText: r.currentText ?? null,
  };
}

/**
 * Add a contact Seb found himself: created in Salesforce on the account (so
 * Outreach, the sequence and the account history all agree), then made this
 * row's contact, verified and re-checked. One shot.
 */
export async function addContactAndUse(id: string, input: { firstName: string; lastName: string; email: string; title?: string | null }): Promise<E1Send> {
  const send = await getSend(id);
  if (!send) throw new Error("Send row not found.");
  if (!["pending", "review", "ready", "approved"].includes(send.status)) throw new Error("This row can no longer be edited.");
  const email = input.email.trim().toLowerCase();
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("That does not look like an email address.");
  if (!lastName) throw new Error("A last name is needed for Salesforce.");

  // Reuse the Salesforce contact if the address already exists on the account.
  const existing = send.contact_options.find((c) => c.email?.toLowerCase() === email);
  let option: ContactOption;
  if (existing) {
    option = existing;
  } else {
    const res = await sfFetch("/services/data/v62.0/sobjects/Contact", {
      method: "POST",
      body: JSON.stringify({ FirstName: firstName || null, LastName: lastName, Email: email, Title: input.title?.trim() || null, AccountId: send.sf_account_id }),
    });
    if (!res.ok) throw new Error(`Salesforce would not create the contact: ${(await res.text()).slice(0, 200)}`);
    const created = (await res.json()) as { id: string };
    option = { id: created.id, name: [firstName, lastName].filter(Boolean).join(" "), firstName: firstName || null, lastName, title: input.title?.trim() || null, email, rank: titleRank(input.title ?? null) };
  }
  const options = existing ? send.contact_options : [option, ...send.contact_options];
  const v = await verifyEmail(email);
  await updateSend(id, {
    contact_options: options,
    contact_id: option.id,
    contact_name: option.name,
    contact_first_name: option.firstName,
    contact_last_name: option.lastName,
    contact_title: option.title,
    contact_email: email,
    verify_result: v.result,
    verify_detail: v,
    verified_email: email,
    ...(send.status === "approved" ? { status: "ready" as const } : {}),
  });
  return recheckSend(id);
}

/** "Hi <first name>," on top, unless the draft already opens with a greeting. Exported for tests. */
export function withGreeting(body: string, firstName: string | null | undefined): string {
  const text = body.trim();
  if (/^(hi|hello|dear|good (morning|afternoon|evening))\b/i.test(text)) return text;
  const name = (firstName ?? "").trim();
  return `${name ? `Hi ${name},` : "Hi,"}\n\n${text}`;
}

/** The group a sequence belongs to, from the fixed mapping. */
export function groupForSequence(sequenceName: string | null | undefined): string | null {
  if (!sequenceName) return null;
  const want = normalizeSequenceName(sequenceName);
  return Object.entries(GROUP_SEQUENCE_NAMES).find(([, seq]) => normalizeSequenceName(seq) === want)?.[0] ?? null;
}

async function storedResultFor(send: E1Send): Promise<{ jobId: string; idx: number; stored: Record<string, unknown>; items: Array<Record<string, unknown>>; result: SourcingResult } | null> {
  if (!send.sourcing_job_id || !send.weekly_outreach_id) return null;
  const job = await getJob(send.sourcing_job_id).catch(() => null);
  if (!job?.result) return null;
  const idx = (((job.input ?? {}) as { weeklyOutreachIds?: string[] }).weeklyOutreachIds ?? []).indexOf(send.weekly_outreach_id);
  const stored = job.result as Record<string, unknown>;
  const items = Array.isArray(stored.items) ? (stored.items as Array<Record<string, unknown>>) : [];
  const result = idx >= 0 ? (items[idx]?.result as SourcingResult | null | undefined) ?? null : null;
  return result ? { jobId: job.id, idx, stored, items, result } : null;
}

/**
 * Seb picked a sequence. If it belongs to a different group than the draft
 * (or there is no draft yet), rewrite the email from that group's template
 * using the research Sourcing already did: hook, town, restaurant stay; the
 * group paragraph and template change. One model call.
 */
export async function rebuildForSequence(id: string): Promise<{ rebuilt: boolean; note: string | null }> {
  const send = await getSend(id);
  if (!send) throw new Error("Send row not found.");
  const group = groupForSequence(send.sequence_name);
  if (!group) return { rebuilt: false, note: send.body ? null : "This sequence is not mapped to a group, so no email could be written. Write it by hand or pick a mapped sequence." };
  if (group === send.group_name && send.body?.trim()) return { rebuilt: false, note: null };
  const found = await storedResultFor(send);
  if (!found) return { rebuilt: false, note: "No sourcing result on this row to build from. Run Sourcing for it again." };
  const key = findGroupFileName(group, loadGroupFiles());
  const mainGroup = key?.includes("/") ? key.split("/")[0] : null;
  const rebuilt = await reclassifySourcingResult(found.result, { matched: true, group, mainGroup, confidence: 100 });
  const pe = rebuilt.prepackagedEmail;
  if (!pe || pe.skipped || !pe.body) return { rebuilt: false, note: `No template for ${group}: ${pe?.skipReason ?? "unknown reason"}` };
  // Keep the sourcing run and Weekly Outreach in step with the new draft.
  found.items[found.idx] = { ...found.items[found.idx], result: rebuilt };
  await markSucceeded(found.jobId, { ...found.stored, items: found.items }, false).catch(() => null);
  const draft = [pe.subject, pe.body].filter(Boolean).join("\n\n");
  if (send.weekly_outreach_id) {
    await getSupabaseAdmin().from("weekly_outreach").update({ draft, group_name: group, industry: mainGroup, status: "draft_ready" }).eq("id", send.weekly_outreach_id).then(() => null, () => null);
  }
  await updateSend(id, { group_name: group, subject: pe.subject ?? send.subject, body: pe.body, hook: hookInfoFrom(rebuilt), restaurant_options: (rebuilt.restaurants ?? []).map((x) => ({ name: x.name, description: x.description ?? "" })) });
  return { rebuilt: true, note: null };
}

/** Manual mode: Seb sent or scheduled the E1 from the step-1 task in Outreach. */
export async function confirmSent(id: string): Promise<E1Send> {
  const send = await getSend(id);
  if (!send) throw new Error("Send row not found.");
  if (send.status !== "scheduled") throw new Error("Only an enrolled email can be confirmed.");
  return updateSend(id, { status: "sent", status_reason: null });
}

/** Put a different restaurant in the subject line, keeping the date part. */
export async function chooseRestaurant(id: string, name: string): Promise<E1Send> {
  const send = await getSend(id);
  if (!send) throw new Error("Send row not found.");
  if (!["pending", "review", "ready", "approved"].includes(send.status)) throw new Error("This row can no longer be edited.");
  const short = shortenRestaurantName(name);
  const m = (send.subject ?? "").match(/\s([A-Z][a-z]{2} \d{1,2}): Valstone\s*$/);
  const subject = m ? `${short} ${m[1]}: Valstone` : `${short}: Valstone`;
  return updateSend(id, { subject, ...(send.status === "approved" ? { status: "ready" as const } : {}) });
}

/**
 * "Deep research this hook" from the Send queue: re-run the public-source
 * hook research for this row's company, save it to the sourcing run (so the
 * Sourcing page shows the same hook), and swap the opening sentence in the
 * draft. Seb's other edits to the draft are kept.
 */
export async function rehookSend(id: string): Promise<E1Send> {
  const send = await getSend(id);
  if (!send) throw new Error("Send row not found.");
  if (!["pending", "review", "ready"].includes(send.status)) throw new Error("Only a row still waiting on a decision can be re-researched.");
  if (!send.sourcing_job_id || !send.weekly_outreach_id) throw new Error("This row has no sourcing run to research from.");
  const job = await getJob(send.sourcing_job_id);
  if (!job?.result) throw new Error("The sourcing run for this row could not be found.");
  const input = (job.input ?? {}) as { weeklyOutreachIds?: string[] };
  const idx = (input.weeklyOutreachIds ?? []).indexOf(send.weekly_outreach_id);
  const stored = job.result as Record<string, unknown>;
  const items = Array.isArray(stored.items) ? (stored.items as Array<Record<string, unknown>>) : [];
  const target = idx >= 0 ? (items[idx]?.result as SourcingResult | null | undefined) ?? null : null;
  if (!target) throw new Error("This company is not in its sourcing run.");

  const patch = await rerunHookResearch(target);
  if (patch.emailHook === undefined || !patch.emailHook) {
    throw new Error("Nothing better turned up: the research found no verifiable detail to build a new hook from. The draft is unchanged.");
  }
  const updated: SourcingResult = {
    ...target,
    ...patch,
    logs: [...(target.logs ?? []), "--- Hook re-researched from the Send queue ---", ...patch.logs],
  };
  items[idx] = { ...items[idx], result: updated };
  await markSucceeded(job.id, { ...stored, items }, false);

  // Swap the opening sentence only, so edits elsewhere in the draft survive.
  const newHook = patch.emailHook.trim();
  let body = send.body ?? "";
  const oldHook = send.hook?.text?.trim();
  if (oldHook && body.includes(oldHook)) {
    body = body.replace(oldHook, newHook);
  } else if (updated.prepackagedEmail && !updated.prepackagedEmail.skipped && updated.prepackagedEmail.body) {
    body = updated.prepackagedEmail.body;
  } else {
    body = body.replace(/^[^\n.]*going back to[^\n]*?\./m, newHook);
  }
  // The model's old hook flag was about the sentence just replaced.
  await updateSend(id, { body, hook: hookInfoFrom(updated), review_flags: send.review_flags.filter((f) => f.kind !== "hook") });
  return recheckSend(id);
}

const REVIEW_SYSTEM = `You check a cold outreach email before a human reviews it. You never rewrite it. You return only problems, each as one short plain sentence a reader can act on. Be strict about facts and spelling, relaxed about style.

Check:
1. spelling: misspellings, doubled words, broken merge fields like {{first_name}} left in, a stray placeholder such as (INSERT ...) or [INSERT ...], a missing word.
2. town: the town named in the email must be the company's town (or very near it) per the address supplied. A town in the wrong state or country is a red flag.
3. restaurant: the restaurant named in the subject or body must be one of the supplied candidates and must be in that same town.
4. hook: the sentence about the company's history or product must be supported by the evidence supplied (website text, hook anchor). Flag a product or year the evidence does not contain, or a claim that reads as generic filler.
5. other: anything that would embarrass the sender (wrong company name, wrong person, two greetings, missing sign-off).

Output ONLY a JSON array, possibly empty: [{"kind":"spelling|town|restaurant|hook|other","severity":"red|yellow","message":"<one sentence>"}]. Red means do not send as is; yellow means worth a look.`;

export async function reviewDraft(send: E1Send): Promise<ReviewFlag[]> {
  const client = getAnthropicClient();
  if (!client || !send.body) return [];
  const ctx = await sourcingContextFor(send);
  const user = [
    `Company: ${send.account_name}`,
    `Website: ${send.website ?? "unknown"}`,
    `Salesforce location: ${[send.city, send.state, send.country].filter(Boolean).join(", ") || "unknown"}`,
    `Sourced address: ${ctx?.address ?? "unknown"}`,
    `Restaurant candidates: ${ctx?.restaurants.length ? ctx.restaurants.join("; ") : "none supplied"}`,
    `Hook evidence: ${ctx?.hookAnchor ?? "none supplied"}`,
    `Website text (start): ${(ctx?.websiteText ?? "").slice(0, 1500) || "none"}`,
    "",
    `Subject: ${send.subject ?? ""}`,
    "",
    "Email:",
    send.body,
  ].join("\n");
  const res = await trackedCreate(client, "send_review", {
    model: MODELS.drafting,
    max_tokens: 600,
    system: REVIEW_SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  const text = stripCites(res.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
  try {
    const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]") as Array<Partial<ReviewFlag>>;
    return arr
      .filter((f) => f && typeof f.message === "string")
      .map((f) => ({
        kind: (["spelling", "town", "restaurant", "hook", "other"] as const).includes(f.kind as never) ? (f.kind as ReviewFlag["kind"]) : "other",
        severity: (f.severity === "red" ? "red" : "yellow") as ReviewFlag["severity"],
        message: String(f.message).slice(0, 240),
      }))
      .slice(0, 8);
  } catch {
    return [];
  }
}

// ── Prepare: everything the app can check before Seb looks ──────────────────

/** Flags that come from the checks, not the model: keep them apart so a re-review replaces only the model's. */
const PLACEHOLDER_RE = /\{\{[^}]*\}\}|\((?:INSERT|TBD)[^)]*\)|\[(?:INSERT|TBD)[^\]]*\]|\bINSERT [A-Z][A-Z ]+\b/g;

/** Merge fields and template placeholders still sitting in the draft. Exported for tests. */
export function findPlaceholders(text: string | null | undefined): string[] {
  const found = (text ?? "").match(PLACEHOLDER_RE) ?? [];
  return Array.from(new Set(found.map((x) => x.trim())));
}

function systemFlags(send: Pick<E1Send, "contact_email" | "verify_result" | "sequence_id" | "contact_id" | "subject" | "body">, sequenceMiss?: string): ReviewFlag[] {
  const out: ReviewFlag[] = [];
  // Deterministic first: a placeholder in the text is never a judgement call,
  // and the model review has let these through.
  if (!send.body?.trim()) {
    out.push({ kind: "sequence", severity: "red", message: "No email yet: Sourcing found no group for this company. Pick the sequence and the email is written from that group's template." });
  }
  const placeholders = findPlaceholders(`${send.subject ?? ""}\n${send.body ?? ""}`);
  if (placeholders.length > 0) {
    out.push({ kind: "placeholder", severity: "red", message: `Unfilled placeholder in the draft: ${placeholders.join(", ")}. Fill it in before approving.` });
  }
  if (!send.contact_id) out.push({ kind: "contact", severity: "red", message: "No Salesforce contact with an email on this account. Add one or reject." });
  else if (!send.contact_email) out.push({ kind: "contact", severity: "red", message: "The chosen contact has no email address." });
  switch (send.verify_result) {
    case "invalid": out.push({ kind: "email", severity: "red", message: "Email verification says this address is invalid. Pick another contact." }); break;
    case "disposable": out.push({ kind: "email", severity: "red", message: "Disposable email address." }); break;
    case "role": out.push({ kind: "email", severity: "red", message: "Role address (info@, sales@). Pick a person." }); break;
    case "accept_all": out.push({ kind: "email", severity: "yellow", message: "Catch-all domain: the address could not be proven. Your call." }); break;
    case "unknown": out.push({ kind: "email", severity: "yellow", message: "The verifier could not confirm this address. Your call." }); break;
    case "error": out.push({ kind: "email", severity: "yellow", message: "The verifier failed. Re-check, or decide by hand." }); break;
    default: break;
  }
  if (!send.sequence_id) {
    out.push({ kind: "sequence", severity: "red", message: sequenceMiss ?? "No Outreach sequence matched this group. Pick one." });
  }
  return out;
}

function statusFromFlags(flags: ReviewFlag[]): E1Status {
  return flags.length > 0 ? "review" : "ready";
}

/**
 * Run every check on one row: contact pick, email verification, sequence
 * match, model review. Idempotent; a re-run re-verifies only if the email
 * changed and keeps a hand-picked sequence or contact.
 */
export async function prepareSend(id: string, options: { sequences?: OutreachSequence[]; settings?: SendSettings } = {}): Promise<E1Send> {
  const send = await getSend(id);
  if (!send) throw new Error("Send row not found.");
  if (["approved", "scheduling", "dry_run", "scheduled", "sent", "rejected"].includes(send.status)) return send;
  const settings = options.settings ?? (await getSendSettings());
  const sequences = options.sequences ?? (await listSequences().catch(() => []));

  // Contacts: propose by title rank unless Seb already picked one.
  const contacts = (await fetchContactsForAccounts([send.sf_account_id]).catch(() => new Map<string, SfContact[]>())).get(send.sf_account_id) ?? [];
  const options_ = rankContacts(contacts);
  const chosen = (send.contact_id && options_.find((c) => c.id === send.contact_id)) || options_.find((c) => c.email) || null;
  const patch: Partial<E1Send> = {
    contact_options: options_,
    contact_id: chosen?.id ?? null,
    contact_name: chosen?.name ?? null,
    contact_first_name: chosen?.firstName ?? null,
    contact_last_name: chosen?.lastName ?? null,
    contact_title: chosen?.title ?? null,
    contact_email: chosen?.email ?? null,
  };

  // Verify only when the address changed since the last verdict.
  if (chosen?.email && chosen.email !== send.verified_email) {
    const v = await verifyEmail(chosen.email);
    patch.verify_result = v.result;
    patch.verify_detail = v;
    patch.verified_email = chosen.email;
  } else if (!chosen?.email) {
    patch.verify_result = null;
    patch.verify_detail = null;
    patch.verified_email = null;
  }

  // Sequence: keep a hand pick, else match by name.
  if (!send.sequence_id) {
    const seq = matchSequence(send.group_name, sequences, settings.sequenceMap);
    patch.sequence_id = seq?.id ?? null;
    patch.sequence_name = seq?.name ?? null;
  }

  // Time zone for the send slot.
  patch.time_zone = recipientTimeZone(send.country, send.state);

  // Sourcing could not place the company but Salesforce knows the town: use it.
  if (send.body && send.body.includes("[INSERT TOWN]") && send.city?.trim()) {
    patch.body = send.body.split("[INSERT TOWN]").join(send.city.trim());
  }

  // Hook provenance, so the row can say what backs the opening sentence.
  const ctx = await sourcingContextFor(send).catch(() => null);
  patch.hook = ctx?.hookInfo ?? hookInfoFrom(null);
  patch.restaurant_options = ctx?.restaurantOptions ?? [];

  const updated = await updateSend(id, patch);

  // Model review of the draft, flag only. A review that fails is said so,
  // never shown as a clean pass.
  const modelFlags: ReviewFlag[] = settings.reviewWithModel
    ? await reviewDraft(updated).catch((err: unknown) => [
        { kind: "other" as const, severity: "yellow" as const, message: `The model review did not run (${err instanceof Error ? err.message.slice(0, 80) : "error"}). Read this one yourself.` },
      ])
    : [];
  const flags = [...systemFlags(updated, updated.sequence_id ? undefined : explainSequenceMiss(updated.group_name, sequences)), ...modelFlags];
  return updateSend(id, { review_flags: flags, reviewed_at: new Date().toISOString(), status: statusFromFlags(flags), status_reason: null });
}

/** After Seb changes the contact, sequence, subject or body: re-run the cheap checks and keep the model flags that still apply. */
export async function recheckSend(id: string): Promise<E1Send> {
  const send = await getSend(id);
  if (!send) throw new Error("Send row not found.");
  const patch: Partial<E1Send> = {};
  if (send.contact_email && send.contact_email !== send.verified_email) {
    const v = await verifyEmail(send.contact_email);
    patch.verify_result = v.result;
    patch.verify_detail = v;
    patch.verified_email = send.contact_email;
  }
  // No sequence yet: try the match again (the list or the matcher may have
  // improved since the row was prepared). A hand pick is never overridden.
  let sequenceMiss: string | undefined;
  if (!send.sequence_id) {
    const settings = await getSendSettings();
    const sequences = await listSequences().catch(() => [] as OutreachSequence[]);
    const seq = matchSequence(send.group_name, sequences, settings.sequenceMap);
    if (seq) {
      patch.sequence_id = seq.id;
      patch.sequence_name = seq.name;
    } else {
      sequenceMiss = explainSequenceMiss(send.group_name, sequences);
    }
  }
  if (send.body && send.body.includes("[INSERT TOWN]") && send.city?.trim()) {
    patch.body = send.body.split("[INSERT TOWN]").join(send.city.trim());
  }
  // Hook line and restaurant list come from the sourcing run; refresh both
  // every time, so a row prepared before these existed catches up.
  const ctx = await sourcingContextFor(send).catch(() => null);
  if (ctx) {
    patch.hook = ctx.hookInfo;
    patch.restaurant_options = ctx.restaurantOptions;
  }
  const merged = { ...send, ...patch };
  // Keep only the model's flags; everything the checks wrote is recomputed
  // (older rows carry the placeholder flag under "other").
  const modelFlags = send.review_flags.filter((f) => !["contact", "email", "sequence", "placeholder"].includes(f.kind) && !/^Unfilled placeholder/.test(f.message) && !/^The model review did not run/.test(f.message));
  const flags = [...systemFlags(merged, sequenceMiss), ...modelFlags];
  return updateSend(id, { ...patch, review_flags: flags, status: ["pending", "review", "ready"].includes(send.status) ? statusFromFlags(flags) : send.status });
}

export async function approveSend(id: string): Promise<E1Send> {
  const send = await getSend(id);
  if (!send) throw new Error("Send row not found.");
  const red = systemFlags(send).filter((f) => f.severity === "red");
  if (red.length > 0) throw new Error(red[0].message);
  if (!send.subject?.trim() || !send.body?.trim()) throw new Error("Subject and body are both needed.");
  return updateSend(id, { status: "approved", approved_at: new Date().toISOString(), status_reason: null });
}

/**
 * Pull back: an approved (or failed) row goes back to review, nothing is
 * rejected. The cheap checks run again so it lands as clean or needing a decision.
 */
export async function unapproveSend(id: string): Promise<E1Send> {
  const send = await getSend(id);
  if (!send) throw new Error("Send row not found.");
  if (!["approved", "failed"].includes(send.status)) throw new Error("Only an approved email that has not gone to Outreach can be pulled back.");
  await updateSend(id, { status: "ready", status_reason: null });
  return recheckSend(id);
}

export async function rejectSend(id: string, reason: string | null): Promise<E1Send> {
  return updateSend(id, { status: "rejected", status_reason: reason });
}

// ── Scheduling: the Outreach work ───────────────────────────────────────────

export type ScheduleOutcome = { id: string; status: E1Status; reason: string | null };

/** Everything up to the task: prospect, enrolment. Returns ids for the next step. */
export async function enrolSend(id: string): Promise<{ prospectId: string; stateId: string; mailboxId: string } | { blocked: string }> {
  const send = await getSend(id);
  if (!send) throw new Error("Send row not found.");
  if (!send.contact_email || !send.sequence_id) return { blocked: "Missing contact email or sequence." };

  // Already in an active sequence anywhere: do not double up. An enrolment
  // this row made earlier (a retry after a stopped run) is reused, not a block.
  const existing = await findProspectByEmail(send.contact_email);
  if (existing) {
    const active = await outreachRequest(`/sequenceStates?filter[prospect][id]=${existing.id}&filter[state]=active&page[size]=5`);
    if (active.ok) {
      const body = (await active.json()) as { data?: Array<{ id: string }> };
      const states = body.data ?? [];
      const own = send.outreach_state_id ? states.find((st) => String(st.id) === String(send.outreach_state_id)) : null;
      if (own) {
        const mailboxes = await listMailboxes();
        const mailbox = mailboxes.find((m) => m.email.toLowerCase() === "sebastian@valstonecorp.com") ?? mailboxes[0];
        if (!mailbox) return { blocked: "No Outreach mailbox on the connection." };
        if (send.subject?.trim()) await setProspectCustomFields(existing.id, { custom1: send.subject.trim() }).catch(() => null);
        await updateSend(id, { outreach_prospect_id: existing.id, status: "scheduling" });
        return { prospectId: existing.id, stateId: own.id, mailboxId: mailbox.id };
      }
      if (states.length > 0) return { blocked: "This contact is already in an active Outreach sequence." };
    }
  }
  // Our own queue: one email per account per 60 days.
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const { data: dupes } = await getSupabaseAdmin()
    .from("e1_sends")
    .select("id")
    .eq("sf_account_id", send.sf_account_id)
    .neq("id", id)
    .in("status", ["scheduled", "sent"])
    .gte("updated_at", since)
    .limit(1);
  if ((dupes ?? []).length > 0) return { blocked: "Another email to this account was scheduled in the last 60 days." };

  const mailboxes = await listMailboxes();
  const mailbox = mailboxes.find((m) => m.email.toLowerCase() === "sebastian@valstonecorp.com") ?? mailboxes[0];
  if (!mailbox) return { blocked: "No Outreach mailbox on the connection." };

  const prospect =
    existing ??
    (await createProspect({
      firstName: send.contact_first_name ?? send.contact_name?.split(" ")[0] ?? "",
      lastName: send.contact_last_name ?? send.contact_name?.split(" ").slice(1).join(" ") ?? "",
      email: send.contact_email,
      title: send.contact_title ?? undefined,
      company: send.account_name,
    }));
  // The follow-up steps use {{custom1}} as their subject, so the thread
  // keeps the E1 subject. Set before enrolling, and refuse if it did not stick.
  if (!send.subject?.trim()) return { blocked: "No subject on this row." };
  await setProspectCustomFields(prospect.id, { custom1: send.subject.trim() });
  const state = await addProspectToSequence({ prospectId: prospect.id, sequenceId: send.sequence_id, mailboxId: mailbox.id });
  await updateSend(id, { outreach_prospect_id: prospect.id, outreach_state_id: state.id, status: "scheduling" });
  return { prospectId: prospect.id, stateId: state.id, mailboxId: mailbox.id };
}

/**
 * Log the E1 in Salesforce the way a sequence send would: a completed Email
 * task typed E1 on the contact and account. Outreach's own sync cannot tag
 * an email it did not send from a step. Never throws: a Salesforce hiccup is
 * noted on the row, not allowed to fail a send.
 */
async function logE1Task(send: E1Send, sendAt: Date): Promise<string | null> {
  try {
    const credentials = await getValidCredentials();
    if (!credentials) return null;
    const res = await sfFetch("/services/data/v62.0/sobjects/Task", {
      method: "POST",
      body: JSON.stringify({
        Subject: send.subject ?? "E1",
        Type: "Email",
        Subject_Type__c: "E1",
        Status: "Completed",
        ActivityDate: sendAt.toISOString().slice(0, 10),
        WhatId: send.sf_account_id,
        WhoId: send.contact_id,
        OwnerId: credentials.salesforce_user_id,
        Description: withGreeting(send.body ?? "", send.contact_first_name).slice(0, 30000),
      }),
    }, credentials);
    if (!res.ok) return null;
    const out = (await res.json()) as { id?: string };
    return out.id ?? null;
  } catch {
    return null;
  }
}

/** The manual step's task, once Outreach has activated the state. Null when not there yet. */
export async function findStepTask(stateId: string): Promise<string | null> {
  const res = await outreachRequest(`/tasks?filter[sequenceState][id]=${stateId}&page[size]=5&fields[task]=taskType,state,completed`);
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: Array<{ id: string; attributes?: { completed?: boolean } }> };
  const task = (body.data ?? []).find((t) => !t.attributes?.completed) ?? body.data?.[0];
  return task?.id ?? null;
}

/**
 * The signature under every send: the formatted one from Seb's sent emails.
 * Imported on first use (and re-imported if only a plain pasted one is
 * stored), so nothing has to be set up by hand. A plain-text override in
 * settings wins when present.
 */
async function signatureHtml(settings: SendSettings): Promise<string | null> {
  // Outreach appends the mailbox signature itself when it sends, so adding
  // one here produced two. Only an explicit plain-text override is appended
  // (for a mailbox with no signature set in Outreach).
  if (settings.signatureText.trim()) return textToHtml(settings.signatureText.trim());
  return null;
}

/** Kept for the settings page preview; not appended to mailings. */
export async function storedSignaturePreview(): Promise<string | null> {
  const stored = await getStoredSignature();
  if (stored?.source === "imported") return stored.html;
  const found = await importSignatureFromSentItems().catch(() => null);
  if (found) {
    const saved = await saveStoredSignature({ ...found, source: "imported" }).catch(() => null);
    return saved?.html ?? found.html;
  }
  return stored?.html ?? null;
}

/**
 * Create the mailing on the task with the reviewed subject and body, the
 * signature, tracking on, and the send time. Dry run leaves it as a draft in
 * the outbox; otherwise it is flipped to scheduled.
 */
export async function createMailingForSend(id: string, ids: { prospectId: string; mailboxId: string }, sendAt: Date, settings: SendSettings): Promise<E1Send> {
  const send = await getSend(id);
  if (!send || !send.body) throw new Error("Send row has no body.");
  // A run that was reset or cancelled while this job slept must not act.
  if (send.status !== "scheduling") return send;

  // Bridge: Seb sends the E1 himself from Outreach. The prospect is enrolled
  // (custom1 carries the subject for the follow-ups) and the E1 is logged in
  // Salesforce as of today; nothing is mailed from here.
  if (settings.manualSend) {
    // No draft: the E1 must be sent from the sequence's step-1 task so the
    // follow-ups run. The row keeps subject and email for copying.
    const sfTaskId = await logE1Task(send, new Date());
    return updateSend(id, {
      outreach_task_id: sfTaskId,
      scheduled_for: null,
      status: "scheduled",
      status_reason: `Enrolled. Open the step-1 task in Outreach, paste the subject and email, send.${sfTaskId ? "" : " Salesforce did not accept the E1 task; log it by hand."}`,
    });
  }
  const bodyHtml = composeHtmlBody(withGreeting(send.body, send.contact_first_name), await signatureHtml(settings));

  // The mailing is created on its own, not attached to the step task: a
  // mailing attached to a manual-email step comes back wearing the step's
  // template ("Lunch: Valstone", "(INSERT PRODUCT)") whatever is sent. The
  // prospect still sits in the sequence (enrolSend), and the step task is
  // marked done below once the real email is scheduled.
  const res = await outreachRequest(`/mailings`, {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "mailing",
        attributes: { subject: send.subject ?? "", bodyHtml, scheduledAt: sendAt.toISOString(), trackLinks: true, trackOpens: true },
        relationships: {
          prospect: { data: { type: "prospect", id: ids.prospectId } },
          mailbox: { data: { type: "mailbox", id: ids.mailboxId } },
        },
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Outreach refused the mailing: ${text.slice(0, 300)}`);
  const mailingId = (JSON.parse(text) as { data?: { id?: string | number } }).data?.id;
  if (!mailingId) throw new Error("Outreach created the mailing but returned no id.");

  // Read it back: the subject must be ours, or nothing goes further.
  const check = await outreachRequest(`/mailings/${mailingId}?fields[mailing]=subject,state`);
  const checked = (await check.json().catch(() => null)) as { data?: { attributes?: { subject?: string } } } | null;
  const got = (checked?.data?.attributes?.subject ?? "").trim();
  if (got !== (send.subject ?? "").trim()) {
    throw new Error(`Outreach stored a different subject ("${got}") than the draft. Mailing ${mailingId} left as a draft; nothing scheduled.`);
  }

  const patch: Partial<E1Send> = { outreach_mailing_id: String(mailingId), scheduled_for: sendAt.toISOString() };
  if (settings.dryRun) return updateSend(id, { ...patch, status: "dry_run", status_reason: "Dry run: draft created in Outreach, not scheduled." });
  const flip = await outreachRequest(`/mailings/${mailingId}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { type: "mailing", id: Number(mailingId), attributes: { state: "scheduled", scheduledAt: sendAt.toISOString() } } }),
  });
  if (!flip.ok) throw new Error(`Outreach would not schedule the mailing: ${(await flip.text()).slice(0, 300)}`);

  // Salesforce: the E1 task, as a sequence send would have logged it.
  const sfTaskId = await logE1Task(send, sendAt);
  return updateSend(id, {
    ...patch,
    outreach_task_id: sfTaskId,
    status: "scheduled",
    status_reason: sfTaskId ? null : "Scheduled. Salesforce did not accept the E1 task; log it there by hand.",
  });
}

/** One-off: rows already out the door get custom1 and the Salesforce E1 task. */
export async function backfillSentRows(): Promise<Array<{ account: string; custom1: string; sfTask: string }>> {
  const { data } = await getSupabaseAdmin()
    .from("e1_sends")
    .select("*")
    .in("status", ["scheduled", "sent"])
    .not("outreach_prospect_id", "is", null)
    .is("outreach_task_id", null)
    .limit(100);
  const out: Array<{ account: string; custom1: string; sfTask: string }> = [];
  for (const row of (data ?? []) as E1Send[]) {
    let custom1 = "skipped";
    if (row.subject?.trim() && row.outreach_prospect_id) {
      custom1 = await setProspectCustomFields(row.outreach_prospect_id, { custom1: row.subject.trim() }).then(() => "set").catch((e: Error) => e.message);
    }
    const taskId = await logE1Task(row, new Date(row.scheduled_for ?? row.updated_at));
    // outreach_task_id now holds the Salesforce task id, so a rerun skips this row.
    if (taskId) await updateSend(row.id, { outreach_task_id: taskId, status_reason: null });
    out.push({ account: row.account_name, custom1, sfTask: taskId ?? "failed" });
  }
  return out;
}

/** Undo a scheduled or dry-run send: mailing back to draft, prospect out of the sequence. */
export async function cancelSend(id: string): Promise<E1Send> {
  const send = await getSend(id);
  if (!send) throw new Error("Send row not found.");
  if (send.outreach_mailing_id && send.status === "scheduled") {
    await outreachRequest(`/mailings/${send.outreach_mailing_id}`, {
      method: "PATCH",
      body: JSON.stringify({ data: { type: "mailing", id: Number(send.outreach_mailing_id), attributes: { state: "drafted" } } }),
    });
  }
  if (send.outreach_state_id) await outreachRequest(`/sequenceStates/${send.outreach_state_id}`, { method: "DELETE" }).catch(() => null);
  return updateSend(id, { status: "rejected", status_reason: "Cancelled after scheduling; removed from the sequence.", scheduled_for: null });
}

/** Slots for a set of approved rows, in each recipient's zone. */
export function planSlotsFor(sends: E1Send[], now = new Date()): Map<string, Date> {
  const plan = planSendSlots(sends.map((s) => ({ id: s.id, timeZone: s.time_zone ?? recipientTimeZone(s.country, s.state) })), now);
  return new Map(plan.map((p) => [p.id, p.at]));
}
