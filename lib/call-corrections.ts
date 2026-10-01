// Your edits to suggestions, saved when you log (item 5). Server-only.

import type { PastCall } from "./call-history";
import { getSupabaseAdmin } from "./supabase";
import { granolaTableError } from "./granola-store";

export type CorrectionInput = {
  eventId: string;
  granolaNoteId?: string | null;
  accountName?: string | null;
  meetingDate?: string | null;
  suggested: { commentary: string | null; callType: string | null; followUpDays: number | null };
  final: { commentary: string; callType: string; followUpDays: number | null };
};

type Field = "commentary" | "callType" | "followUp";

/** Which suggested fields you changed. A field with no suggestion can't be "corrected". Pure. */
export function changedFields(c: CorrectionInput): Field[] {
  const out: Field[] = [];
  const norm = (v: string | null | undefined) => (v ?? "").trim();
  if (c.suggested.commentary && norm(c.final.commentary) !== norm(c.suggested.commentary)) out.push("commentary");
  if (c.suggested.callType && c.final.callType !== c.suggested.callType) out.push("callType");
  if (c.suggested.followUpDays && (c.final.followUpDays ?? null) !== c.suggested.followUpDays) out.push("followUp");
  return out;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function saveCorrections(inputs: CorrectionInput[]): Promise<number> {
  const rows = inputs
    .map((c) => ({ c, fields: changedFields(c) }))
    .filter(({ fields }) => fields.length > 0)
    .map(({ c, fields }) => ({
      event_id: c.eventId,
      granola_note_id: c.granolaNoteId ?? null,
      account_name: c.accountName ?? null,
      meeting_date: c.meetingDate && ISO_DATE.test(c.meetingDate) ? c.meetingDate : null,
      suggested_commentary: c.suggested.commentary,
      final_commentary: c.final.commentary.trim() || null,
      suggested_call_type: c.suggested.callType,
      final_call_type: c.final.callType || null,
      suggested_follow_up_days: c.suggested.followUpDays,
      final_follow_up_days: c.final.followUpDays,
      changed_fields: fields,
      created_at: new Date().toISOString(),
    }));
  if (rows.length === 0) return 0;
  const { error } = await getSupabaseAdmin()
    .from("call_suggestion_corrections")
    .upsert(rows, { onConflict: "event_id" });
  if (error) throw granolaTableError(error.message);
  return rows.length;
}

type Row = {
  final_commentary: string | null;
  final_call_type: string | null;
  final_follow_up_days: number | null;
  suggested_commentary: string | null;
  account_name: string | null;
  meeting_date: string | null;
};

/** Your corrected versions, newest first, as examples for the next suggestions. */
export async function fetchCorrectionExamples(limit = 30): Promise<PastCall[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("call_suggestion_corrections")
    .select("final_commentary, final_call_type, final_follow_up_days, suggested_commentary, account_name, meeting_date")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw granolaTableError(error.message);
  return ((data ?? []) as Row[])
    .filter((r) => r.final_commentary?.trim())
    .map((r) => ({
      source: "correction" as const,
      accountId: null,
      accountName: r.account_name ?? "",
      callType: r.final_call_type === "RCC" ? ("RCC" as const) : ("C1" as const),
      commentary: r.final_commentary!.trim(),
      followUpDays: r.final_follow_up_days,
      meetingDate: r.meeting_date,
      suggestedCommentary: r.suggested_commentary,
    }));
}
