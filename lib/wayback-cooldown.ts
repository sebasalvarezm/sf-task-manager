import { getSupabaseAdmin } from "./supabase";

/**
 * Archive.org's "slow down" (429 / 503) is remembered in-process by lib/scout.ts.
 * Bulk sourcing runs each company in its own serverless worker, so three
 * workers used to rediscover the throttle one after another and keep the
 * block alive. This mirrors the cooldown into `app_settings` so every worker
 * sees the same "wait until" and pauses together.
 *
 * Best-effort only: a database hiccup never blocks a scrape.
 */

const KEY = "wayback_playback_cooldown_until";
const READ_CACHE_MS = 3_000;

let cachedUntil = 0;
let cachedAt = 0;

export async function readSharedWaybackCooldown(): Promise<number> {
  const now = Date.now();
  if (now - cachedAt < READ_CACHE_MS) return cachedUntil;
  cachedAt = now;
  try {
    const { data } = await getSupabaseAdmin()
      .from("app_settings")
      .select("value")
      .eq("key", KEY)
      .maybeSingle();
    const until = Number((data?.value as { until?: unknown } | null)?.until ?? 0);
    cachedUntil = Number.isFinite(until) ? until : 0;
  } catch {
    // keep whatever we had
  }
  return cachedUntil;
}

export function writeSharedWaybackCooldown(until: number): void {
  if (until <= cachedUntil) return;
  cachedUntil = until;
  cachedAt = Date.now();
  void getSupabaseAdmin()
    .from("app_settings")
    .upsert(
      { key: KEY, value: { until }, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    )
    .then(() => undefined, () => undefined);
}
