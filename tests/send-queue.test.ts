import { describe, expect, it } from "vitest";
import { planSendSlots, recipientTimeZone } from "../lib/send-slots";
import { interpret } from "../lib/email-verify";
import { estimateCost } from "../lib/model-cost";
import { findPlaceholders, hookInfoFrom, matchSequence, normalizeSequenceName, rankContacts, splitDraft, titleRank } from "../lib/e1-sends";

describe("recipientTimeZone", () => {
  it("maps states, provinces and countries", () => {
    expect(recipientTimeZone("United States", "TX")).toBe("America/Chicago");
    expect(recipientTimeZone("United States", "California")).toBe("America/Los_Angeles");
    expect(recipientTimeZone("Canada", "BC")).toBe("America/Vancouver");
    expect(recipientTimeZone("Canada", "Quebec")).toBe("America/Toronto");
    expect(recipientTimeZone("Ireland", null)).toBe("Europe/Dublin");
    expect(recipientTimeZone("Australia", "Western Australia")).toBe("Australia/Perth");
    expect(recipientTimeZone(null, null)).toBe("America/New_York");
  });
});

describe("planSendSlots", () => {
  const local = (d: Date, tz: string) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(d).map((x) => [x.type, x.value]));
    return { minutes: (Number(p.hour) % 24) * 60 + Number(p.minute), weekday: p.weekday };
  };
  it("splits a batch between the morning and evening windows, on weekdays, spaced apart", () => {
    // A Tuesday at 03:00 UTC: 23:00 Monday in Toronto, so the next windows are Tuesday.
    const now = new Date("2026-10-20T03:00:00Z");
    const reqs = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, timeZone: "America/Toronto" }));
    let seed = 7;
    const random = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    const plan = planSendSlots(reqs, now, random);
    expect(plan).toHaveLength(20);
    const morning = plan.filter((p) => p.window === "morning");
    const evening = plan.filter((p) => p.window === "evening");
    expect(morning.length).toBe(10);
    expect(evening.length).toBe(10);
    for (const p of plan) {
      const l = local(p.at, "America/Toronto");
      expect(["Mon", "Tue", "Wed", "Thu", "Fri"]).toContain(l.weekday);
      if (p.window === "morning") expect(l.minutes).toBeGreaterThanOrEqual(6 * 60 + 45);
      if (p.window === "morning") expect(l.minutes).toBeLessThanOrEqual(8 * 60);
      if (p.window === "evening") expect(l.minutes).toBeGreaterThanOrEqual(17 * 60);
      if (p.window === "evening") expect(l.minutes).toBeLessThanOrEqual(19 * 60);
    }
    const sorted = plan.map((p) => p.at.getTime()).sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(5 * 60_000 - 1);
  });
  it("skips the weekend", () => {
    const now = new Date("2026-10-24T15:00:00Z"); // Saturday
    const plan = planSendSlots([{ id: "a", timeZone: "Europe/London" }], now, () => 0.3);
    expect(local(plan[0].at, "Europe/London").weekday).toBe("Mon");
  });
});

describe("email verdicts", () => {
  it("reads the verifier's fields in priority order", () => {
    expect(interpret({ result: "valid" })).toBe("valid");
    expect(interpret({ result: "valid", accept_all: true })).toBe("accept_all");
    expect(interpret({ result: "valid", role: true })).toBe("role");
    expect(interpret({ result: "invalid" })).toBe("invalid");
    expect(interpret({ result: "unknown" })).toBe("unknown");
  });
});

