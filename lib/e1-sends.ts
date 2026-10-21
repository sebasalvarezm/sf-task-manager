import { getAnthropicClient, MODELS, stripCites } from "./anthropic";
import { getSupabaseAdmin } from "./supabase";
import { sfQuery } from "./sf-query";
import { fetchContactsForAccounts, type SfContact } from "./salesforce-contacts";
import { verifyEmail, type VerifyDetail, type VerifyResult } from "./email-verify";
import { listSequences, listMailboxes, findProspectByEmail, createProspect, addProspectToSequence, outreachRequest, type OutreachSequence } from "./outreach";
import { getStoredSignature, composeHtmlBody, textToHtml } from "./outlook-signature";
import { trackedCreate } from "./model-cost";
import { recipientTimeZone, planSendSlots } from "./send-slots";
import { currentWeekStart, type WeeklyOutreachItem } from "./weekly-outreach";
import { getJob } from "./jobs";
import type { SourcingResult } from "./jobs/sourcing-runner";

/**
 * The send queue: everything between "Sourcing produced a draft" and "a
 * scheduled mailing sits in Outreach". The app does the checking (contact,
 * email verification, draft review, sequence match) before Seb looks; he
 * confirms or fixes; the scheduler does the Outreach work and picks the time.
 */

export type E1Status = "pending" | "review" | "ready" | "approved" | "scheduling" | "dry_run" | "scheduled" | "sent" | "failed" | "rejected";

export type ReviewFlag = { kind: "spelling" | "town" | "restaurant" | "hook" | "contact" | "email" | "sequence" | "other"; message: string; severity: "red" | "yellow" };

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
  /** Group name → Outreach sequence id, for the groups the name match gets wrong. */
  sequenceMap: Record<string, string>;
  /** Plain-text signature override for Outreach sends; empty means use the stored Outlook signature. */
  signatureText: string;
  /** Send the pre-review flags through the model (about 2 cents per email). */
  reviewWithModel: boolean;
};

const SETTINGS_KEY = "e1_send_settings";
const DEFAULT_SETTINGS: SendSettings = { dryRun: true, sequenceMap: {}, signatureText: "", reviewWithModel: true };

