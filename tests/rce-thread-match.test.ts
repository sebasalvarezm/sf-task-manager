import { describe, expect, it } from "vitest";
import { isAutomaticReply, matchRceReplyThread } from "../lib/rce-thread-match";
import type { OutlookRelationshipEmail } from "../lib/microsoft";

const me = "sebastian@valstonecorp.com";
function msg(partial: Partial<OutlookRelationshipEmail> & { id: string; sentDateTime: string }): OutlookRelationshipEmail {
  return { subject: "", fromEmail: me, fromName: "", toEmails: [], bodyText: "", conversationId: partial.id.split("-")[0], ...partial };
}
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe("RCE reply thread choice", () => {
  it("prefers the recent real conversation over an old thread that names the company in its subject", () => {
    const emails = [
      // 2024: outreach + out-of-office from a different person, subject names the company.
      msg({ id: "old-1", subject: "Opportunity - NECS", toEmails: ["nichole@necs.com"], sentDateTime: daysAgo(880) }),
      msg({ id: "old-2", subject: "Automatic reply: Opportunity - NECS", fromEmail: "nichole@necs.com", toEmails: [me], bodyText: "Hello,\n\nI will be out of the office until Tuesday, May 14, 2024.", sentDateTime: daysAgo(880) }),
      // Last six weeks: live exchange with the CEO, subject does not name the company.
      msg({ id: "new-1", subject: "Valstone Acquisition Interest", toEmails: ["chris@necs.com"], sentDateTime: daysAgo(45) }),
      msg({ id: "new-2", subject: "RE: Valstone Acquisition Interest", fromEmail: "chris@necs.com", toEmails: [me], bodyText: "Seb, happy to talk after the holidays.", sentDateTime: daysAgo(40) }),
    ];
    const match = matchRceReplyThread(emails, "NECS", "necs.com", me);
    expect(match.replyTarget?.id).toBe("new-2");
    expect(match.confidence).toBe("domain");
  });

  it("never replies into an auto-reply, even when it is the only received message", () => {
    const emails = [
      msg({ id: "a-1", subject: "Valstone / CropTrak", toEmails: ["mike@croptrak.com"], sentDateTime: daysAgo(400) }),
      msg({ id: "a-2", subject: "Automatic reply: Valstone / CropTrak", fromEmail: "mike@croptrak.com", toEmails: [me], bodyText: "I am currently out of the office with limited access to email.", sentDateTime: daysAgo(400) }),
    ];
    const match = matchRceReplyThread(emails, "CropTrak", "croptrak.com", me);
    expect(match.replyTarget).toBeNull();
  });

  it("recognises out-of-office replies by subject or body", () => {
    expect(isAutomaticReply({ subject: "Automatic reply: Opportunity - NECS", bodyText: "" })).toBe(true);
    expect(isAutomaticReply({ subject: "RE: Opportunity", bodyText: "Thanks for your note. I'm out of office until Monday." })).toBe(true);
    expect(isAutomaticReply({ subject: "RE: Opportunity", bodyText: "Happy to talk next week." })).toBe(false);
  });

  it("still uses the subject to find a broker thread when nobody from the company is on it", () => {
    const emails = [
      msg({ id: "b-1", subject: "DP Techlink - intro", fromEmail: "broker@mnp.ca", toEmails: [me], bodyText: "Sharing the teaser.", sentDateTime: daysAgo(30) }),
      msg({ id: "b-2", subject: "RE: DP Techlink - intro", toEmails: ["broker@mnp.ca"], sentDateTime: daysAgo(28) }),
    ];
    const match = matchRceReplyThread(emails, "DP Techlink", "dptechlink.com", me);
    expect(match.replyTarget?.id).toBe("b-1");
    expect(match.confidence).toBe("subject");
  });

  it("prefers the thread with the account's Salesforce contact even when they write from another domain", () => {
    const emails = [
      // Early 2025: the since-departed CEO, from the company domain, company name in subject.
      msg({ id: "ippe-1", subject: "DP Techlink & Valstone: IPPE Meeting", toEmails: ["mike@dptechlink.com"], sentDateTime: daysAgo(620) }),
      msg({ id: "ippe-2", subject: "RE: DP Techlink & Valstone: IPPE Meeting", fromEmail: "mike@dptechlink.com", toEmails: [me], bodyText: "See you in Atlanta.", sentDateTime: daysAgo(615) }),
      // Last year: the owner, writing from his holding company.
      msg({ id: "rc-1", subject: "Valstone & DP Techlink Reconnect", toEmails: ["dave@kierholdings.com"], sentDateTime: daysAgo(365) }),
      msg({ id: "rc-2", subject: "RE: Valstone & DP Techlink Reconnect", fromEmail: "dave@kierholdings.com", toEmails: [me], bodyText: "Available at 4:30 today.", sentDateTime: daysAgo(357) }),
    ];
    const match = matchRceReplyThread(emails, "DP Techlink", "dptechlink.com", me, ["dave@kierholdings.com"]);
    expect(match.replyTarget?.id).toBe("rc-2");
    expect(match.confidence).toBe("contact");
  });

  it("prefers the recent exchange with the CEO over an older one with staff on the same domain", () => {
    const emails = [
      msg({ id: "p-1", subject: "CropTrak & Valstone Partnership", toEmails: ["astephens@croptrak.com"], sentDateTime: daysAgo(500) }),
      msg({ id: "p-2", subject: "RE: CropTrak & Valstone Partnership", fromEmail: "astephens@croptrak.com", toEmails: [me], bodyText: "Wednesday at 10am works.", sentDateTime: daysAgo(490) }),
      msg({ id: "f-1", subject: "Follow Up File", fromEmail: "mtavorath@croptrak.com", toEmails: [me], bodyText: "Good afternoon, Sebastian. There was a window last year...", sentDateTime: daysAgo(64) }),
      msg({ id: "f-2", subject: "Re: Follow Up File", toEmails: ["mtavorath@croptrak.com"], sentDateTime: daysAgo(31) }),
    ];
    const match = matchRceReplyThread(emails, "CropTrak", "croptrak.com", me, ["mtavorath@croptrak.com"]);
    expect(match.replyTarget?.id).toBe("f-1");
  });
});

describe("generic lead words", () => {
  it("does not let 'Design' alone claim a thread for Design Maintenance Systems", () => {
    const r = matchRceReplyThread(
      [msg({ id: "x-1", subject: "Web design proposal", fromEmail: "sam@agency.io", toEmails: [me], sentDateTime: daysAgo(10) })],
      "Design Maintenance Systems",
      "desmaint.com",
      me,
    );
    expect(r.replyTarget).toBeNull();
  });
});
