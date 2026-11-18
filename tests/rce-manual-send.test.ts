import { describe, expect, it } from "vitest";
import { linkToManualSend, pickManualSend } from "../lib/rce-manual-send";
import { matchRceReplyThread } from "../lib/rce-thread-match";
import { readWeeklyOutreachSourceMetadata } from "../lib/weekly-outreach";
import type { OutlookRelationshipEmail, SentMessage } from "../lib/microsoft";

const me = "seb@valstone.test";
const ids = new Set([me]);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const sent = (p: Partial<SentMessage> & { id: string }): SentMessage => ({ subject: "", conversationId: p.id, sentDateTime: daysAgo(1), to: [], cc: [], ...p });

describe("finding the email Seb sent by hand", () => {
  const opts = { domain: "smartapp.com", contactEmails: ["mcolapietro@smartapp.com"], since: daysAgo(7), identities: ids };

  it("finds his reply to the company's domain, even to someone not in Salesforce", () => {
    const list = [
      sent({ id: "other", subject: "RE: Lunch", to: [{ name: "Bob", email: "bob@other.com" }], sentDateTime: daysAgo(0.5) }),
      sent({ id: "smart", subject: "Re: Valstone & Smartapp Strategic Alignment - Next Steps", conversationId: "conv-aasawari", to: [{ name: "Aasawari Kakade", email: "aasawari@smartapp.com" }], sentDateTime: daysAgo(1) }),
    ];
    expect(pickManualSend(list, opts)?.conversationId).toBe("conv-aasawari");
  });

  it("prefers a reply in a chain over a new email, then the newest; ignores old ones and other companies", () => {
    const list = [
      sent({ id: "new-email", subject: "Valstone / Smartapp", to: [{ name: null, email: "ceo@smartapp.com" }], sentDateTime: daysAgo(0.2) }),
      sent({ id: "reply", subject: "RE: Valstone call", to: [{ name: null, email: "mcolapietro@smartapp.com" }], sentDateTime: daysAgo(2) }),
      sent({ id: "too-old", subject: "RE: Valstone call", to: [{ name: null, email: "mcolapietro@smartapp.com" }], sentDateTime: daysAgo(9) }),
    ];
    expect(pickManualSend(list, opts)?.id).toBe("reply");
    expect(pickManualSend([sent({ id: "x", subject: "RE: hi", to: [{ name: null, email: "a@notsmartapp.com" }] })], opts)).toBeNull();
    // A cc to the company counts; an email only to ourselves does not.
    expect(pickManualSend([sent({ id: "cc", subject: "RE: x", to: [{ name: null, email: me }], cc: [{ name: null, email: "aasawari@smartapp.com" }] })], opts)?.id).toBe("cc");
    expect(pickManualSend([sent({ id: "self", subject: "RE: x", to: [{ name: null, email: me }] })], opts)).toBeNull();
  });

  it("does not match everyone on a public email domain", () => {
    const list = [sent({ id: "g", subject: "RE: x", to: [{ name: null, email: "someone@gmail.com" }] })];
    expect(pickManualSend(list, { ...opts, domain: "gmail.com", contactEmails: [] })).toBeNull();
    expect(pickManualSend(list, { ...opts, domain: "gmail.com", contactEmails: ["someone@gmail.com"] })?.id).toBe("g");
  });

  it("links the row to that chain so the follow-up goes there", () => {
    const before = { ...readWeeklyOutreachSourceMetadata(null), conversationId: "conv-michael", recipients: [{ name: "Michael", email: "mcolapietro@smartapp.com" }] };
    const found = sent({ id: "m1", subject: "Re: Valstone & Smartapp Strategic Alignment - Next Steps", conversationId: "conv-aasawari", to: [{ name: "Aasawari Kakade", email: "aasawari@smartapp.com" }, { name: null, email: me }], sentDateTime: "2026-11-18T15:00:00Z" });
    const { metadata, relinked, note } = linkToManualSend(before, found, ids);
    expect(relinked).toBe(true);
    expect(metadata).toMatchObject({ conversationId: "conv-aasawari", replyToMessageId: "m1", rceFirstSentAt: "2026-11-18T15:00:00Z", recipients: [{ name: "Aasawari Kakade", email: "aasawari@smartapp.com" }] });
    expect(note).toMatch(/Strategic Alignment.*Aasawari Kakade/);
  });
});

describe("picking the chain in the first place (Smartapp, Nov 2026)", () => {
  const msg = (p: Partial<OutlookRelationshipEmail> & { id: string; sentDateTime: string }): OutlookRelationshipEmail => ({ subject: "", fromEmail: me, fromName: "", toEmails: [], bodyText: "", conversationId: p.id.split("-")[0], ...p });
  const emails = [
    // Older chain with Michael, a Salesforce contact.
    msg({ id: "call-1", subject: "Valstone call", toEmails: ["mcolapietro@smartapp.com"], sentDateTime: daysAgo(150) }),
    msg({ id: "call-2", subject: "RE: Valstone call", fromEmail: "mcolapietro@smartapp.com", fromName: "Michael Colapietro", toEmails: [me], bodyText: "Sounds good.", sentDateTime: daysAgo(145) }),
    // Live chain with Aasawari, who is not in Salesforce.
    msg({ id: "align-1", subject: "Valstone & Smartapp Strategic Alignment - Next Steps", fromEmail: "aasawari@smartapp.com", fromName: "Aasawari Kakade", toEmails: [me], bodyText: "Still interested, Q4 is busy.", sentDateTime: daysAgo(56) }),
    msg({ id: "align-2", subject: "RE: Valstone & Smartapp Strategic Alignment - Next Steps", toEmails: ["aasawari@smartapp.com"], sentDateTime: daysAgo(54) }),
  ];

  it("the live chain with someone from the company beats an older one with a Salesforce contact", () => {
    const m = matchRceReplyThread(emails, "Smartapp.com", "smartapp.com", me, ["mcolapietro@smartapp.com"]);
    expect(m.replyTarget?.id).toBe("align-1");
  });

  it("the chain Seb chose by hand last time wins next time", () => {
    const flipped = emails.map((e) => (e.id.startsWith("call") ? { ...e, sentDateTime: daysAgo(e.id === "call-1" ? 20 : 15) } : e));
    expect(matchRceReplyThread(flipped, "Smartapp.com", "smartapp.com", me, ["mcolapietro@smartapp.com"]).replyTarget?.id).toBe("call-2");
    const m = matchRceReplyThread(flipped, "Smartapp.com", "smartapp.com", me, ["mcolapietro@smartapp.com"], "align");
    expect(m.replyTarget?.id).toBe("align-1");
    expect(m.reason).toMatch(/last reconnect/);
  });
});
