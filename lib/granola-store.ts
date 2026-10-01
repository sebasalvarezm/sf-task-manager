// Supabase storage for Granola notes matched to Call Logger meetings.
// See supabase/2026-10-granola.sql. Server-only.

import { getSupabaseAdmin } from "./supabase";

export type StoredGranolaNote = {
  granola_note_id: string;
  event_id: string;
  meeting_date: string;
  meeting_start: string | null;
  title: string | null;
  summary: string;
  web_url: string | null;
  matched_by: string;
  note_updated_at: string | null;
  synced_at: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Plain message when the SQL hasn't been run yet, instead of a Postgres code. */
export function granolaTableError(message: string): Error {
  if (/granola_\w+|relation .* does not exist|schema cache/i.test(message)) {
    return new Error(
      "Granola tables are missing. Run supabase/2026-10-granola.sql once in the Supabase SQL Editor.",
    );
  }
  return new Error(message);
}

export async function getGranolaNotesForRange(start: string, end: string): Promise<StoredGranolaNote[]> {
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) throw new Error("Invalid date range");
  const { data, error } = await getSupabaseAdmin()
    .from("granola_notes")
    .select("*")
    .gte("meeting_date", start)
    .lte("meeting_date", end);
  if (error) throw granolaTableError(error.message);
  return (data ?? []) as StoredGranolaNote[];
}

export async function getStoredGranolaNote(noteId: string): Promise<StoredGranolaNote | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("granola_notes")
    .select("*")
    .eq("granola_note_id", noteId)
    .maybeSingle();
  if (error) throw granolaTableError(error.message);
  return (data as StoredGranolaNote | null) ?? null;
}

export async function getStoredGranolaNoteForEvent(eventId: string): Promise<StoredGranolaNote | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("granola_notes")
    .select("*")
    .eq("event_id", eventId)
    .maybeSingle();
  if (error) throw granolaTableError(error.message);
  return (data as StoredGranolaNote | null) ?? null;
}
