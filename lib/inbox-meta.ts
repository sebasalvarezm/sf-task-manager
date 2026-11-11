import { getSupabaseAdmin } from "./supabase";
import type { AutoReply, ReplyType } from "./inbox-classify";

/**
 * Per-reply extras the inbox_replies table has no columns for (reply type,
 * out of office, left the company), kept in app_settings so no database change
 * is needed. Keyed by Outlook message id; only the newest 400 are kept.
 */
export type InboxMeta = {
  replyType: ReplyType;
  autoReply: AutoReply;
  returnDate: string | null;
  newContact: string | null;
  at: string;
};

const KEY = "inbox_meta";
const KEEP = 400;

async function read(): Promise<{ map: Record<string, InboxMeta>; updatedAt: string | null }> {
  const { data, error } = await getSupabaseAdmin().from("app_settings").select("value, updated_at").eq("key", KEY).maybeSingle();
  if (error) throw new Error(`Could not read inbox extras: ${error.message}`);
  const value = (data?.value as { items?: Record<string, InboxMeta> } | undefined)?.items;
  return { map: value && typeof value === "object" ? value : {}, updatedAt: (data?.updated_at as string | undefined) ?? null };
}

export async function readInboxMeta(): Promise<Record<string, InboxMeta>> {
  return (await read()).map;
}

/** Merge entries in. Read, change, write back only if nobody wrote in between (else redo). */
export async function saveInboxMeta(entries: Record<string, Omit<InboxMeta, "at">>): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 6; attempt++) {
    const { map, updatedAt } = await read();
    const next: Record<string, InboxMeta> = { ...map };
    for (const [id, e] of Object.entries(entries)) next[id] = { ...e, at: now };
    const kept = Object.fromEntries(Object.entries(next).sort((a, b) => (a[1].at < b[1].at ? 1 : -1)).slice(0, KEEP));
    if (updatedAt === null) {
      const { error } = await supabase.from("app_settings").insert({ key: KEY, value: { items: kept } });
      if (!error) return;
      continue;
    }
    const { data, error } = await supabase
      .from("app_settings")
      .update({ value: { items: kept }, updated_at: now })
      .eq("key", KEY)
      .eq("updated_at", updatedAt)
      .select("key");
    if (error) throw new Error(`Could not save inbox extras: ${error.message}`);
    if (data && data.length === 1) return;
    await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
  }
  throw new Error("Could not save inbox extras: the list kept changing.");
}
