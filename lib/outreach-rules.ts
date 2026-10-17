/**
 * Outreach rules of engagement, in one place.
 *
 * The rule Seb applies by hand: look at an account today and count how many
 * outreach sequences anyone at Valstone started against it in the last 60
 * days. Fewer than two means it can be contacted now. Two or more means wait
 * until the second most recent one is 60 days old (two sent 50 days ago means
 * wait 10 more days). A sequence start is an E1-type task (E1, RCE1, D-E1 and
 * friends); E2 to E5 are part of the same sequence and do not count again.
 *
 * Everything here is pure so it can be unit tested and reused by the Outreach
 * review screen, the "check a list" box, and Weekly Outreach warnings.
 */

/** Subject types that start a sequence. From the GOGOGO report filter. */
export const SEQUENCE_START_TYPES = ["E1", "RCE1", "D-E1", "D-RCE1", "IB-E1", "IB-RCE", "Fund-E1", "Fund-RCE1", "LI"] as const;

/** Steps of a running E-sequence, used to spot a sequence still in flight. */
export const SEQUENCE_STEP_TYPES = ["E2", "E3", "E4", "E5"] as const;

export type OutreachSend = {
  /** YYYY-MM-DD of the send (ActivityDate, or CompletedDateTime's date). */
  date: string;
  type: string;
  by: string | null;
};

export type RuleSettings = {
  /** Rolling window in days. Default 60. */
  windowDays: number;
  /** Sends allowed inside the window before the account is off limits. Default 2. */
  maxSendsInWindow: number;
  /** An E1 younger than this with no E5 yet means the sequence is still running. Default 35. */
  inFlightDays: number;
};

export const DEFAULT_RULE_SETTINGS: RuleSettings = { windowDays: 60, maxSendsInWindow: 2, inFlightDays: 35 };

export type RuleStatus = "eligible" | "wait" | "blocked";

export type RuleVerdict = {
  status: RuleStatus;
  /** Plain words for the card: "2 sends in the last 60 days, next window opens Nov 3". */
  reason: string;
  /** YYYY-MM-DD when a "wait" account becomes eligible. */
  eligibleOn: string | null;
  sendsInWindow: number;
  /** Sends in the window, newest first. */
  recent: OutreachSend[];
};

export type RuleInput = {
  /** Every sequence-start send on the account, any user, any order. */
  sends: OutreachSend[];
  /** Dates (YYYY-MM-DD) of completed E2-E5 steps, for the in-flight check. */
  stepDates?: string[];
  /** The account has an open RCE task: that flow owns the next touch. */
  hasOpenRce?: boolean;
  /** Account.Responded is Yes with a positive response type: they are talking to us. */
  respondedPositive?: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(dateKey: string, days: number): string {
  return toDateKey(new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * DAY_MS));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function formatDateShort(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function isSequenceStart(type: string | null | undefined): boolean {
  return !!type && (SEQUENCE_START_TYPES as readonly string[]).includes(type);
}

/**
 * Apply the rule as of `today` (YYYY-MM-DD).
 *
 * Order matters: a hard block (open RCE task, positive reply) wins over the
 * count, and the count wins over the in-flight check, so the reason shown is
 * always the one that actually stops the send.
 */
export function evaluateRule(input: RuleInput, today: string, settings: RuleSettings = DEFAULT_RULE_SETTINGS): RuleVerdict {
  const sends = [...input.sends]
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date) && s.date <= today)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const windowStart = addDays(today, -settings.windowDays);
  const recent = sends.filter((s) => s.date > windowStart);
  const base = { sendsInWindow: recent.length, recent };

  if (input.respondedPositive) {
    return { ...base, status: "blocked", reason: "Replied positively; handled from Inbox and tasks, not cold outreach.", eligibleOn: null };
  }
  if (input.hasOpenRce) {
    return { ...base, status: "blocked", reason: "Has an open RCE task; that follow-up owns the next touch.", eligibleOn: null };
  }

  if (recent.length >= settings.maxSendsInWindow) {
    // The window reopens the day after the Nth most recent send turns windowDays old.
    const anchor = recent[settings.maxSendsInWindow - 1];
    const eligibleOn = addDays(anchor.date, settings.windowDays + 1);
    const wait = Math.max(1, daysBetween(today, eligibleOn));
    return {
      ...base,
      status: "wait",
      reason: `${recent.length} send${recent.length === 1 ? "" : "s"} in the last ${settings.windowDays} days. Window reopens ${formatDateShort(eligibleOn)} (${wait} day${wait === 1 ? "" : "s"}).`,
      eligibleOn,
    };
  }

  // A sequence that started recently and has not reached E5 is still going out.
  const lastStart = sends[0] ?? null;
  if (lastStart && daysBetween(lastStart.date, today) < settings.inFlightDays) {
    // Four completed steps (E2 to E5) on or after the start means the sequence ended.
    const stepsAfter = (input.stepDates ?? []).filter((d) => d >= lastStart.date).length;
    if (stepsAfter < 4) {
      const eligibleOn = addDays(lastStart.date, settings.inFlightDays);
      return {
        ...base,
        status: "wait",
        reason: `Sequence started ${formatDateShort(lastStart.date)} is still running. Check again ${formatDateShort(eligibleOn)}.`,
        eligibleOn,
      };
    }
  }

  const last = sends[0];
  const reason = !last
    ? "Never contacted."
    : recent.length === 0
      ? `Last send ${formatDateShort(last.date)}${last.by ? ` by ${last.by}` : ""}, ${daysBetween(last.date, today)} days ago. Nothing in the last ${settings.windowDays} days.`
      : `${recent.length} send in the last ${settings.windowDays} days (${formatDateShort(last.date)}${last.by ? ` by ${last.by}` : ""}). One more is allowed.`;
  return { ...base, status: "eligible", reason, eligibleOn: null };
}

export function coerceRuleSettings(raw: unknown): RuleSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, def: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : def;
  return {
    windowDays: num(o.windowDays, DEFAULT_RULE_SETTINGS.windowDays, 7, 365),
    maxSendsInWindow: num(o.maxSendsInWindow, DEFAULT_RULE_SETTINGS.maxSendsInWindow, 1, 10),
    inFlightDays: num(o.inFlightDays, DEFAULT_RULE_SETTINGS.inFlightDays, 0, 120),
  };
}
