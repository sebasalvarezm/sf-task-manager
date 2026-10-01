// Granola public API client (https://docs.granola.ai, API v1).
//
// - Base URL https://public-api.granola.ai/v1, Bearer token in GRANOLA_API_KEY.
// - Granola only returns notes that have finished processing (an AI summary
//   and a transcript exist). A call that just ended shows up a few minutes
//   later, so a later sync picks it up.
// - Rate limit: 25 requests per 5 seconds burst, 5 per second sustained.
//   A 429 is retried with backoff (Retry-After is honoured if Granola sends
//   one; the docs don't promise it).
// - List Notes has no meeting-time filter, only created/updated dates, and
//   returns no times or attendees. So the week is listed by created date and
//   each note is fetched for its calendar event, attendees and summary.
//
// Server-only: never import this from a "use client" file.

export const GRANOLA_BASE_URL = "https://public-api.granola.ai/v1";

export class GranolaError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: "NOT_CONFIGURED" | "UNAUTHORIZED" | "RATE_LIMITED" | "UPSTREAM" | "NETWORK",
  ) {
    super(message);
    this.name = "GranolaError";
  }
}

export type GranolaUser = { name: string | null; email: string };

export type GranolaNoteSummary = {
  id: string;
  object: "note";
  title: string | null;
  owner: GranolaUser;
  created_at: string;
  updated_at: string;
};

export type GranolaCalendarEvent = {
  event_title: string | null;
  invitees: Array<{ email: string }>;
  organiser: string | null;
  calendar_event_id: string | null;
  scheduled_start_time: string | null;
  scheduled_end_time: string | null;
};

export type GranolaTranscriptItem = {
  speaker: {
    source: "microphone" | "speaker";
    attribution?: "me" | "them";
    diarization_label?: string;
    name?: string;
  };
  text: string;
  start_time: string;
  end_time: string;
};

export type GranolaNote = GranolaNoteSummary & {
  web_url: string;
  calendar_event: GranolaCalendarEvent | null;
  attendees: GranolaUser[];
  summary_text: string;
  summary_markdown: string | null;
  private_notes_text?: string | null;
  private_notes_markdown?: string | null;
  transcript?: GranolaTranscriptItem[] | null;
};

const NOTE_ID = /^not_[a-zA-Z0-9]{14}$/;
export function isGranolaNoteId(value: unknown): value is string {
  return typeof value === "string" && NOTE_ID.test(value);
}

export function isGranolaConfigured(): boolean {
  return Boolean(process.env.GRANOLA_API_KEY?.trim());
}

type FetchOptions = {
  /** For tests: replaces the real wait between retries. */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait before retry `attempt` (1-based). Retry-After wins when present. */
export function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, Math.min(30_000, date - Date.now()));
  }
  // 1s, 2s, 4s, 8s... (the burst window is 5s, so this clears it quickly).
  return Math.min(16_000, 1000 * 2 ** (attempt - 1));
}

async function granolaGet<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  options: FetchOptions = {},
): Promise<T> {
  const key = process.env.GRANOLA_API_KEY?.trim();
  if (!key) {
    throw new GranolaError(
      "Granola isn't set up yet: add GRANOLA_API_KEY in Vercel (and .env.local).",
      null,
      "NOT_CONFIGURED",
    );
  }
  const url = new URL(`${GRANOLA_BASE_URL}${path}`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  }
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? 5;

  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        cache: "no-store",
      });
    } catch {
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs(attempt, null));
        continue;
      }
      throw new GranolaError("Couldn't reach Granola. Try again in a minute.", null, "NETWORK");
    }

    if (response.ok) return (await response.json()) as T;

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < maxAttempts) {
      await sleep(retryDelayMs(attempt, response.headers.get("retry-after")));
      continue;
    }
    if (response.status === 401) {
      throw new GranolaError(
        "Granola rejected the API key. Check GRANOLA_API_KEY (Granola → Settings → Connectors → API keys).",
        401,
        "UNAUTHORIZED",
      );
    }
    if (response.status === 429) {
      throw new GranolaError("Granola is rate-limiting us. Try again in a minute.", 429, "RATE_LIMITED");
    }
    const body = await response.text().catch(() => "");
    let detail = "";
    try {
      const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
      if (typeof parsed.message === "string") detail = parsed.message;
      else if (typeof parsed.error === "string") detail = parsed.error;
    } catch {
      /* not JSON */
    }
    throw new GranolaError(
      `Granola returned an error (${response.status})${detail ? `: ${detail}` : "."}`,
      response.status,
      "UPSTREAM",
    );
  }
}

/** Every processed note created in [createdAfter, createdBefore), all pages. */
export async function listGranolaNotes(
  filter: { createdAfter?: string; createdBefore?: string; updatedAfter?: string },
  options: FetchOptions & { maxPages?: number } = {},
): Promise<GranolaNoteSummary[]> {
  const notes: GranolaNoteSummary[] = [];
  let cursor: string | undefined;
  const maxPages = options.maxPages ?? 20; // 20 x 30 = 600 notes: far more than a week
  for (let page = 0; page < maxPages; page++) {
    const data = await granolaGet<{ notes: GranolaNoteSummary[]; hasMore: boolean; cursor: string | null }>(
      "/notes",
      {
        created_after: filter.createdAfter,
        created_before: filter.createdBefore,
        updated_after: filter.updatedAfter,
        page_size: 30,
        cursor,
      },
      options,
    );
    notes.push(...(data.notes ?? []));
    if (!data.hasMore || !data.cursor) break;
    cursor = data.cursor;
  }
  return notes;
}

/** One note with its summary (no transcript). */
export async function getGranolaNote(noteId: string, options: FetchOptions = {}): Promise<GranolaNote> {
  if (!isGranolaNoteId(noteId)) throw new GranolaError("Invalid Granola note id", 400, "UPSTREAM");
  return granolaGet<GranolaNote>(`/notes/${noteId}`, {}, options);
}

/**
 * The full transcript. Uses the paged transcript endpoint, which works for
 * long calls too (Get Note returns 413 TRANSCRIPT_TOO_LARGE for those).
 */
export async function getGranolaTranscript(
  noteId: string,
  options: FetchOptions & { maxPages?: number } = {},
): Promise<GranolaTranscriptItem[]> {
  if (!isGranolaNoteId(noteId)) throw new GranolaError("Invalid Granola note id", 400, "UPSTREAM");
  const items: GranolaTranscriptItem[] = [];
  let cursor: string | undefined;
  const maxPages = options.maxPages ?? 60; // 60 x 100 lines
  for (let page = 0; page < maxPages; page++) {
    const data = await granolaGet<{ transcript: GranolaTranscriptItem[]; hasMore: boolean; cursor: string | null }>(
      `/notes/${noteId}/transcript`,
      { page_size: 100, cursor },
      options,
    );
    items.push(...(data.transcript ?? []));
    if (!data.hasMore || !data.cursor) break;
    cursor = data.cursor;
  }
  return items;
}

/** "Me: ..." / "Them: ..." lines, for showing and for the suggestion prompt. */
export function transcriptToText(items: GranolaTranscriptItem[]): string {
  return items
    .map((item) => {
      const who =
        item.speaker.name?.trim() ||
        (item.speaker.attribution === "me" || item.speaker.source === "microphone" ? "Me" : "Them");
      return `${who}: ${item.text.trim()}`;
    })
    .filter((line) => line.length > 0)
    .join("\n");
}
