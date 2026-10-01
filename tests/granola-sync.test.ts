import { beforeEach, describe, expect, it, vi } from "vitest";

// ── In-memory stand-in for the two Supabase tables the sync touches ──────────
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = { granola_notes: [], app_settings: [] };

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let mode: "select" | "delete" = "select";
  const api = {
    select: () => api,
    delete: () => ((mode = "delete"), api),
    eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), api),
    neq: (col: string, v: unknown) => (filters.push((r) => r[col] !== v), api),
    in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), api),
    maybeSingle: async () => ({ data: tables[table].filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
    upsert: async (row: Row, opts: { onConflict: string }) => {
      const key = opts.onConflict;
      const i = tables[table].findIndex((r) => r[key] === row[key]);
      if (i >= 0) tables[table][i] = { ...tables[table][i], ...row };
      else tables[table].push(row);
      return { error: null };
    },
    then: (resolve: (v: { data: Row[] | null; error: null }) => void) => {
      if (mode === "delete") {
        tables[table] = tables[table].filter((r) => !filters.every((f) => f(r)));
        resolve({ data: null, error: null });
      } else {
        resolve({ data: tables[table].filter((r) => filters.every((f) => f(r))), error: null });
      }
    },
  };
  return api;
}
vi.mock("../lib/supabase", () => ({ getSupabaseAdmin: () => ({ from: (t: string) => query(t) }) }));

const fetchCalendarEvents = vi.fn();
vi.mock("../lib/microsoft", () => ({ fetchCalendarEvents }));

const listGranolaNotes = vi.fn();
const getGranolaNote = vi.fn();
vi.mock("../lib/granola", async (orig) => {
  const real = await orig<typeof import("../lib/granola")>();
  return { ...real, listGranolaNotes, getGranolaNote };
});

const { syncGranolaWeek, runGranolaSync, currentAndPreviousWeek } = await import("../lib/granola-sync");

const event = (id: string, subject: string, start: string, emails: string[]) => ({
  id,
  iCalUId: null,
  subject,
  start,
  end: start,
  startTimeZone: "UTC",
  organizer: { name: "Seb", email: "sebastian@valstonecorp.com" },
  attendees: emails.map((email) => ({ name: "", email })),
  bodyText: "",
});

const note = (id: string, title: string, start: string, emails: string[], updated = "2026-09-29T15:00:00Z") => ({
  id,
  object: "note",
  title,
  owner: { name: "Seb", email: "sebastian@valstonecorp.com" },
  created_at: start,
  updated_at: updated,
  web_url: `https://notes.granola.ai/d/${id}`,
  calendar_event: {
    event_title: title,
    invitees: emails.map((email) => ({ email })),
    organiser: "sebastian@valstonecorp.com",
    calendar_event_id: null,
    scheduled_start_time: start,
    scheduled_end_time: null,
  },
  attendees: [],
  summary_text: `summary of ${title}`,
  summary_markdown: `summary of ${title}`,
});

const N_EXT = "not_extaaaaaaaaaaa";
const N_INT = "not_intaaaaaaaaaaa";
const N_OTHER = "not_othaaaaaaaaaaa";

