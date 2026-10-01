// Supabase storage for suggested Call Logger fields. Server-only.

import { getSupabaseAdmin } from "./supabase";
import { granolaTableError } from "./granola-store";
import type { CallSuggestion } from "./call-suggest";

export type StoredCallSuggestion = CallSuggestion & {
  eventId: string;
  granolaNoteId: string | null;
  noteUpdatedAt: string | null;
  meetingDate: string;
  createdAt: string;
};

type Row = {
  event_id: string;
  granola_note_id: string | null;
  note_updated_at: string | null;
  meeting_date: string;
  commentary: string | null;
  call_type: string | null;
  type_reason: string | null;
  follow_up_days: number | null;
  follow_up_reason: string | null;
  created_at: string;
};

function fromRow(r: Row): StoredCallSuggestion {
  return {
    eventId: r.event_id,
    granolaNoteId: r.granola_note_id,
    noteUpdatedAt: r.note_updated_at,
    meetingDate: r.meeting_date,
    commentary: r.commentary,
    callType: r.call_type === "C1" || r.call_type === "RCC" ? r.call_type : null,
    typeReason: r.type_reason,
    followUpDays: r.follow_up_days,
    followUpReason: r.follow_up_reason,
    createdAt: r.created_at,
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function getSuggestionsForRange(start: string, end: string): Promise<StoredCallSuggestion[]> {
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) throw new Error("Invalid date range");
  const { data, error } = await getSupabaseAdmin()
    .from("call_suggestions")
    .select("*")
    .gte("meeting_date", start)
    .lte("meeting_date", end);
  if (error) throw granolaTableError(error.message);
  return ((data ?? []) as Row[]).map(fromRow);
}

export async function getSuggestionForEvent(eventId: string): Promise<StoredCallSuggestion | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("call_suggestions")
    .select("*")
    .eq("event_id", eventId)
    .maybeSingle();
  if (error) throw granolaTableError(error.message);
  return data ? fromRow(data as Row) : null;
}

export async function saveSuggestion(s: Omit<StoredCallSuggestion, "createdAt">): Promise<void> {
  const { error } = await getSupabaseAdmin().from("call_suggestions").upsert(
    {
      event_id: s.eventId,
      granola_note_id: s.granolaNoteId,
      note_updated_at: s.noteUpdatedAt,
      meeting_date: s.meetingDate,
      commentary: s.commentary,
      call_type: s.callType,
      type_reason: s.typeReason,
      follow_up_days: s.followUpDays,
      follow_up_reason: s.followUpReason,
      created_at: new Date().toISOString(),
    },
    { onConflict: "event_id" },
  );
  if (error) throw granolaTableError(error.message);
}
