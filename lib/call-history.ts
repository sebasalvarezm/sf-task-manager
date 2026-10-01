// Your past call logs, used as style examples for Granola suggestions.
//
// Two read-only sources:
//   1. Salesforce: your completed C1 / RCC tasks. The subject is
//      "C1 - <commentary>", which is what you typed into the Call Logger.
//   2. This app's own log (finished Call Logger jobs). It also has the exact
//      follow-up you chose (RCE14 = 14 days), which Salesforce only has
//      indirectly.
// Nothing here writes anywhere.
//
// The style rules you confirmed (Oct 1, 2026) live in CALL_STYLE below.

import { getSupabaseAdmin } from "./supabase";
import { getValidCredentials } from "./token-manager";
import { sfQuery } from "./sf-query";

export type CallType = "C1" | "RCC";

export type PastCall = {
  source: "salesforce" | "app" | "correction";
  accountId: string | null;
  accountName: string;
  callType: CallType;
  commentary: string;
  /** Days to the RCE follow-up; null = none chosen; undefined = unknown. */
  followUpDays?: number | null;
  meetingDate: string | null;
  /** For corrections: what was suggested before you edited it. */
  suggestedCommentary?: string | null;
};

/**
 * Confirmed by Seb on Oct 1, 2026 (item 3):
 * - Learn only from his short shorthand lines, not the longer polished ones
 *   (many of which came from the old "Suggest call log" button).
 * - No default follow-up: if the call gives no timing, leave it empty.
 */
export const CALL_STYLE = {
  maxExampleWords: 20,
  description: [
    "One line, usually 6 to 15 words. Comma-separated fragments, no subject, no full sentences.",
    "Lead with the size number in shorthand if one was given (2.6M, Sub 2M, 4.5M CAD, 20 FTE, ~$4M rev).",
    "Then their stance on selling or partnering (open to discuss, not selling now, wants partnership before acquisition).",
    "Then the next step or who owns it (will share data, wants F2F in Dallas, ping Marcus, handover to Dan/Tyson, IC within 1 week).",
    "Give a blunt verdict when there is one (not realistic, low probability, likely not for us at this time).",
    "Valuation asks as multiples or amounts (wants 4-6x, wants 30M). Mention ownership, funding or founder situation only when it matters (MBO-led, self-funded, founder wants out).",
    "No semicolons, no marketing words, no AI phrasing.",
  ],
  followUp: [
    "The follow-up code is RCE + number of calendar days after the meeting date (RCE14 = 14 days later).",
    "Match it to the next step discussed: something due within a week is 5 to 7 days; a named date or month is the days until shortly after it; 'not for us right now' is about 60; a re-engage in a later quarter or year is the days until then (Q1-Q2 next year from September is about 180).",
    "A dead end ('not realistic', no interest) gets no follow-up.",
    "If the call gives no timing at all, leave the follow-up empty. There is no default.",
  ],
  callTypes: [
    "C1 = first call with this company.",
    "RCC = any later call with a company already known: reconnects, management calls, handovers, broker-run follow-ups.",
  ],
} as const;

const PREFIX = /^(C1|RCC)\s*[-–—:]\s*/i;

