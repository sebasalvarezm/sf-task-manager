import { getSupabaseAdmin } from "./supabase";
import { sfQuery } from "./sf-query";
import { getOutreachValidCredentials } from "./outreach";
import { extractYear, scoreAccountQuality } from "./outreach-quality";
import { getQualityThresholds } from "./outreach-quality-settings";
import { upstreamErrorText } from "./upstream-error";
import { buildReport, plainFindings, type OutcomesReport, type SendRow } from "./outcomes-analysis";

/**
 * Outcomes: the table that puts "what we sent" next to "what happened".
 *
 * Spine: every completed E1 / RCE1 / D-E1 task in Salesforce over the lookback
 * (the official record of a sequence start, with the account's facts).
 * Outreach mailings, cached in outreach_mailings, supply the subject line,
 * the sequence name, opens, and the reply timestamp. A reply to any step of
 * the sequence within REPLY_DAYS counts for the start. A C1 or RCC task on the
 * account within CALL_DAYS counts as a call.
 */

export const LOOKBACK_MONTHS = 12;
export const REPLY_DAYS = 45;
export const CALL_DAYS = 90;
const SEND_TYPES = ["E1", "RCE1", "D-E1"];
const CALL_TYPES = ["C1", "RCC"];
const REPORT_KEY = "outcomes_report";
const OUTREACH_API_BASE = "https://api.outreach.io/api/v2";
const ET = "America/Toronto";

// ── Outreach mailings cache ──────────────────────────────────────────────────

type MailingRow = {
  mailing_id: string;
  prospect_id: string | null;
  email: string | null;
  sequence_name: string | null;
  mailing_type: string | null;
  subject: string | null;
  state: string | null;
  created_at: string | null;
  delivered_at: string | null;
  opened_at: string | null;
  replied_at: string | null;
  open_count: number;
  synced_at: string;
};

type JsonApi = {
  data?: Array<{ id: string; attributes?: Record<string, unknown>; relationships?: Record<string, { data?: { id?: string; type?: string } | null }> }>;
  included?: Array<{ id: string; type: string; attributes?: Record<string, unknown> }>;
  links?: { next?: string };
};

/**
 * Walk Outreach mailings newest first, `pages` pages per call, writing each
 * page into outreach_mailings. Returns the next page link, or null once the
 * walk reaches mailings older than `since` (or the end). Outreach's date
 * filters have been unreliable here, so we page and stop instead.
 */
export async function syncMailings(cursor: string | null, since: string, pages = 10): Promise<{ next: string | null; written: number }> {
  const credentials = await getOutreachValidCredentials();
  if (!credentials) throw new Error("OUTREACH_NOT_CONNECTED");
  const supabase = getSupabaseAdmin();
  const sinceMs = Date.parse(since);
  let next: string | null =
    cursor ??
    `${OUTREACH_API_BASE}/mailings?page[size]=100&sort=-createdAt&include=prospect,sequence` +
      `&fields[mailing]=subject,state,mailingType,createdAt,deliveredAt,openedAt,repliedAt,openCount,prospect,sequence` +
      `&fields[prospect]=emails&fields[sequence]=name`;
  let written = 0;
  for (let p = 0; p < pages && next; p++) {
    const res = await fetch(next, { headers: { Authorization: `Bearer ${credentials.access_token}`, "Content-Type": "application/vnd.api+json" } });
    if (!res.ok) {
      if (res.status === 401) throw new Error("OUTREACH_NOT_CONNECTED");
      throw new Error(`Outreach mailings failed: ${await upstreamErrorText("Outreach", res)}`);
    }
    const body = (await res.json()) as JsonApi;
    const emails = new Map<string, string>();
    const sequences = new Map<string, string>();
    for (const inc of body.included ?? []) {
      if (inc.type === "prospect") {
        const list = (inc.attributes?.emails as string[] | undefined) ?? [];
        if (list[0]) emails.set(inc.id, String(list[0]).toLowerCase());
      } else if (inc.type === "sequence") {
        const name = inc.attributes?.name;
        if (typeof name === "string") sequences.set(inc.id, name);
      }
    }
    const rows: MailingRow[] = [];
    let reachedEnd = false;
    for (const m of body.data ?? []) {
      const a = m.attributes ?? {};
      const createdAt = typeof a.createdAt === "string" ? a.createdAt : null;
      if (createdAt && Date.parse(createdAt) < sinceMs) {
        reachedEnd = true;
        continue;
      }
      const prospectId = m.relationships?.prospect?.data?.id ?? null;
      const sequenceId = m.relationships?.sequence?.data?.id ?? null;
      rows.push({
        mailing_id: m.id,
        prospect_id: prospectId,
        email: prospectId ? emails.get(prospectId) ?? null : null,
        sequence_name: sequenceId ? sequences.get(sequenceId) ?? null : null,
        mailing_type: typeof a.mailingType === "string" ? a.mailingType : null,
        subject: typeof a.subject === "string" ? a.subject.slice(0, 300) : null,
        state: typeof a.state === "string" ? a.state : null,
        created_at: createdAt,
        delivered_at: typeof a.deliveredAt === "string" ? a.deliveredAt : null,
        opened_at: typeof a.openedAt === "string" ? a.openedAt : null,
        replied_at: typeof a.repliedAt === "string" ? a.repliedAt : null,
        open_count: Number(a.openCount) || 0,
        synced_at: new Date().toISOString(),
      });
    }
    if (rows.length > 0) {
      const { error } = await supabase.from("outreach_mailings").upsert(rows, { onConflict: "mailing_id" });
      if (error) throw new Error(error.message);
      written += rows.length;
    }
    next = reachedEnd ? null : body.links?.next ?? null;
  }
  return { next, written };
}

