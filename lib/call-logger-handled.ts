import { getSupabaseAdmin } from "./supabase";

/**
 * The Call Logger's memory (Nov 2026): meetings Seb dismissed or logged stay
 * hidden when he comes back to the same week (Wednesday, then Friday), on any
 * device. Kept in app_settings, keyed by the Outlook event id. Old entries are
 * dropped after 120 days. A hidden meeting can be brought back.
 */

const KEY = "call_logger_handled";
const KEEP_DAYS = 120;

export type HandledStatus = "dismissed" | "logged";
export type HandledEntry = { status: HandledStatus; at: string; week: string };
export type HandledMap = Record<string, HandledEntry>;

/** Entries for one week (by its start date), newest decision per event. Pure. */
export function forWeek(all: HandledMap, weekStart: string): HandledMap {
  return Object.fromEntries(Object.entries(all).filter(([, e]) => e.week === weekStart));
}

/** Apply a change and drop entries older than the keep window. Pure. */
export function applyHandled(all: HandledMap, change: { set?: { ids: string[]; status: HandledStatus; week: string }; remove?: string[] }, now = new Date()): HandledMap {
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString();
  const next: HandledMap = {};
  for (const [id, e] of Object.entries(all)) if (e.at >= cutoff) next[id] = e;
  for (const id of change.remove ?? []) delete next[id];
  if (change.set) {
    for (const id of change.set.ids) {
      // A logged call stays "logged" even if it is dismissed afterwards.
      if (next[id]?.status === "logged" && change.set.status === "dismissed") continue;
      next[id] = { status: change.set.status, at: now.toISOString(), week: change.set.week };
    }
  }
  return next;
}

async function read(): Promise<{ value: HandledMap; updatedAt: string | null }> {
  const { data, error } = await getSupabaseAdmin().from("app_settings").select("value, updated_at").eq("key", KEY).maybeSingle();
  if (error) throw new Error(error.message);
  return { value: (data?.value as HandledMap | undefined) ?? {}, updatedAt: (data?.updated_at as string | undefined) ?? null };
}

export async function loadHandled(weekStart: string): Promise<HandledMap> {
  return forWeek((await read()).value, weekStart);
}

/** Save a change with a version check, so two tabs never undo each other. */
export async function changeHandled(change: Parameters<typeof applyHandled>[1]): Promise<void> {
  const supabase = getSupabaseAdmin();
  for (let attempt = 0; attempt < 6; attempt++) {
    const { value, updatedAt } = await read();
    const next = applyHandled(value, change);
    if (updatedAt === null) {
      const { error } = await supabase.from("app_settings").insert({ key: KEY, value: next });
      if (!error) return;
      continue;
    }
    const { data, error } = await supabase.from("app_settings").update({ value: next, updated_at: new Date().toISOString() }).eq("key", KEY).eq("updated_at", updatedAt).select("key");
    if (error) throw new Error(error.message);
    if (data && data.length === 1) return;
    await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
  }
  throw new Error("Could not save: the list kept changing. Try again.");
}