describe("Granola sync", () => {
  beforeEach(() => {
    tables.granola_notes = [];
    tables.app_settings = [];
    process.env.GRANOLA_API_KEY = "grn_test";
    fetchCalendarEvents.mockReset();
    listGranolaNotes.mockReset();
    getGranolaNote.mockReset();

    fetchCalendarEvents.mockResolvedValue([
      event("evt-ext", "Voxware / Valstone", "2026-09-29T14:00:00.0000000", ["ceo@voxware.com"]),
      event("evt-int", "Team sync", "2026-09-29T16:00:00.0000000", ["nate@valstonecorp.com"]),
    ]);
    const notes = {
      [N_EXT]: note(N_EXT, "Voxware", "2026-09-29T14:02:00Z", ["ceo@voxware.com"]),
      [N_INT]: note(N_INT, "Team sync", "2026-09-29T16:00:00Z", ["nate@valstonecorp.com"]),
      [N_OTHER]: note(N_OTHER, "Dentist", "2026-09-30T09:00:00Z", ["front@dentist.com"]),
    };
    listGranolaNotes.mockResolvedValue(Object.values(notes).map(({ id, updated_at, created_at }) => ({ id, updated_at, created_at })));
    getGranolaNote.mockImplementation(async (id: string) => notes[id as keyof typeof notes]);
  });

  it("stores only the note that matches a Call Logger row", async () => {
    const r = await syncGranolaWeek("2026-09-28", "2026-10-04");
    expect(r).toMatchObject({ meetings: 1, notesSeen: 3, matched: 1, skippedInternal: 1, unmatched: 1 });
    expect(tables.granola_notes).toHaveLength(1);
    expect(tables.granola_notes[0]).toMatchObject({ granola_note_id: N_EXT, event_id: "evt-ext", meeting_date: "2026-09-29" });
    // Nothing about the internal or unmatched notes is kept.
    expect(JSON.stringify(tables)).not.toContain("Team sync");
    expect(JSON.stringify(tables)).not.toContain("Dentist");
    // The week is listed by created date, a day either side.
    expect(listGranolaNotes).toHaveBeenCalledWith({ createdAfter: "2026-09-27", createdBefore: "2026-10-06" });
  });

  it("dedupes on the note id: an unchanged note isn't read or written again", async () => {
    await syncGranolaWeek("2026-09-28", "2026-10-04");
    getGranolaNote.mockClear();
    const r = await syncGranolaWeek("2026-09-28", "2026-10-04");
    expect(r.unchanged).toBe(1);
    expect(r.matched).toBe(0);
    expect(getGranolaNote).not.toHaveBeenCalledWith(N_EXT);
    expect(tables.granola_notes).toHaveLength(1);
  });

  it("re-reads and updates a note Granola changed", async () => {
    await syncGranolaWeek("2026-09-28", "2026-10-04");
    listGranolaNotes.mockResolvedValue([{ id: N_EXT, updated_at: "2026-09-29T18:00:00Z", created_at: "2026-09-29T14:02:00Z" }]);
    getGranolaNote.mockResolvedValue({ ...note(N_EXT, "Voxware", "2026-09-29T14:02:00Z", ["ceo@voxware.com"], "2026-09-29T18:00:00Z"), summary_markdown: "updated summary" });
    const r = await syncGranolaWeek("2026-09-28", "2026-10-04");
    expect(r.matched).toBe(1);
    expect(tables.granola_notes).toHaveLength(1);
    expect(tables.granola_notes[0].summary).toBe("updated summary");
  });

  it("records the error in plain words when Outlook isn't connected", async () => {
    fetchCalendarEvents.mockRejectedValue(new Error("MS_NOT_CONNECTED"));
    await expect(runGranolaSync([{ start: "2026-09-28", end: "2026-10-04" }], "button")).rejects.toThrow(/Outlook isn't connected/);
    const state = tables.app_settings.find((r) => r.key === "granola_sync_state")?.value as { lastError: string };
    expect(state.lastError).toMatch(/Outlook isn't connected/);
  });

  it("records the last sync time on success", async () => {
    const { state } = await runGranolaSync([{ start: "2026-09-28", end: "2026-10-04" }], "schedule");
    expect(state.lastError).toBeNull();
    expect(state.lastSuccessAt).toBeTruthy();
    expect(state.lastResult?.matched).toBe(1);
  });

  it("does nothing without an API key", async () => {
    delete process.env.GRANOLA_API_KEY;
    await expect(syncGranolaWeek("2026-09-28", "2026-10-04")).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(fetchCalendarEvents).not.toHaveBeenCalled();
  });

  it("works out this week and last week in Toronto time", () => {
    // Thursday Oct 1, 2026, 23:30 Toronto = Oct 2 03:30 UTC
    expect(currentAndPreviousWeek(new Date("2026-10-02T03:30:00Z"))).toEqual([
      { start: "2026-09-21", end: "2026-09-27" },
      { start: "2026-09-28", end: "2026-10-04" },
    ]);
  });
});
