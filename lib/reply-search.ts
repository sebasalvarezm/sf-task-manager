import { getSupabaseAdmin } from "./supabase";
import { getMsValidCredentials, getMailboxIdentities } from "./microsoft";
import { trimReplyBody } from "./inbox-classify";
import { recordModelCall, spentTodayUsd } from "./model-cost";
import { inngest } from "./inngest/client";

/**
 * Reply search (Nov 2026): Seb's sent replies, each with a Voyage "meaning"
 * vector, so an Inbox draft learns from the 8 past replies closest to the
 * email being answered instead of the 8 most recent.
 *
 * Read only: it reads Sent Items and writes to its own table. Hard limits:
 * a daily dollar cap, a per-run message cap, and a pause switch. Anything
 * missing (table not created, no Voyage key, paused, over the cap) falls
 * back to the old "most recent replies" behaviour, never to an error.
 */

export const VOYAGE_MODEL = "voyage-4-lite";
export const DIMENSIONS = 512;
const FEATURE = "reply_search";
const SETTINGS_KEY = "reply_search_settings";
/** Dollars per day across indexing and searching. At $0.02 per million tokens this is ~25M tokens. */
export const DAILY_CAP_USD = 0.5;
/** Sent messages read per indexing run. */
export const MAX_SCAN = 2000;

export type ReplyExample = { to: string; subject: string; body: string };

// ── Settings ────────────────────────────────────────────────────────────────

export type ReplySearchSettings = { paused: boolean };

export async function getReplySearchSettings(): Promise<ReplySearchSettings> {
  const { data } = await getSupabaseAdmin().from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
  return { paused: (data?.value as { paused?: boolean } | undefined)?.paused === true };
}

export async function saveReplySearchSettings(paused: boolean): Promise<ReplySearchSettings> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("app_settings").select("key").eq("key", SETTINGS_KEY).maybeSingle();
  const value = { paused };
  const { error } = data
    ? await supabase.from("app_settings").update({ value, updated_at: new Date().toISOString() }).eq("key", SETTINGS_KEY)
    : await supabase.from("app_settings").insert({ key: SETTINGS_KEY, value });
  if (error) throw new Error(error.message);
  return value;
}

// ── Voyage ──────────────────────────────────────────────────────────────────

/** Vectors for `texts`, in order. Throws VOYAGE_NOT_CONFIGURED, REPLY_SEARCH_CAP or a Voyage error. */
export async function embed(texts: string[], inputType: "document" | "query"): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY?.trim();
  if (!key) throw new Error("VOYAGE_NOT_CONFIGURED");
  if (texts.length === 0) return [];
  if ((await spentTodayUsd([FEATURE]).catch(() => 0)) >= DAILY_CAP_USD) throw new Error("REPLY_SEARCH_CAP");
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: inputType, output_dimension: DIMENSIONS, truncation: true }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const body = (await res.json()) as {
    data?: Array<{ embedding: number[]; index?: number }>;
    embeddings?: number[][];
    usage?: { total_tokens?: number };
    total_tokens?: number;
  };
  const vectors = body.data
    ? [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding)
    : body.embeddings ?? [];
  if (vectors.length !== texts.length || vectors.some((v) => !Array.isArray(v) || v.length !== DIMENSIONS)) {
    throw new Error("Voyage returned an unexpected answer.");
  }
  void recordModelCall(FEATURE, VOYAGE_MODEL, { input_tokens: body.usage?.total_tokens ?? body.total_tokens ?? 0, output_tokens: 0 });
  return vectors;
}

// ── Reading a sent reply ────────────────────────────────────────────────────

/**
 * Split a sent message (plain text) into Seb's reply and the message he was
 * answering (the first quoted one, headers and signature cut). Pure.
 */
export function splitSentMessage(text: string): { mine: string; theirs: string | null } {
  const clean = (text ?? "").replace(/\r/g, "");
  const mine = trimReplyBody(clean);
  const marker = clean.search(/^\s*(?:from|de|von)\s*:.+$|^\s*on .+ wrote:\s*$|^-{3,}\s*original message\s*-{3,}\s*$/im);
  if (marker < 0) return { mine, theirs: null };
  const lines = clean.slice(marker).split("\n");
  // Skip the header block (From/Sent/To/Cc/Subject/Date lines, or the "On ... wrote:" line).
  let i = 0;
  while (i < lines.length && (/^\s*(from|de|von|sent|envoyé|gesendet|to|à|an|cc|subject|objet|betreff|date)\s*:/i.test(lines[i]) || /^\s*on .+ wrote:\s*$/i.test(lines[i]) || /^-{3,}/.test(lines[i].trim()) || !lines[i].trim())) i++;
  const quoted = lines.slice(i).map((l) => l.replace(/^\s*>\s?/, "")).join("\n");
  const theirs = trimReplyBody(quoted);
  return { mine, theirs: theirs.length >= 15 ? theirs.slice(0, 2500) : null };
}

/** What gets stored as the searchable text: their email first (what new emails are matched against), then his reply. */
export function documentText(theirs: string | null, mine: string): string {
  return theirs ? `Their email:\n${theirs.slice(0, 1500)}\n\nSeb's reply:\n${mine}` : `Seb's reply:\n${mine}`;
}

type SentMessage = {
  id: string;
  subject?: string;
  sentDateTime?: string;
  toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  body?: { content?: string };
};