export async function getSendSettings(): Promise<SendSettings> {
  const { data } = await getSupabaseAdmin().from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
  const v = (data?.value ?? {}) as Partial<SendSettings>;
  return {
    dryRun: typeof v.dryRun === "boolean" ? v.dryRun : DEFAULT_SETTINGS.dryRun,
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
  return data as E1Send;
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
    .eq("status", "draft_ready");
  if (error) throw new Error(error.message);
  const rows = (items ?? []) as WeeklyOutreachItem[];
  if (rows.length === 0) return [];
  const { data: existing } = await db.from("e1_sends").select("weekly_outreach_id").in("weekly_outreach_id", rows.map((r) => r.id));
  const have = new Set((existing ?? []).map((r) => (r as { weekly_outreach_id: string }).weekly_outreach_id));
  const fresh = rows.filter((r) => !have.has(r.id) && r.draft);
  if (fresh.length === 0) return [];

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
  return created;
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

export function matchSequence(groupName: string | null, sequences: OutreachSequence[], overrides: Record<string, string>): OutreachSequence | null {
  if (!groupName) return null;
  const override = overrides[groupName];
  if (override) return sequences.find((s) => s.id === override) ?? null;
  const want = normalizeSequenceName(groupName);
  if (!want) return null;
  // Only the "[E]" sequences are first-touch sequences; "[D-E]" and others are not.
  const pool = sequences.filter((s) => s.enabled && /^\s*\[E\]/i.test(s.name));
  const exact = pool.find((s) => normalizeSequenceName(s.name) === want);
  if (exact) return exact;
  const contains = pool.filter((s) => {
    const n = normalizeSequenceName(s.name);
    return n.endsWith(want) || want.endsWith(n) || n.includes(want);
  });
  return contains.length === 1 ? contains[0] : null;
}

// ── Draft review (flag only) ────────────────────────────────────────────────

type SourcingContext = { address: string | null; restaurants: string[]; hook: string | null; hookAnchor: string | null; websiteText: string | null } | null;

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
    hook: r.emailHook ?? null,
    hookAnchor: r.hookAnchor ? JSON.stringify(r.hookAnchor).slice(0, 600) : null,
    websiteText: r.currentText ?? null,
  };
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
function systemFlags(send: Pick<E1Send, "contact_email" | "verify_result" | "sequence_id" | "contact_id">): ReviewFlag[] {
  const out: ReviewFlag[] = [];
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
  if (!send.sequence_id) out.push({ kind: "sequence", severity: "red", message: "No Outreach sequence matched this group. Pick one." });
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

  const updated = await updateSend(id, patch);

  // Model review of the draft, flag only.
  const modelFlags = settings.reviewWithModel ? await reviewDraft(updated).catch(() => []) : [];
  const flags = [...systemFlags(updated), ...modelFlags];
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
  const merged = { ...send, ...patch };
  const modelFlags = send.review_flags.filter((f) => !["contact", "email", "sequence"].includes(f.kind));
  const flags = [...systemFlags(merged), ...modelFlags];
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

  // Already in an active sequence anywhere: do not double up.
  const existing = await findProspectByEmail(send.contact_email);
  if (existing) {
    const active = await outreachRequest(`/sequenceStates?filter[prospect][id]=${existing.id}&filter[state]=active&page[size]=1`);
    if (active.ok) {
      const body = (await active.json()) as { data?: unknown[] };
      if ((body.data ?? []).length > 0) return { blocked: "This contact is already in an active Outreach sequence." };
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
  const state = await addProspectToSequence({ prospectId: prospect.id, sequenceId: send.sequence_id, mailboxId: mailbox.id });
  await updateSend(id, { outreach_prospect_id: prospect.id, outreach_state_id: state.id, status: "scheduling" });
  return { prospectId: prospect.id, stateId: state.id, mailboxId: mailbox.id };
}

/** The manual step's task, once Outreach has activated the state. Null when not there yet. */
export async function findStepTask(stateId: string): Promise<string | null> {
  const res = await outreachRequest(`/tasks?filter[sequenceState][id]=${stateId}&page[size]=5&fields[task]=taskType,state,completed`);
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: Array<{ id: string; attributes?: { completed?: boolean } }> };
  const task = (body.data ?? []).find((t) => !t.attributes?.completed) ?? body.data?.[0];
  return task?.id ?? null;
}

async function signatureHtml(settings: SendSettings): Promise<string | null> {
  if (settings.signatureText.trim()) return textToHtml(settings.signatureText.trim());
  const stored = await getStoredSignature();
  return stored?.html ?? null;
}

/**
 * Create the mailing on the task with the reviewed subject and body, the
 * signature, tracking on, and the send time. Dry run leaves it as a draft in
 * the outbox; otherwise it is flipped to scheduled.
 */
export async function createMailingForSend(id: string, ids: { prospectId: string; mailboxId: string; taskId: string }, sendAt: Date, settings: SendSettings): Promise<E1Send> {
  const send = await getSend(id);
  if (!send || !send.body) throw new Error("Send row has no body.");
  const bodyHtml = composeHtmlBody(send.body, await signatureHtml(settings));
  const res = await outreachRequest(`/mailings`, {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "mailing",
        attributes: { subject: send.subject ?? "", bodyHtml, scheduledAt: sendAt.toISOString(), trackLinks: true, trackOpens: true },
        relationships: {
          prospect: { data: { type: "prospect", id: ids.prospectId } },
          mailbox: { data: { type: "mailbox", id: ids.mailboxId } },
          task: { data: { type: "task", id: ids.taskId } },
        },
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Outreach refused the mailing: ${text.slice(0, 300)}`);
  const mailingId = (JSON.parse(text) as { data?: { id?: string | number } }).data?.id;
  if (!mailingId) throw new Error("Outreach created the mailing but returned no id.");
  const patch: Partial<E1Send> = { outreach_mailing_id: String(mailingId), outreach_task_id: ids.taskId, scheduled_for: sendAt.toISOString() };
  if (settings.dryRun) return updateSend(id, { ...patch, status: "dry_run", status_reason: "Dry run: draft created in Outreach, not scheduled." });
  const flip = await outreachRequest(`/mailings/${mailingId}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { type: "mailing", id: Number(mailingId), attributes: { state: "scheduled", scheduledAt: sendAt.toISOString() } } }),
  });
  if (!flip.ok) throw new Error(`Outreach would not schedule the mailing: ${(await flip.text()).slice(0, 300)}`);
  return updateSend(id, { ...patch, status: "scheduled", status_reason: null });
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