describe("cost estimate", () => {
  it("prices tokens and searches", () => {
    expect(estimateCost("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(3, 5);
    expect(estimateCost("claude-haiku-5-5", { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 2 } })).toBeCloseTo(0.02, 5);
  });
});

describe("send row helpers", () => {
  it("splits the Weekly Outreach draft into subject and body", () => {
    expect(splitDraft("Lunch: Valstone\n\nHi Tom,\n\nBody.")).toEqual({ subject: "Lunch: Valstone", body: "Hi Tom,\n\nBody." });
    expect(splitDraft(null)).toEqual({ subject: null, body: null });
  });
  it("ranks founders first and people with emails ahead of those without", () => {
    expect(titleRank("Co-Founder & CEO")).toBe(1);
    expect(titleRank("President")).toBe(4);
    expect(titleRank("Sales Manager")).toBe(7);
    const ranked = rankContacts([
      { Id: "1", FirstName: "A", LastName: "A", Name: "A A", Title: "VP Sales", Email: "a@x.com", AccountId: "acc" },
      { Id: "2", FirstName: "B", LastName: "B", Name: "B B", Title: "Founder", Email: null, AccountId: "acc" },
      { Id: "3", FirstName: "C", LastName: "C", Name: "C C", Title: "CEO", Email: "c@x.com", AccountId: "acc" },
    ]);
    expect(ranked.map((c) => c.id)).toEqual(["2", "3", "1"]);
  });
  it("matches groups to the [E] sequences by name", () => {
    const seqs = [
      { id: "1", name: "[E] - Manufacturing → Production Quality", tags: [], enabled: true },
      { id: "2", name: "[E] - Agriculture — Grain & Crop", tags: [], enabled: true },
      { id: "3", name: "[D-E] - Carveout - Construction & Materials", tags: [], enabled: true },
      { id: "4", name: "[E] - Contractor", tags: [], enabled: true },
    ];
    expect(normalizeSequenceName("[E] - Agriculture — Grain & Crop")).toBe("agriculture grain crop");
    expect(matchSequence("Manufacturing — Production Quality", seqs, {})?.id).toBe("1");
    expect(matchSequence("Grain & Crop", seqs, {})?.id).toBe("2");
    expect(matchSequence("Contractor Solutions", seqs, {})?.id).toBe("4"); // word overlap: "contractor"
    expect(matchSequence("Contractor Solutions", seqs, { "Contractor Solutions": "4" })?.id).toBe("4");
    expect(matchSequence("Construction & Materials", seqs, {})).toBeNull();
  });
});

describe("findPlaceholders", () => {
  it("catches merge fields and template placeholders", () => {
    expect(findPlaceholders("I have studied {{account.name}} going back to the release of (INSERT PRODUCT).")).toEqual(["{{account.name}}", "(INSERT PRODUCT)"]);
    expect(findPlaceholders("I will be in [INSERT TOWN] in the week of Nov 11.")).toEqual(["[INSERT TOWN]"]);
    expect(findPlaceholders("I have studied Acme going back to the release of Acme Cloud in 2009.")).toEqual([]);
    expect(findPlaceholders(null)).toEqual([]);
  });
});

describe("hookInfoFrom", () => {
  it("grades a sourced hook by its anchor evidence", () => {
    expect(hookInfoFrom(null).level).toBe("none");
    expect(hookInfoFrom({ emailHook: null, hookAnchor: null, hookSource: null }).level).toBe("none");
    const high = hookInfoFrom({
      emailHook: "I have studied Acme going back to the release of Acme Cloud.",
      hookSource: "web_research",
      hookAnchor: { type: "product_release", anchor: "the release of Acme Cloud", evidence: "Press release on acme.com, 2009.", sourceUrl: "https://www.acme.com/news/cloud", sourceLabel: "acme.com press release", factConfidence: "high" },
    });
    expect(high.level).toBe("high");
    expect(high.note).toContain("acme.com press release");
    const medium = hookInfoFrom({
      emailHook: "I have studied Acme going back to the days operating as Acme Systems.",
      hookSource: "web_research",
      hookAnchor: { type: "former_name", anchor: "the days operating as Acme Systems", evidence: "Mentioned on a directory page.", factConfidence: "medium" },
    });
    expect(medium.level).toBe("medium");
    const low = hookInfoFrom({ emailHook: "I have studied Acme going back to 2001.", hookSource: "web_research", hookAnchor: null });
    expect(low.level).toBe("low");
  });
});

describe("matchSequence tolerates naming drift", () => {
  const seqs = [
    { id: "1", name: "[E] - Logistics — Freight & Supply Chain", enabled: true },
    { id: "2", name: "[E] - CDM — Waste, Recycling & Environmental Services", enabled: true },
    { id: "3", name: "[E] - CDM — Bulk Materials", enabled: true },
    { id: "4", name: "[D-E] - CDM — Waste Recycling", enabled: true },
  ] as never[];
  it("matches on shared words when names are not identical", () => {
    expect(matchSequence("Freight Supply Chain Enablement", seqs, {})?.id).toBe("1");
    expect(matchSequence("Waste Recycling", seqs, {})?.id).toBe("2");
    expect(matchSequence("Bulk Materials", seqs, {})?.id).toBe("3");
  });
  it("gives up rather than guess", () => {
    expect(matchSequence("Fresh Produce", seqs, {})).toBeNull();
    expect(matchSequence(null, seqs, {})).toBeNull();
  });
});

describe("matchSequence against the real Outreach sequence names", () => {
  const names = ["[E] - Structure Design/Analysis","[E] - Logistics — Maritime","[E] - Logistics — Industrial Gate & Yard","[E] - Mining","[E] - Logistics — Rail","[E] - Manufacturing → Process Manufacturing","[E] - Manufacturing — Aftermarket & Service","[E] - Forest & Lumber","[E] - Agriculture — Fresh Produce","[E] - Contractor","[E] - Bulk Materials","[E] - Bulk Liquids","[E] - Manufacturing — Engineering & Estimating","[E] - Agriculture — Protein & Livestock","[E] - Agriculture — Grain & Crop","[D-E] - Carveout - Construction & Materials","[E] - Manufacturing → Production Quality","[E] - Waste","[E] - Logistics — Freight & Supply Chain Enablement","[E] - Safety & Compliance","[E] - Equipment"];
  const seqs = names.map((n, i) => ({ id: String(i), name: n, tags: [], enabled: true }));
  const expected: Record<string, string> = {
    "Fresh Produce": "[E] - Agriculture — Fresh Produce",
    "Grain Crop": "[E] - Agriculture — Grain & Crop",
    "Protein Livestock": "[E] - Agriculture — Protein & Livestock",
    "Bulk Liquids": "[E] - Bulk Liquids",
    "Bulk Materials": "[E] - Bulk Materials",
    "Contractor Solutions": "[E] - Contractor",
    "Equipment Dealers Rental": "[E] - Equipment",
    "Forestry Lumber": "[E] - Forest & Lumber",
    "Mining": "[E] - Mining",
    "Safety Compliance": "[E] - Safety & Compliance",
    "Structure Design Analysis": "[E] - Structure Design/Analysis",
    "Waste Recycling": "[E] - Waste",
    "Freight Supply Chain Enablement": "[E] - Logistics — Freight & Supply Chain Enablement",
    "Industrial Gate Yard": "[E] - Logistics — Industrial Gate & Yard",
    "Maritime": "[E] - Logistics — Maritime",
    "Rail": "[E] - Logistics — Rail",
    "Aftermarket Service": "[E] - Manufacturing — Aftermarket & Service",
    "Engineering Estimating": "[E] - Manufacturing — Engineering & Estimating",
    "Process Manufacturing": "[E] - Manufacturing → Process Manufacturing",
    "Production Quality": "[E] - Manufacturing → Production Quality",
  };
  it("pairs every group file with its sequence", () => {
    for (const [group, name] of Object.entries(expected)) {
      expect(matchSequence(group, seqs, {})?.name, group).toBe(name);
    }
  });
});
