// Writes (and stores) the suggestion for one Call Logger row.
//
// Privacy: the transcript is read from Granola here and sent only to the AI
// call below. It is not stored or logged.

import { getAnthropicClient, MODELS } from "./anthropic";
import { trackedCreate } from "./model-cost";
import { fetchCorrectionExamples } from "./call-corrections";
import { fetchCallHistory, type PastCall } from "./call-history";
import { buildSuggestionPrompt, parseSuggestion, selectExamples, type SuggestionInput } from "./call-suggest";
import { getSuggestionForEvent, saveSuggestion, type StoredCallSuggestion } from "./call-suggestion-store";
import { getGranolaTranscript, transcriptToText } from "./granola";
import { getStoredGranolaNoteForEvent } from "./granola-store";

export const SUGGESTION_MODEL = MODELS.drafting;


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
    // Your edits to earlier suggestions come first among the examples.
    fetchCorrectionExamples().catch(() => [] as PastCall[]),
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

  // The model sometimes answers with no text at all, or with a sentence
  // instead of the JSON. One retry with the format spelled out again; if that
  // also fails, the error says what came back so it is not a mystery.
  const ask = async (reminder: string) => {
    const message = await trackedCreate(client, "call_logger", {
      model: SUGGESTION_MODEL,
      max_tokens: 800,
      messages: [{ role: "user", content: reminder ? `${prompt}\n\n${reminder}` : prompt }],
    });
    const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    return { text, stop: message.stop_reason, blocks: message.content.map((b) => b.type).join(",") || "none" };
  };
  let reply: { text: string; stop: string | null; blocks: string };
  try {
    reply = await ask("");
    if (!/\{[\s\S]*\}/.test(reply.text)) {
      console.warn(`[call-suggest] no JSON on first try (stop=${reply.stop}, blocks=${reply.blocks}): ${reply.text.slice(0, 200).replace(/\s+/g, " ")}`);
      reply = await ask("Reply with ONLY the JSON object described above. No words before or after it.");
    }
  } catch (err) {
    console.error("call suggestion AI error:", err instanceof Error ? err.message : err);
    throw new Error("The AI suggestion service is busy. Try again in a minute, or fill the fields in yourself.");
  }
  if (!/\{[\s\S]*\}/.test(reply.text)) {
    const sample = reply.text.trim().replace(/\s+/g, " ").slice(0, 120);
    throw new Error(sample ? `The AI reply had no JSON. It said: "${sample}"` : `The AI returned no text (stop: ${reply.stop ?? "?"}, blocks: ${reply.blocks}).`);
  }

  const suggestion = parseSuggestion(reply.text, input);
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
