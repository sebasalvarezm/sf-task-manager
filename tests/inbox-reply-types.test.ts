import { describe, expect, it } from "vitest";
import { fallbackReplyType, parseClassification, replyDefaults } from "@/lib/inbox-classify";
import { fallbackDraft, inboxDraftPrompt, normalizeDraft, SCHEDULING_SENTENCE } from "@/lib/inbox-draft";

const row = (o: Partial<{ sentiment: "positive" | "neutral" | "negative" | "unclear" | null; suggested_date: string | null; is_broker_intro: boolean }> = {}) => ({
  sentiment: "neutral" as const,
  suggested_date: null,
  received_at: "2026-11-10T14:00:00Z",
  is_broker_intro: false,
  ...o,
});

describe("reading the reply type", () => {
  it("takes the model's reply type", () => {
    const c = parseClassification('{"sentiment":"positive","timingText":null,"timingDate":null,"summary":"Friday works","isBrokerIntro":false,"replyType":"accept_time","autoReply":null,"returnDate":null,"newContact":null}');
    expect(c?.replyType).toBe("accept_time");
  });
  it("an automatic reply never gets a reply, and keeps the return date and new contact", () => {
    const ooo = parseClassification('{"sentiment":"unclear","summary":"Away","isBrokerIntro":false,"replyType":"acknowledge","autoReply":"out_of_office","returnDate":"2026-11-18","newContact":"Jane, jane@x.com"}');
    expect(ooo).toMatchObject({ replyType: "none", autoReply: "out_of_office", returnDate: "2026-11-18", newContact: "Jane, jane@x.com" });
    const left = parseClassification('{"sentiment":"unclear","summary":"Left","isBrokerIntro":false,"autoReply":"left_company","returnDate":"2026-11-18","newContact":"contact@assetfiftyfive.com"}');
    expect(left).toMatchObject({ replyType: "none", autoReply: "left_company", returnDate: null, newContact: "contact@assetfiftyfive.com" });
  });
  it("old answers without a reply type fall back on the sentiment", () => {
    expect(parseClassification('{"sentiment":"positive","summary":"","isBrokerIntro":false}')?.replyType).toBe("book_call");
    expect(parseClassification('{"sentiment":"neutral","summary":"","isBrokerIntro":false,"replyType":"nonsense"}')?.replyType).toBe("check_back");
    expect(fallbackReplyType("positive", true)).toBe("acknowledge");
    expect(fallbackReplyType("unclear", false)).toBe("acknowledge");
  });
});

describe("defaults per reply type", () => {
  const today = "2026-11-11";
  it("only Book a call copies the scheduling tool", () => {
    expect(replyDefaults("book_call", row({ sentiment: "positive" }), today)).toEqual({ cc: true, rceDays: null });
    expect(replyDefaults("book_call", row({ sentiment: "positive", is_broker_intro: true }), today).cc).toBe(false);
    for (const t of ["accept_time", "acknowledge", "check_back"] as const) expect(replyDefaults(t, row({ sentiment: "positive" }), today).cc).toBe(false);
  });
  it("only Check back later sets an RCE: their timing, else 6 months, a year after a no", () => {
    expect(replyDefaults("acknowledge", row({ suggested_date: "2027-05-10" }), today).rceDays).toBeNull();
    expect(replyDefaults("check_back", row({ suggested_date: "2026-12-11" }), today).rceDays).toBe(30);
    expect(replyDefaults("check_back", row(), today).rceDays).toBe(182);
    expect(replyDefaults("check_back", row({ sentiment: "negative" }), today).rceDays).toBe(365);
    expect(replyDefaults("check_back", row({ suggested_date: "2026-11-01" }), today).rceDays).toBe(182); // a date already past is ignored
  });
});

describe("drafts per reply type", () => {
  const draft = `Hi Jeff,\n\nThank you for sending these over. ${SCHEDULING_SENTENCE}\n\nBest,\nSebastian`;
  it("the scheduling sentence only survives in Book a call", () => {
    expect(normalizeDraft(draft, "book_call")).toContain(SCHEDULING_SENTENCE);
    const ack = normalizeDraft(draft, "acknowledge");
    expect(ack).not.toMatch(/scheduling/i);
    expect(ack).toBe("Hi Jeff,\n\nThank you for sending these over.\n\nBest,\nSebastian");
  });
  it("fallbacks match the type", () => {
    expect(fallbackDraft("positive", "Rocky", null, "accept_time")).toBe("Hi Rocky,\n\nThat works. I'll send over an invite.\n\nBest,\nSebastian");
    expect(fallbackDraft("positive", "Jeff", null, "acknowledge")).not.toMatch(/scheduling|check back/i);
    expect(fallbackDraft("positive", "Jeff", null, "book_call")).toContain(SCHEDULING_SENTENCE);
    expect(fallbackDraft("neutral", "Ann", "the spring", "check_back")).toContain("I'll check back in the spring");
  });
  it("the prompt tells the model what the reply does and their stance", () => {
    const p = inboxDraftPrompt({ thread: [{ from: "Jeff", email: "j@x.com", at: "2026-11-10", mine: false, text: "Financials attached." }], sentiment: "positive", replyType: "acknowledge", isBrokerIntro: false, accountName: "Ecto", senderName: "Jeff", timingText: null, nextTouchDate: null, examples: [] });
    expect(p).toContain("Reply: ACKNOWLEDGE");
    expect(p).toContain("Their stance: POSITIVE");
  });
});
