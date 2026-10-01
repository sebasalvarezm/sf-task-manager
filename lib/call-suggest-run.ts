// Writes (and stores) the suggestion for one Call Logger row.
//
// Privacy: the transcript is read from Granola here and sent only to the AI
// call below. It is not stored or logged.

import { getAnthropicClient } from "./anthropic";
import { fetchCallHistory, type PastCall } from "./call-history";
import { buildSuggestionPrompt, parseSuggestion, selectExamples, type SuggestionInput } from "./call-suggest";
import { getSuggestionForEvent, saveSuggestion, type StoredCallSuggestion } from "./call-suggestion-store";
import { getGranolaTranscript, transcriptToText } from "./granola";
import { getStoredGranolaNoteForEvent } from "./granola-store";

export const SUGGESTION_MODEL = "claude-sonnet-4-6";

/** Corrections you made to earlier suggestions (item 5). Empty until then. */
export type CorrectionSource = () => Promise<PastCall[]>;
let correctionSource: CorrectionSource = async () => [];
export function setCorrectionSource(source: CorrectionSource) {
  correctionSource = source;
}

export type SuggestRequest = {
  eventId: string;
  meetingTitle: string;
  meetingDate: string;
  accountId: string | null;
  accountName: string | null;
  /** Hand-pasted notes, used only when the row has no Granola note. */
  pastedNotes?: string;
  /** Write a new one even if a current one is stored. */
  force?: boolean;
};

export async function suggestForRow(req: SuggestRequest): Promise<StoredCallSuggestion | null> {
  const client = getAnthropicClient();
  if (!client) throw new Error("The AI service isn't configured (ANTHROPIC_API_KEY).");

  const granola = await getStoredGranolaNoteForEvent(req.eventId);
  if (!granola && !req.pastedNotes?.trim()) return null;

  if (granola && !req.force) {
    const existing = await getSuggestionForEvent(req.eventId);
    if (existing && existing.granolaNoteId === granola.granola_note_id && existing.noteUpdatedAt === granola.note_updated_at) {
      return existing;
    }
  }

  let transcript = "";
  if (granola) {
    try {
      transcript = transcriptToText(await getGranolaTranscript(granola.granola_note_id));
    } catch {
      transcript = ""; // the summary alone still gives a useful suggestion
    }
  }

  const [history, corrections] = await Promise.all([
    fetchCallHistory(),
    correctionSource().catch(() => [] as PastCall[]),
  ]);
  const summary = granola ? granola.summary : req.pastedNotes!.trim();
  const input: SuggestionInput = {
    meetingTitle: req.meetingTitle,
    meetingDate: req.meetingDate,
    accountName: req.accountName,
    accountHistory: req.accountId ? history.filter((c) => c.accountId === req.accountId) : [],
    summary,
    transcript,
  };
  const examples = selectExamples(history, corrections, `${req.meetingTitle}\n${summary}`, 20);
  const prompt = buildSuggestionPrompt(input, examples);

  let text: string;
  try {
    const message = await client.messages.create({
      model: SUGGESTION_MODEL,
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  } catch (err) {
    console.error("call suggestion AI error:", err instanceof Error ? err.message : err);
    throw new Error("The AI suggestion service is busy. Try again in a minute, or fill the fields in yourself.");
  }

  const suggestion = parseSuggestion(text, input);
  const stored = {
    ...suggestion,
    eventId: req.eventId,
    granolaNoteId: granola?.granola_note_id ?? null,
    noteUpdatedAt: granola?.note_updated_at ?? null,
    meetingDate: req.meetingDate,
  };
  await saveSuggestion(stored);
  return { ...stored, createdAt: new Date().toISOString() };
}
