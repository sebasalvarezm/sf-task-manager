// Suggested Call Logger fields (commentary, follow-up, type) from a call's
// Granola notes, written in your style from your own past entries.
//
// The AI writes; this file keeps it honest:
// - Examples: 15 to 25 of your past entries, your corrected versions first,
//   then the short lines most similar to this call.
// - Facts: any comma-separated fragment with a number that isn't in the
//   notes is dropped, so a guessed revenue or headcount never survives.
// - Follow-up: the AI only says WHEN the next step is (a date, a number of
//   days, or none). The RCE number is worked out here from the meeting date.
//
// Server-only.

import { CALL_STYLE, isShortStyle, type CallType, type PastCall } from "./call-history";

export type CallSuggestion = {
  commentary: string | null;
  callType: CallType | null;
  typeReason: string | null;
  followUpDays: number | null;
  followUpReason: string | null;
};

export type SuggestionInput = {
  meetingTitle: string;
  meetingDate: string; // yyyy-MM-dd
  accountName: string | null;
  /** Past calls already logged on this account (any type), newest first. */
  accountHistory: PastCall[];
  summary: string;
  transcript: string;
};

export const MIN_EXAMPLES = 15;
export const MAX_EXAMPLES = 25;
const MAX_CORRECTIONS = 10;

const STOP = new Set(
  "the a an and or of to in on for with is are was be it this that we they he she our their at by from as not but have has will would can".split(
    " ",
  ),
);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9$£€%]+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

/**
 * 15–25 examples: corrected versions first (most recent), then short
 * past lines ranked by word overlap with this call, newest breaking ties.
 */
export function selectExamples(
  history: PastCall[],
  corrections: PastCall[],
  callText: string,
  limit = 20,
): PastCall[] {
  const target = Math.max(MIN_EXAMPLES, Math.min(MAX_EXAMPLES, limit));
  const picked: PastCall[] = [];
  const seen = new Set<string>();
  const add = (c: PastCall) => {
    const key = c.commentary.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    picked.push(c);
  };
  for (const c of corrections.slice(0, MAX_CORRECTIONS)) add(c);

  const callTokens = tokens(callText);
  const ranked = history
    .filter((c) => isShortStyle(c.commentary))
    .map((c, index) => {
      let overlap = 0;
      for (const t of tokens(c.commentary)) if (callTokens.has(t)) overlap++;
      return { c, score: overlap * 10 - index * 0.01 }; // history is newest first
    })
    .sort((a, b) => b.score - a.score);
  for (const { c } of ranked) {
    if (picked.length >= target) break;
    add(c);
  }
  return picked;
}

// ── Fact guard ──────────────────────────────────────────────────────────────

/** Number-ish tokens: 4M, $24M, 2.6M, 20, 30%, £8M, 4-6x, Q1, 2027. */
function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "."));
}

function normalisedNumbers(text: string): Set<string> {
  const set = new Set<string>();
  for (const n of numbersIn(text)) {
    set.add(n);
    set.add(String(Number(n))); // "2.50" ~ "2.5"
  }
  // Spelled-out millions in transcripts: "four million" is common speech.
  const words: Record<string, string> = {
    one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
    ten: "10", eleven: "11", twelve: "12", fifteen: "15", twenty: "20", thirty: "30", forty: "40", fifty: "50", hundred: "100",
  };
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) if (words[w]) set.add(words[w]);
  // "within a week" is written "within 1 week".
  if (/\b(a|an)\s+(day|week|month|quarter|year)\b/i.test(text)) set.add("1");
  return set;
}

/**
 * Drops any comma-separated fragment that mentions a number the notes
 * don't contain. Better a shorter line than an invented revenue figure.
 */
export function dropUnsupportedFacts(commentary: string, sourceText: string): string {
  const known = normalisedNumbers(sourceText);
  const kept = commentary
    .split(/,\s*/)
    .filter((fragment) => numbersIn(fragment).every((n) => known.has(n) || known.has(String(Number(n)))));
  return kept.join(", ").trim();
}

// ── Follow-up ───────────────────────────────────────────────────────────────

export type FollowUpTiming =
  | { kind: "date"; date: string; reason: string }
  | { kind: "days"; days: number; reason: string }
  | { kind: "none"; reason: string };

const MAX_FOLLOW_UP_DAYS = 730;

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const to = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((to - from) / 86_400_000);
}

/** RCE days from the timing the call gave. Null = no follow-up. */
export function followUpDaysFromTiming(timing: FollowUpTiming, meetingDate: string): number | null {
  if (timing.kind === "none") return null;
  let days: number;
  if (timing.kind === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(timing.date) || !/^\d{4}-\d{2}-\d{2}$/.test(meetingDate)) return null;
    days = daysBetween(meetingDate, timing.date);
  } else {
    days = Math.round(timing.days);
  }
  if (!Number.isFinite(days) || days < 1) return null;
  return Math.min(MAX_FOLLOW_UP_DAYS, days);
}