// ── Salesforce spine ─────────────────────────────────────────────────────────

type SfSend = {
  Id: string;
  ActivityDate: string | null;
  CompletedDateTime: string | null;
  Subject_Type__c: string;
  AccountId: string;
  Owner?: { Name?: string | null } | null;
  WhoId: string | null;
  Account?: {
    Name?: string | null;
    BillingCountry?: string | null;
    NumberOfEmployees?: number | null;
    Industry?: string | null;
    Responded__c?: string | boolean | null;
    Year_Established__c?: string | null;
  } | null;
};

async function fetchSfSends(): Promise<SfSend[]> {
  const q = (withFounded: boolean) =>
    `SELECT Id, ActivityDate, CompletedDateTime, Subject_Type__c, AccountId, Owner.Name, WhoId, ` +
    `Account.Name, Account.BillingCountry, Account.NumberOfEmployees, Account.Industry, Account.Responded__c` +
    (withFounded ? `, Account.Year_Established__c` : ``) +
    ` FROM Task WHERE Subject_Type__c IN (${SEND_TYPES.map((t) => `'${t}'`).join(",")}) AND Status = 'Completed' ` +
    `AND AccountId != null AND ActivityDate = LAST_N_MONTHS:${LOOKBACK_MONTHS} ORDER BY ActivityDate ASC`;
  try {
    return await sfQuery<SfSend>(q(true));
  } catch (err) {
    if (err instanceof Error && err.message === "NOT_CONNECTED") throw err;
    return await sfQuery<SfSend>(q(false));
  }
}

async function fetchSfCalls(): Promise<Array<{ AccountId: string; ActivityDate: string | null }>> {
  return sfQuery<{ AccountId: string; ActivityDate: string | null }>(
    `SELECT AccountId, ActivityDate FROM Task WHERE Subject_Type__c IN (${CALL_TYPES.map((t) => `'${t}'`).join(",")}) ` +
      `AND Status = 'Completed' AND AccountId != null AND ActivityDate = LAST_N_MONTHS:${LOOKBACK_MONTHS + 3}`,
  );
}

/**
 * Emails for the task's contact and for every contact on the account.
 * Who.Email cannot be read through the task's polymorphic link, and many
 * Outreach-logged tasks carry no WhoId at all, so the join uses any address
 * on the account. M&A accounts have a handful of contacts, so this is safe.
 */
