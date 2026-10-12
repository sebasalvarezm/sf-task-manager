import { describe, expect, it } from "vitest";
import {
  companyFromSubject,
  domainOf,
  isAutomatedSender,
  isFreeMailDomain,
  parseClassification,
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