// ── Prompt ──────────────────────────────────────────────────────────────────

function exampleLine(c: PastCall): string {
  const fu =
    c.followUpDays === undefined ? "" : c.followUpDays ? ` | follow-up RCE${c.followUpDays}` : " | no follow-up";
  const corrected =
    c.source === "correction"
      ? c.suggestedCommentary
        ? ` (you corrected the suggestion "${c.suggestedCommentary}" to this)`
        : " (your corrected version)"
      : "";
  return `- ${c.callType} - ${c.commentary}${fu}${corrected}`;
}

export function buildSuggestionPrompt(input: SuggestionInput, examples: PastCall[]): string {
  const history = input.accountHistory.slice(0, 5);
  const historyText = history.length
    ? history.map((c) => `- ${c.meetingDate ?? "?"}: ${c.callType} - ${c.commentary}`).join("\n")
    : "- none found";
  return `You fill in a Salesforce call log for Sebastian (M&A, Valstone) from his Granola notes of one call.

STYLE (his, confirmed):
${CALL_STYLE.description.map((l) => `- ${l}`).join("\n")}

HIS PAST ENTRIES (match this voice and length; never copy their facts):
${examples.map(exampleLine).join("\n")}

FOLLOW-UP RULES:
${CALL_STYLE.followUp.map((l) => `- ${l}`).join("\n")}

CALL TYPES:
${CALL_STYLE.callTypes.map((l) => `- ${l}`).join("\n")}

HARD RULES:
- Every fact (revenue, ARR, headcount, age, ownership, growth, valuation, timing, names) must come from THIS call's notes or transcript below. If a fact isn't there, leave it out. Never estimate or round up.
- Write the commentary only, without the "C1 - " prefix.
- If the notes are too thin to say anything useful, return null for commentary.

THIS CALL
Meeting: ${input.meetingTitle}
Meeting date: ${input.meetingDate}
Salesforce account: ${input.accountName ?? "unknown"}
Calls already logged with this account:
${historyText}

GRANOLA SUMMARY:
${input.summary.slice(0, 12000)}

TRANSCRIPT (may be partial):
${input.transcript.slice(0, 40000) || "(none)"}

Return ONLY this JSON:
{
  "commentary": "one line in his style, or null",
  "callType": "C1" | "RCC" | null,
  "typeReason": "under 12 words",
  "followUp": { "kind": "date", "date": "YYYY-MM-DD", "reason": "under 15 words, quote the timing said on the call" }
           | { "kind": "days", "days": 14, "reason": "..." }
           | { "kind": "none", "reason": "..." }
}
Use callType null if the call doesn't make it clear. Convert relative timing ("after their fiscal year", "in Q1", "next week") to a concrete date using the meeting date. Use kind "none" when no timing was discussed or it's a dead end.`;
}

/** Turn the AI's JSON into a safe suggestion. Pure, for tests. */
export function parseSuggestion(raw: string, input: SuggestionInput): CallSuggestion {
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("The AI reply had no JSON");
  const parsed = JSON.parse(json) as {
    commentary?: unknown;
    callType?: unknown;
    typeReason?: unknown;
    followUp?: { kind?: unknown; date?: unknown; days?: unknown; reason?: unknown } | null;
  };

  const source = `${input.summary}\n${input.transcript}`;
  let commentary =
    typeof parsed.commentary === "string" && parsed.commentary.trim() ? parsed.commentary.trim() : null;
  if (commentary) {
    commentary = commentary.replace(/^(C1|RCC)\s*[-–—:]\s*/i, "").replace(/;/g, ",").replace(/\s+/g, " ");
    commentary = dropUnsupportedFacts(commentary, source) || null;
  }

  const callType = parsed.callType === "C1" || parsed.callType === "RCC" ? parsed.callType : null;
  const typeReason = typeof parsed.typeReason === "string" ? parsed.typeReason.trim().slice(0, 120) : null;

  const fu = parsed.followUp ?? { kind: "none" };
  const reason = typeof fu.reason === "string" ? fu.reason.trim().slice(0, 160) : "";
  let timing: FollowUpTiming;
  if (fu.kind === "date" && typeof fu.date === "string") timing = { kind: "date", date: fu.date, reason };
  else if (fu.kind === "days" && typeof fu.days === "number") timing = { kind: "days", days: fu.days, reason };
  else timing = { kind: "none", reason };
  const followUpDays = followUpDaysFromTiming(timing, input.meetingDate);

  return {
    commentary,
    callType,
    typeReason: callType ? typeReason : null,
    followUpDays,
    followUpReason: followUpDays ? reason || null : null,
  };
}