/** "C1 - Sub 2M, think..." → "Sub 2M, think..."; null when nothing is left. */
export function commentaryFromSubject(subject: string | null | undefined): string | null {
  const text = (subject ?? "").replace(PREFIX, "").trim();
  if (!text || /^(C1|RCC)$/i.test(text)) return null;
  return text;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** The confirmed rule: short shorthand lines only (≤ 20 words, no semicolons). */
export function isShortStyle(commentary: string): boolean {
  const text = commentary.trim();
  return text.length > 0 && !text.includes(";") && wordCount(text) <= CALL_STYLE.maxExampleWords;
}

type SfCallRow = {
  Id: string;
  Subject: string | null;
  Subject_Type__c: string | null;
  ActivityDate: string | null;
  WhatId: string | null;
  What?: { Name?: string | null } | null;
};

async function fetchSalesforceCalls(): Promise<PastCall[]> {
  const credentials = await getValidCredentials();
  if (!credentials?.salesforce_user_id) return [];
  const rows = await sfQuery<SfCallRow>(
    `SELECT Id, Subject, Subject_Type__c, ActivityDate, WhatId, What.Name FROM Task ` +
      `WHERE OwnerId = '${credentials.salesforce_user_id.replace(/[^a-zA-Z0-9]/g, "")}' ` +
      `AND Status = 'Completed' AND Subject_Type__c IN ('C1','RCC') ` +
      `AND ActivityDate = LAST_N_DAYS:730 ORDER BY ActivityDate DESC LIMIT 1500`,
    credentials,
  );
  const calls: PastCall[] = [];
  for (const row of rows) {
    const commentary = commentaryFromSubject(row.Subject);
    if (!commentary) continue;
    calls.push({
      source: "salesforce",
      accountId: row.WhatId,
      accountName: row.What?.Name ?? "",
      callType: row.Subject_Type__c === "RCC" ? "RCC" : "C1",
      commentary,
      meetingDate: row.ActivityDate,
    });
  }
  return calls;
}

type JobRow = {
  input: { entries?: Array<Record<string, unknown>> } | null;
  result: { results?: Array<Record<string, unknown>> } | null;
};

/** Pure, for tests: the calls a finished Call Logger job actually logged. */
export function callsFromJob(job: JobRow): PastCall[] {
  const entries = job.input?.entries ?? [];
  const results = job.result?.results ?? [];
  const logged = new Set(
    results
      .filter((r) => r.success === true && r.alreadyLogged !== true && typeof r.eventId === "string")
      .map((r) => r.eventId as string),
  );
  const calls: PastCall[] = [];
  for (const e of entries) {
    if (typeof e.eventId === "string" && results.length > 0 && !logged.has(e.eventId)) continue;
    const commentary = typeof e.commentary === "string" ? e.commentary.trim() : "";
    if (!commentary) continue;
    calls.push({
      source: "app",
      accountId: typeof e.accountId === "string" ? e.accountId : null,
      accountName: typeof e.accountName === "string" ? e.accountName : "",
      callType: e.callType === "RCC" ? "RCC" : "C1",
      commentary,
      followUpDays: typeof e.followUpDays === "number" ? e.followUpDays : null,
      meetingDate: typeof e.meetingDate === "string" ? e.meetingDate : null,
    });
  }
  return calls;
}

async function fetchAppCalls(): Promise<PastCall[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("jobs")
    .select("input, result")
    .eq("kind", "calls_log")
    .eq("status", "succeeded")
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw new Error(error.message);
  return ((data ?? []) as JobRow[]).flatMap(callsFromJob);
}

/** Merge: the app's log wins (it knows the follow-up), Salesforce fills the rest. */
export function mergeCallHistory(app: PastCall[], salesforce: PastCall[]): PastCall[] {
  const key = (c: PastCall) =>
    `${c.accountId ?? c.accountName.toLowerCase()}|${c.meetingDate ?? ""}|${c.callType}`;
  const seen = new Set(app.map(key));
  return [...app, ...salesforce.filter((c) => !seen.has(key(c)))];
}

let cache: { at: number; calls: PastCall[] } | null = null;
const CACHE_MS = 10 * 60 * 1000;

/**
 * All past calls, newest first. Either source failing is not fatal: the
 * suggestions just have fewer examples to work from.
 */
export async function fetchCallHistory(): Promise<PastCall[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.calls;
  const [app, salesforce] = await Promise.all([
    fetchAppCalls().catch((err) => {
      console.error("call history (app log) failed:", err instanceof Error ? err.message : err);
      return [] as PastCall[];
    }),
    fetchSalesforceCalls().catch((err) => {
      console.error("call history (Salesforce) failed:", err instanceof Error ? err.message : err);
      return [] as PastCall[];
    }),
  ]);
  const calls = mergeCallHistory(app, salesforce).sort((a, b) =>
    (b.meetingDate ?? "").localeCompare(a.meetingDate ?? ""),
  );
  cache = { at: Date.now(), calls };
  return calls;
}

export function clearCallHistoryCache() {
  cache = null;
}