/** Which sent messages are worth learning from: replies to someone outside Valstone, not to the scheduling bot, a real length. */
export function usableSent(m: SentMessage, ownDomains: Set<string>): { mine: string; theirs: string | null } | null {
  if (!/^(re|aw|tr|rif)\s*:/i.test(m.subject ?? "")) return null;
  const to = (m.toRecipients ?? []).map((r) => (r.emailAddress?.address ?? "").toLowerCase()).filter(Boolean);
  if (to.length === 0) return null;
  const external = to.filter((a) => {
    const domain = a.split("@")[1] ?? "";
    return !ownDomains.has(domain) && !domain.endsWith(".onmicrosoft.com") && !/blockit/.test(domain);
  });
  if (external.length === 0) return null;
  const split = splitSentMessage(m.body?.content ?? "");
  if (split.mine.length < 30 || split.mine.length > 1500) return null;
  return split;
}

// ── Indexing ────────────────────────────────────────────────────────────────

export type IndexSummary = { scanned: number; usable: number; added: number; stoppedBy: string | null };

/** Read Sent Items from the last `sinceDays` days and add the replies not stored yet. Capped; never sends anything. */
export async function indexSentReplies(sinceDays: number): Promise<IndexSummary> {
  const summary: IndexSummary = { scanned: 0, usable: 0, added: 0, stoppedBy: null };
  if ((await getReplySearchSettings()).paused) return { ...summary, stoppedBy: "paused" };
  const credentials = await getMsValidCredentials();
  if (!credentials) throw new Error("MS_NOT_CONNECTED");
  const identities = await getMailboxIdentities();
  const ownDomains = new Set(Array.from(identities).map((a) => a.split("@")[1]).filter(Boolean));
  const supabase = getSupabaseAdmin();

  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const params = new URLSearchParams({
    $select: "id,subject,toRecipients,body,sentDateTime",
    $orderby: "sentDateTime desc",
    $filter: `sentDateTime ge ${since}`,
    $top: "50",
  });
  let url: string | null = `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?${params.toString()}`;
  const found: Array<{ m: SentMessage; mine: string; theirs: string | null }> = [];
  while (url && summary.scanned < MAX_SCAN) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${credentials.access_token}`, Prefer: 'outlook.body-content-type="text"' } });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error("OUTLOOK_RECONNECT_REQUIRED");
      throw new Error(`Outlook Sent Items read failed (${res.status})`);
    }
    const page = (await res.json()) as { value?: SentMessage[]; "@odata.nextLink"?: string };
    for (const m of page.value ?? []) {
      summary.scanned++;
      const usable = usableSent(m, ownDomains);
      if (usable) found.push({ m, ...usable });
    }
    url = page["@odata.nextLink"] ?? null;
  }
  if (url) summary.stoppedBy = `message cap (${MAX_SCAN})`;
  summary.usable = found.length;

  // Only the ones not stored yet.
  const known = new Set<string>();
  for (let i = 0; i < found.length; i += 200) {
    const { data, error } = await supabase.from("sent_replies").select("message_id").in("message_id", found.slice(i, i + 200).map((f) => f.m.id));
    if (error) throw new Error(/sent_replies|relation|schema cache/.test(error.message) ? "REPLY_SEARCH_TABLE_MISSING" : error.message);
    for (const r of data ?? []) known.add((r as { message_id: string }).message_id);
  }
  const fresh = found.filter((f) => !known.has(f.m.id));

  for (let i = 0; i < fresh.length; i += 100) {
    const batch = fresh.slice(i, i + 100);
    let vectors: number[][];
    try {
      vectors = await embed(batch.map((f) => documentText(f.theirs, f.mine)), "document");
    } catch (err) {
      summary.stoppedBy = err instanceof Error ? err.message : "Voyage error";
      break;
    }
    const rows = batch.map((f, j) => ({
      message_id: f.m.id,
      sent_at: f.m.sentDateTime ?? new Date().toISOString(),
      to_name: f.m.toRecipients?.[0]?.emailAddress?.name ?? f.m.toRecipients?.[0]?.emailAddress?.address ?? null,
      subject: f.m.subject ?? null,
      body: f.mine,
      theirs: f.theirs,
      embedding: JSON.stringify(vectors[j]),
    }));
    const { error } = await supabase.from("sent_replies").upsert(rows, { onConflict: "message_id" });
    if (error) throw new Error(error.message);
    summary.added += rows.length;
  }
  return summary;
}

export async function countIndexed(): Promise<number | null> {
  const { count, error } = await getSupabaseAdmin().from("sent_replies").select("message_id", { count: "exact", head: true });
  return error ? null : count ?? 0;
}

export async function requestReplyIndex(sinceDays = 365): Promise<void> {
  try {
    await inngest.send({ name: "inbox/reply-index", data: { sinceDays } });
  } catch {
    /* the nightly run catches up */
  }
}

// ── Searching ───────────────────────────────────────────────────────────────

/**
 * Seb's past replies closest in meaning to `theirText`, best first. Null when
 * reply search is off or unavailable for any reason (caller falls back).
 */
export async function similarReplies(theirText: string, count = 8): Promise<ReplyExample[] | null> {
  const text = theirText.trim();
  if (!text) return null;
  try {
    if ((await getReplySearchSettings()).paused) return null;
    const [vector] = await embed([text.slice(0, 4000)], "query");
    const { data, error } = await getSupabaseAdmin().rpc("match_sent_replies", { query_embedding: JSON.stringify(vector), match_count: count });
    if (error || !Array.isArray(data) || data.length === 0) return null;
    return (data as Array<{ to_name: string | null; subject: string | null; body: string }>).map((r) => ({ to: r.to_name ?? "", subject: r.subject ?? "", body: r.body }));
  } catch {
    return null;
  }
}
