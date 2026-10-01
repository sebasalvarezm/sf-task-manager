import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GranolaError,
  getGranolaTranscript,
  listGranolaNotes,
  retryDelayMs,
  transcriptToText,
} from "../lib/granola";

const noSleep = vi.fn(async () => {});

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

describe("Granola client", () => {
  beforeEach(() => {
    process.env.GRANOLA_API_KEY = "grn_test";
    noSleep.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GRANOLA_API_KEY;
  });

  it("sends the Bearer key, filters by created date and follows every page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ notes: [{ id: "not_aaaaaaaaaaaaaa" }], hasMore: true, cursor: "c1" }))
      .mockResolvedValueOnce(json({ notes: [{ id: "not_bbbbbbbbbbbbbb" }], hasMore: false, cursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    const notes = await listGranolaNotes(
      { createdAfter: "2026-09-27", createdBefore: "2026-10-06" },
      { sleep: noSleep },
    );

    expect(notes.map((n) => n.id)).toEqual(["not_aaaaaaaaaaaaaa", "not_bbbbbbbbbbbbbb"]);
    const first = new URL(String(fetchMock.mock.calls[0][0]));
    expect(first.origin + first.pathname).toBe("https://public-api.granola.ai/v1/notes");
    expect(first.searchParams.get("created_after")).toBe("2026-09-27");
    expect(first.searchParams.get("created_before")).toBe("2026-10-06");
    expect(first.searchParams.get("page_size")).toBe("30");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer grn_test");
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("cursor")).toBe("c1");
  });

  it("retries on 429 and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ message: "slow down" }, 429, { "Retry-After": "2" }))
      .mockResolvedValueOnce(json({ message: "slow down" }, 429))
      .mockResolvedValueOnce(json({ notes: [], hasMore: false, cursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listGranolaNotes({}, { sleep: noSleep })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenNthCalledWith(1, 2000); // Retry-After honoured
    expect(noSleep).toHaveBeenNthCalledWith(2, 2000); // backoff for attempt 2
  });

  it("gives up after the last attempt with a plain rate-limit message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, 429)));
    await expect(listGranolaNotes({}, { sleep: noSleep, maxAttempts: 3 })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("does not retry a bad key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ message: "Unauthorized" }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const err = await listGranolaNotes({}, { sleep: noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(GranolaError);
    expect(err.code).toBe("UNAUTHORIZED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("says so in plain words when the key is missing, without calling Granola", async () => {
    delete process.env.GRANOLA_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(listGranolaNotes({})).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pages through a long transcript", async () => {
    const line = (text: string, attribution: "me" | "them") => ({
      speaker: { source: attribution === "me" ? "microphone" : "speaker", attribution },
      text,
      start_time: "2026-09-29T14:00:00Z",
      end_time: "2026-09-29T14:00:05Z",
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ transcript: [line("Hi", "me")], hasMore: true, cursor: "t2" }))
        .mockResolvedValueOnce(json({ transcript: [line("About 4M revenue", "them")], hasMore: false, cursor: null })),
    );
    const items = await getGranolaTranscript("not_aaaaaaaaaaaaaa", { sleep: noSleep });
    expect(transcriptToText(items)).toBe("Me: Hi\nThem: About 4M revenue");
  });

  it("rejects malformed note ids before building a URL", async () => {
    await expect(getGranolaTranscript("../notes")).rejects.toBeInstanceOf(GranolaError);
  });

  it("backs off 1s, 2s, 4s and caps", () => {
    expect([1, 2, 3].map((a) => retryDelayMs(a, null))).toEqual([1000, 2000, 4000]);
    expect(retryDelayMs(10, null)).toBe(16000);
  });
});
