import { getSupabaseAdmin } from "./supabase";

/**
 * Cache for archived-page downloads.
 *
 * An archived page at a fixed Wayback timestamp never changes, so a successful
 * download — and a permanent verdict such as "parked page" — is true forever.
 * Caching them is what makes Archive.org's playback rate limit survivable: a
 * retry after a 429 only needs the snapshots it has not already stored.
 *
 * Transport failures (429, timeouts, network errors) are deliberately never
 * cached, because those are temporary and must be retried.
 *
 * Every call is fail-safe. The cache is an optimisation, so a missing table or
 * an unreachable database degrades sourcing to its previous behaviour rather
 * than breaking a run.
 */

export type CachedSnapshot = {
  text: string | null;
  skipReason: string | null;
  /** Always a permanent verdict here, never a transport failure. */
  failureType: string | null;
};

export async function getCachedSnapshot(
  archiveUrl: string,
): Promise<CachedSnapshot | null> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("wayback_snapshots")
      .select("snapshot_text,skip_reason,failure_type")
      .eq("archive_url", archiveUrl)
      .maybeSingle();
    if (error || !data) return null;
    return {
      text: data.snapshot_text ?? null,
      skipReason: data.skip_reason ?? null,
      failureType: data.failure_type ?? null,
    };
  } catch {
    return null;
  }
}

export async function putCachedSnapshot(
  archiveUrl: string,
  snapshot: CachedSnapshot,
): Promise<void> {
  try {
    await getSupabaseAdmin()
      .from("wayback_snapshots")
      .upsert(
        {
          archive_url: archiveUrl,
          snapshot_text: snapshot.text,
          skip_reason: snapshot.skipReason,
          failure_type: snapshot.failureType,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "archive_url" },
      );
  } catch {
    // Storing is best effort; the caller already has what it needs.
  }
}