async function fetchContactEmails(whoIds: string[], accountIds: string[]): Promise<{ byContact: Map<string, string>; byAccount: Map<string, string[]> }> {
  const byContact = new Map<string, string>();
  const byAccount = new Map<string, string[]>();
  type C = { Id: string; AccountId: string | null; Email: string | null };
  const chunk = 300;
  const ids = Array.from(new Set(whoIds.filter((id) => /^003/.test(id))));
  for (let i = 0; i < ids.length; i += chunk) {
    const rows = await sfQuery<C>(`SELECT Id, AccountId, Email FROM Contact WHERE Id IN (${ids.slice(i, i + chunk).map((x) => `'${x}'`).join(",")})`);
    for (const c of rows) if (c.Email) byContact.set(c.Id, c.Email.toLowerCase());
  }
  const accts = Array.from(new Set(accountIds));
  for (let i = 0; i < accts.length; i += chunk) {
    const rows = await sfQuery<C>(`SELECT Id, AccountId, Email FROM Contact WHERE Email != null AND AccountId IN (${accts.slice(i, i + chunk).map((x) => `'${x}'`).join(",")})`);
    for (const c of rows) {
      if (!c.AccountId || !c.Email) continue;
      const list = byAccount.get(c.AccountId) ?? [];
      list.push(c.Email.toLowerCase());
      byAccount.set(c.AccountId, list);
    }
  }
  return { byContact, byAccount };
}

function etParts(iso: string | null): { weekday: number | null; hour: number | null } {
  if (!iso) return { weekday: null, hour: null };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { weekday: null, hour: null };
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short", hour: "numeric", hour12: false });
  const parts = fmt.formatToParts(d);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hr = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  return { weekday: weekday >= 0 ? weekday : null, hour: Number.isFinite(hr) ? hr % 24 : null };
}

const addDays = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Rebuild outreach_sends from Salesforce plus the mailings cache. Returns counts for the job log. */
export async function buildSends(): Promise<{ sends: number; matched: number; replies: number; calls: number }> {
  const supabase = getSupabaseAdmin();
  const [sends, calls, thresholds] = await Promise.all([fetchSfSends(), fetchSfCalls(), getQualityThresholds()]);
  const foundedAvailable = sends.some((s) => s.Account && "Year_Established__c" in s.Account);

  const callsByAccount = new Map<string, string[]>();
  for (const c of calls) {
    if (!c.ActivityDate) continue;
    const list = callsByAccount.get(c.AccountId) ?? [];
    list.push(c.ActivityDate);
    callsByAccount.set(c.AccountId, list);
  }

  const contacts = await fetchContactEmails(
    sends.map((s) => s.WhoId).filter((id): id is string => !!id),
    sends.map((s) => s.AccountId),
  );
  const emailsFor = (s: SfSend): string[] => {
    const who = s.WhoId ? contacts.byContact.get(s.WhoId) : null;
    const acct = contacts.byAccount.get(s.AccountId) ?? [];
    return Array.from(new Set([...(who ? [who] : []), ...acct]));
  };

  // Mailings for the addresses we could have written to, in chunks (PostgREST URL length).
  const emails = Array.from(new Set(sends.flatMap(emailsFor)));
  const mailingsByEmail = new Map<string, MailingRow[]>();
  for (let i = 0; i < emails.length; i += 200) {
    const { data, error } = await supabase
      .from("outreach_mailings")
      .select("mailing_id, email, sequence_name, subject, delivered_at, created_at, opened_at, replied_at, open_count, mailing_type, state, prospect_id, synced_at")
      .in("email", emails.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const m of (data ?? []) as MailingRow[]) {
      if (!m.email) continue;
      const list = mailingsByEmail.get(m.email) ?? [];
      list.push(m);
      mailingsByEmail.set(m.email, list);
    }
  }

  // Prior sends: how many earlier starts the account had in the lookback (sends are date ascending).
  const seen = new Map<string, number>();
  const rows: Array<Record<string, unknown>> = [];
  let matched = 0;
  let replies = 0;
  let callCount = 0;
  for (const s of sends) {
    const sentOn = s.ActivityDate ?? s.CompletedDateTime?.slice(0, 10);
    if (!sentOn) continue;
    const candidates = emailsFor(s);
    const prior = seen.get(s.AccountId) ?? 0;
    seen.set(s.AccountId, prior + 1);
    const { weekday, hour } = etParts(s.CompletedDateTime);

    // The mailing for this start: same address, delivered within a day either side.
    let mailing: MailingRow | null = null;
    let repliedAt: string | null = null;
    let opened: boolean | null = null;
    let email: string | null = candidates[0] ?? null;
    if (candidates.length > 0) {
      const list = candidates.flatMap((e) => mailingsByEmail.get(e) ?? []);
      const lo = addDays(sentOn, -1);
      const hi = addDays(sentOn, 2);
      const replyLimit = addDays(sentOn, REPLY_DAYS);
      for (const m of list) {
        const day = (m.delivered_at ?? m.created_at ?? "").slice(0, 10);
        if (day >= lo && day <= hi && (!mailing || (m.mailing_type === "sequence" && mailing.mailing_type !== "sequence"))) mailing = m;
        if (m.replied_at && m.replied_at.slice(0, 10) >= sentOn && m.replied_at.slice(0, 10) <= replyLimit) {
          if (!repliedAt || m.replied_at < repliedAt) repliedAt = m.replied_at;
        }
      }
      if (mailing) {
        matched++;
        email = mailing.email ?? email;
        // Any open on any step of this sequence within the reply window counts as opened.
        opened = list.some((m) => {
          const day = (m.delivered_at ?? m.created_at ?? "").slice(0, 10);
          return day >= lo && day <= replyLimit && (m.open_count > 0 || !!m.opened_at);
        });
      }
    }
    const callLimit = addDays(sentOn, CALL_DAYS);
    const callOn = (callsByAccount.get(s.AccountId) ?? []).filter((d) => d > sentOn && d <= callLimit).sort()[0] ?? null;
    if (repliedAt) replies++;
    if (callOn) callCount++;
    const acc = s.Account ?? {};
    const responded = acc.Responded__c === true || (typeof acc.Responded__c === "string" && /^(yes|y|true)$/i.test(acc.Responded__c));
    // Same rules as the BS meter: 2+ flags is flagged, exactly 1 is potential, 0 is clean.
    const verdict = scoreAccountQuality(
      { country: acc.BillingCountry ?? null, yearEstablished: acc.Year_Established__c ?? null, numberOfEmployees: typeof acc.NumberOfEmployees === "number" ? acc.NumberOfEmployees : null },
      thresholds,
      { foundedFieldAvailable: foundedAvailable },
    );
    const quality = verdict.isBs ? "flagged" : verdict.flags.length > 0 ? "potential" : "clean";
    rows.push({
      quality,
      sf_task_id: s.Id,
      account_id: s.AccountId,
      account_name: acc.Name ?? null,
      contact_email: email,
      sent_on: sentOn,
      sent_at: s.CompletedDateTime ?? null,
      sender: s.Owner?.Name ?? null,
      subject_type: s.Subject_Type__c,
      country: acc.BillingCountry ?? null,
      employees: typeof acc.NumberOfEmployees === "number" ? acc.NumberOfEmployees : null,
      founded: extractYear(acc.Year_Established__c ?? null),
      industry: acc.Industry ?? null,
      prior_sends: prior,
      weekday,
      hour_et: hour,
      mailing_id: mailing?.mailing_id ?? null,
      sequence_name: mailing?.sequence_name ?? null,
      subject: mailing?.subject ?? null,
      opened,
      replied_at: repliedAt,
      call_on: callOn,
      responded,
      built_at: new Date().toISOString(),
    });
  }

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from("outreach_sends").upsert(rows.slice(i, i + 500), { onConflict: "sf_task_id" });
    if (error) throw new Error(error.message);
  }
  return { sends: rows.length, matched, replies, calls: callCount };
}

