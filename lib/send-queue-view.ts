/**
 * How the send queue page groups and describes rows. Pure functions, no
 * network: the page and its tests share them. Nothing here changes what is
 * sent or when; it only decides which stage a row shows under and the plain
 * words on it.
 */

export type ViewStatus = "pending" | "review" | "ready" | "approved" | "scheduling" | "dry_run" | "scheduled" | "sent" | "failed" | "rejected";
export type Stage = "review" | "ready" | "scheduled" | "sent" | "rejected";
export type Tone = "neutral" | "ok" | "warn" | "danger";

export type ViewRow = {
  status: ViewStatus;
  status_reason: string | null;
  scheduled_for: string | null;
  time_zone: string | null;
  approved_at?: string | null;
  updated_at?: string | null;
  outreach_mailing_id?: string | null;
};

export const STAGES: Array<{ key: Exclude<Stage, "rejected">; label: string; short: string }> = [
  { key: "review", label: "To review", short: "Review" },
  { key: "ready", label: "Ready to send", short: "Ready" },
  { key: "scheduled", label: "Scheduled", short: "Scheduled" },
  { key: "sent", label: "Sent", short: "Sent" },
];

/**
 * The stage a row sits in. A scheduled email whose send time has passed is
 * shown as sent (Outreach sends it at that time). Rows the page has just
 * handed to Outreach (`sending`) show as scheduled straight away.
 */
export function stageOf(row: ViewRow, now: number, sending = false): Stage {
  switch (row.status) {
    case "pending":
    case "review":
    case "ready":
      return "review";
    case "approved":
      return sending ? "scheduled" : "ready";
    case "failed":
      return "ready";
    case "scheduling":
    case "dry_run":
      return "scheduled";
    case "scheduled":
      return row.scheduled_for && row.outreach_mailing_id && new Date(row.scheduled_for).getTime() <= now ? "sent" : "scheduled";
    case "sent":
      return "sent";
    case "rejected":
      return "rejected";
  }
}

/** "just now", "2 min ago", "3 h ago", "2 days ago". */
export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** "Tue 7:12 AM recipient time (EDT)", in the recipient's own zone. */
export function slot(iso: string | null, tz: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  try {
    const opts: Intl.DateTimeFormatOptions = { timeZone: tz ?? undefined, weekday: "short", hour: "numeric", minute: "2-digit" };
    const when = new Intl.DateTimeFormat("en-US", opts).format(d);
    const zone = new Intl.DateTimeFormat("en-US", { timeZone: tz ?? undefined, timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value;
    return `${when}${tz ? " recipient time" : ""}${zone ? ` (${zone})` : ""}`;
  } catch {
    return d.toLocaleString();
  }
}

/**
 * One plain line for a failure. Outreach and Salesforce errors arrive as
 * "Outreach refused the mailing: {json…}"; the JSON's own detail or title is
 * the useful part, and it is never shown raw.
 */
export function plainError(reason: string | null | undefined): string {
  const text = (reason ?? "").trim();
  if (!text) return "Something went wrong sending this one.";
  const brace = text.search(/[{[]/);
  if (brace === -1) return oneLine(text);
  const lead = text.slice(0, brace).replace(/[:\s]+$/, "").trim();
  const raw = text.slice(brace);
  let detail: string | null = null;
  try {
    detail = pickMessage(JSON.parse(raw));
  } catch {
    const m = raw.match(/"(?:detail|message|title|error_description|error)"\s*:\s*"([^"]+)"/);
    detail = m ? m[1] : null;
  }
  const head = lead.replace(/^Outreach refused the mailing$/i, "Outreach refused it").replace(/^Outreach would not schedule the mailing$/i, "Outreach would not schedule it");
  const parts = [head || "Outreach returned an error", detail ? lowerFirst(detail) : null].filter(Boolean);
  return oneLine(parts.join(": "));
}

function pickMessage(v: unknown): string | null {
  if (!v || typeof v !== "object") return typeof v === "string" ? v : null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const m = pickMessage(x);
      if (m) return m;
    }
    return null;
  }
  const o = v as Record<string, unknown>;
  for (const k of ["detail", "message", "error_description", "title"]) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  for (const k of ["errors", "error", "data"]) {
    const m = pickMessage(o[k]);
    if (m) return m;
  }
  return null;
}

function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  const end = /[.!?]$/.test(flat) ? flat : `${flat}.`;
  return end.length > 180 ? `${end.slice(0, 177).trimEnd()}…` : end;
}

/** The status line on a card, in plain words, with the colour it carries. */
export function statusLine(row: ViewRow, opts: { now: number; sending?: boolean; manualSend?: boolean }): { text: string; tone: Tone } {
  const stage = stageOf(row, opts.now, opts.sending);
  if (row.status === "failed") return { text: plainError(row.status_reason), tone: "danger" };
  if (row.status === "approved" && !opts.sending) return { text: `Approved ${ago(row.approved_at ?? row.updated_at, opts.now)} · not sent`.replace("Approved  ·", "Approved ·"), tone: "neutral" };
  if (row.status === "scheduling" || (row.status === "approved" && opts.sending)) return { text: "Sending to Outreach…", tone: "neutral" };
  if (row.status === "dry_run") return { text: `Dry run: draft in Outreach for ${slot(row.scheduled_for, row.time_zone)}, won't send`, tone: "warn" };
  if (row.status === "scheduled" && stage === "scheduled") {
    if (!row.scheduled_for) return { text: opts.manualSend ? "In the sequence, send it from Outreach" : "Scheduled", tone: "neutral" };
    return { text: `Scheduled for ${slot(row.scheduled_for, row.time_zone)}`, tone: "neutral" };
  }
  if (stage === "sent") return { text: row.scheduled_for ? `Sent ${slot(row.scheduled_for, row.time_zone)}` : "Sent", tone: "ok" };
  if (row.status === "rejected") return { text: row.status_reason ? `Rejected · ${oneLine(row.status_reason).replace(/\.$/, "")}` : "Rejected", tone: "neutral" };
  return { text: "", tone: "neutral" };
}

/** Newest first: approval time for approved rows, then the scheduled time, then last change. */
export function newestFirst<T extends ViewRow>(rows: T[]): T[] {
  const key = (r: T) => new Date(r.approved_at ?? r.updated_at ?? 0).getTime() || 0;
  return [...rows].sort((a, b) => key(b) - key(a));
}
