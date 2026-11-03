import { describe, expect, it } from "vitest";
import { bannedLeft, fixEmailWords } from "@/lib/email-words";

describe("fixEmailWords", () => {
  it("calls an email an email", () => {
    expect(fixEmailWords("I wanted to follow up on my notes from September.")).toBe("I wanted to follow up on my emails from September.");
    expect(fixEmailWords("Following up on my last note.")).toBe("Following up on my last email.");
    expect(fixEmailWords("since we last exchanged notes")).toBe("since we last exchanged emails");
    expect(fixEmailWords("I sent a note on September 23 asking about timing.")).toBe("I sent an email on September 23 asking about timing.");
    expect(fixEmailWords("I sent you a quick note in June.")).toBe("I sent you a quick email in June.");
    expect(fixEmailWords("Our criteria haven't changed from my last note.")).toBe("Our criteria haven't changed from my last email.");
    expect(fixEmailWords("Thank you for your note.")).toBe("Thank you for your email.");
  });
  it("leaves other meanings of note alone", () => {
    expect(fixEmailWords("Nothing of note to add.")).toBe("Nothing of note to add.");
    expect(fixEmailWords("I'd note that the market moved.")).toBe("I'd note that the market moved.");
    expect(fixEmailWords("Worth noting, we noted it.")).toBe("Worth noting, we noted it.");
    // Real E1 and RCE sentences where "notes" is not an email.
    const keep = [
      "Getting work orders, field notes, and invoices into one place.",
      "No agenda beyond comparing notes on where we are headed.",
      "Their release notes and call notes are in the app.",
      "My notes from April have TRU moving to a new ERP.",
      "They rebuilt it from the ground up for Microsoft .NET in 2019.",
    ];
    for (const k of keep) expect(fixEmailWords(k)).toBe(k);
  });
  it("removes dashes and thanks", () => {
    expect(fixEmailWords("Great call — thanks again.")).toBe("Great call, thank you again.");
    expect(fixEmailWords("Thanks for the time. Many thanks.")).toBe("Thank you for the time. Thank you.");
    expect(fixEmailWords("It grew thanks to the new module.")).toBe("It grew thanks to the new module.");
  });

  // Real sentences from drafts, Sept to Nov 2026.
  const cases: Array<[string, string]> = [
    ["It fits squarely in our bulk liquids group.", "It fits in our bulk liquids group."],
    ["If anything has shifted on your end, even just in terms of curiosity, I'm happy to talk.", "If anything has changed on your end, even just in terms of curiosity, I'm happy to talk."],
    ["If anything shifts on your end, I'd love to hear about it.", "If anything changes on your end, I'd love to hear about it."],
    ["I don't want to push, but if anything has shifted on the ownership side, I'd like to hear about it.", "I don't want to push, but if anything has changed on ownership, I'd like to hear about it."],
    ["Curious how things are tracking.", "Curious how things are going."],
    ["I wanted to check in to see how things are tracking on the growth side.", "I wanted to check in to see how growth is going."],
    ["Our interest in Infonet remains strong, and we're still building out the bulk liquids group.", "We're still interested in Infonet, and we're still building out the bulk liquids group."],
    ["So wanted to check in and see how the year is shaping up for the business.", "So wanted to check in and see how the year is going for the business."],
    ["I just like to stay in touch so we're not starting from scratch if your thinking ever shifts.", "I just like to stay in touch."],
    ["We keep building out our forestry group, and TimberTec stays top of mind for me.", "We keep building out our forestry group, and I keep coming back to TimberTec."],
    ["AMFG has been on my radar since last year.", "I've been following AMFG since last year."],
    ["Intouch is still very much on our radar.", "Intouch is still very much on our minds."],
    ["We keep adding to the group, and the telemetry platform stays top of mind for me.", "We keep adding to the group, and the telemetry platform keeps coming up for me."],
    ["I wanted to follow up in case my note from June got buried.", "I wanted to follow up on my email from June."],
  ];
  it.each(cases)("rewrites template phrases: %s", (input, expected) => {
    const out = fixEmailWords(input);
    expect(out).toBe(expected);
    expect(bannedLeft(out)).toEqual([]);
  });

  it("leaves industry words alone", () => {
    const s = "Their crew shift scheduling and fleet tracking software covers night shifts.";
    expect(fixEmailWords(s)).toBe(s);
  });
});