// ── Report ───────────────────────────────────────────────────────────────────

async function loadSendRows(): Promise<SendRow[]> {
  const supabase = getSupabaseAdmin();
  const out: SendRow[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from("outreach_sends")
      .select("sent_on, sender, subject_type, country, employees, founded, industry, prior_sends, weekday, hour_et, mailing_id, sequence_name, subject, opened, replied_at, call_on, quality")
      .order("sent_on", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as SendRow[]));
    if ((data ?? []).length < page) break;
  }
  return out;
}

/** Compute the report from the table, write the plain-English findings, and save both for the page. */
export async function buildAndSaveReport(): Promise<OutcomesReport> {
  const rows = await loadSendRows();
  const report = buildReport(rows);
  report.findings = await writeFindings(report).catch(() => null);
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("app_settings").upsert({ key: REPORT_KEY, value: report, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  return report;
}

export async function loadReport(): Promise<OutcomesReport | null> {
  const { data } = await getSupabaseAdmin().from("app_settings").select("value").eq("key", REPORT_KEY).maybeSingle();
  return (data?.value as OutcomesReport | undefined) ?? null;
}

/** Findings come straight from the numbers (lib/outcomes-analysis.ts); no model call, nothing invented. */
async function writeFindings(report: OutcomesReport): Promise<string[] | null> {
  const lines = plainFindings(report);
  return lines.length ? lines : null;
}
