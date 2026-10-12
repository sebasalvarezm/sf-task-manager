import { describe, expect, it } from "vitest";
import {
  companyFromSubject,
  domainOf,
  isAutomatedSender,
  isFreeMailDomain,
  parseClassification,
  parseRceDays,
  suggestedNextTouch,
  trimReplyBody,
} from "../lib/inbox-classify";

describe("inbox: sender filter", () => {
  it("drops notifications, calendar replies and known automated domains", () => {
    expect(isAutomatedSender("noreply@salesforce.com", "ACTION REQUIRED")).toBe(true);
    expect(isAutomatedSender("digest@pphosted.com", "Quarantine Digest")).toBe(true);
    expect(isAutomatedSender("tyler@acme.com", "Accepted: Valstone & Acme")).toBe(true);
    expect(isAutomatedSender("scheduler@blockit.com", "WMC Intro: Sebastian")).toBe(true);
  });
  it("keeps a founder's reply", () => {
    expect(isAutomatedSender("nzorkin@enkon.com", "Valstone & Enkon")).toBe(false);
  });
});

describe("inbox: domains and subjects", () => {
  it("extracts the sender domain", () => {
    expect(domainOf("NZorkin@Enkon.com")).toBe("enkon.com");
    expect(domainOf("not an email")).toBeNull();
  });
  it("treats free mail as not a company", () => {
    expect(isFreeMailDomain("gmail.com")).toBe(true);
    expect(isFreeMailDomain("enkon.com")).toBe(false);
  });
  it("reads the company out of an outreach subject", () => {
    expect(companyFromSubject("RE: Valstone & Enkon")).toBe("Enkon");
    expect(companyFromSubject("Valstone / The Seam")).toBe("The Seam");
    expect(companyFromSubject("Re: Nomitech & Valstone")).toBe("Nomitech");
    expect(companyFromSubject("Quick follow-up")).toBeNull();
  });
});

describe("inbox: next touch", () => {
  const received = "2026-10-09T14:00:00Z";
  it("uses their timing when they gave one", () => {
    expect(suggestedNextTouch({ sentiment: "neutral", timingDate: "2027-04-09" }, received)).toBe("2027-04-09");
  });
  it("defaults neutral to six months and negative to a year", () => {
    expect(suggestedNextTouch({ sentiment: "neutral", timingDate: null }, received)).toBe("2027-04-09");
    expect(suggestedNextTouch({ sentiment: "negative", timingDate: "2026-11-01" }, received)).toBe("2027-10-09");
  });
  it("gives positive replies no task", () => {
    expect(suggestedNextTouch({ sentiment: "positive", timingDate: null }, received)).toBeNull();
  });
  it("never schedules in the past", () => {
    expect(suggestedNextTouch({ sentiment: "neutral", timingDate: "2026-01-01" }, received)).toBe("2026-11-08");
  });
});

describe("inbox: parsing the classifier", () => {
  it("reads JSON even when wrapped in prose", () => {
    const parsed = parseClassification(
      'Here you go: {"sentiment":"neutral","timingText":"six months or so","timingDate":"2027-04-09","summary":"Not selling, reconnect in six months.","isBrokerIntro":false}',
    );
    expect(parsed?.sentiment).toBe("neutral");
    expect(parsed?.timingText).toBe("six months or so");
    expect(parsed?.timingDate).toBe("2027-04-09");
  });
  it("falls back to unclear on a bad label and rejects a bad date", () => {
    const parsed = parseClassification('{"sentiment":"meh","timingDate":"next year","summary":"x"}');
    expect(parsed?.sentiment).toBe("unclear");
    expect(parsed?.timingDate).toBeNull();
  });
  it("returns null when there is no JSON", () => {
    expect(parseClassification("I could not read that.")).toBeNull();
  });
});

describe("inbox: trimming quoted history", () => {
  it("keeps their words and drops the quoted thread", () => {
    const body = `Hi Seb,

We are still not considering selling. I suggest touching base in six months or so.

Regards,
Niko

From: Sebastian Alvarez
Sent: Monday
> earlier text`;
    const trimmed = trimReplyBody(body);
    expect(trimmed).toContain("six months or so");
    expect(trimmed).not.toContain("From: Sebastian");
    expect(trimmed).not.toContain("earlier text");
  });
});

describe("inbox: signatures and tracking junk", () => {
  it("drops the signature block, proofpoint links and the legal footer", () => {
    const body = `Sebastian, Kahua has signed a deal with Bain Capital.

Thank you.

Scott Unger
Chief Executive Officer, Kahua, Inc.

[icon] 678.576.7285<tel:678.576.7285>  [icon]
www.kahua.com<https://urldefense.proofpoint.com/v2/url?u=https-3A__www.kahua.com&d=abc>
[icon]  sunger@kahua.com<mailto:sunger@kahua.com>

IMPORTANT: The contents of this email and any attachments are confidential.`;
    const trimmed = trimReplyBody(body);
    expect(trimmed).toContain("signed a deal with Bain Capital");
    expect(trimmed).not.toContain("urldefense");
    expect(trimmed).not.toContain("[icon]");
    expect(trimmed).not.toContain("IMPORTANT");
    expect(trimmed).not.toContain("Chief Executive Officer");
  });
  it("keeps the name after a sign-off and nothing more", () => {
    const trimmed = trimReplyBody("Hi Seb,\n\nStill not selling.\n\nRegards,\nNiko\n\nNiko Zorkin | CEO\nENKON Information Systems Inc.\nPh: +1-250-480-7103");
    expect(trimmed.endsWith("Regards,\nNiko")).toBe(true);
  });
});

describe("inbox: rce shorthand", () => {
  it("reads rce50, 50 and blank", () => {
    expect(parseRceDays("rce50")).toBe(50);
    expect(parseRceDays("RCE 365")).toBe(365);
    expect(parseRceDays("50")).toBe(50);
    expect(parseRceDays("")).toBeNull();
    expect(parseRceDays("none")).toBeNull();
    expect(parseRceDays("next year")).toBeUndefined();
  });
  it("positive replies never get a date even when one is mentioned", () => {
    expect(suggestedNextTouch({ sentiment: "positive", timingDate: "2026-10-22" }, "2026-10-11T00:00:00Z")).toBeNull();
  });
});
