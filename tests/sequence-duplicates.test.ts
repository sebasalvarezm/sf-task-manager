import { describe, expect, it } from "vitest";
import { preferredSequences, type OutreachSequence } from "@/lib/outreach";
import { matchSequence, normalizeSequenceName } from "@/lib/e1-sends";

const seq = (id: string, name: string, shareType: string | null = "shared"): OutreachSequence => ({ id, name, tags: [], enabled: true, shareType });

describe("same-name sequences (ISoft Data, Nov 2026)", () => {
  // Outreach listed Jeffrey Li's private copy after the shared one.
  const list = [seq("13", "[E] - Equipment"), seq("10", "[E] - Safety & Compliance"), seq("153", "[E] - Equipment", "private")];

  it("keeps the shared sequence, not a colleague's private copy with the same name", () => {
    expect(preferredSequences(list, normalizeSequenceName).map((s) => s.id)).toEqual(["13", "10"]);
    // Even when the private copy comes first.
    expect(preferredSequences([list[2], list[0]], normalizeSequenceName).map((s) => s.id)).toEqual(["13"]);
  });

  it("two shared copies: the oldest wins", () => {
    expect(preferredSequences([seq("200", "[E] - Waste"), seq("33", "[E] - Waste")], normalizeSequenceName).map((s) => s.id)).toEqual(["33"]);
  });

  it("the automatic match never lands on the private copy", () => {
    expect(matchSequence("Equipment Dealers, Rental and Maintenance", [list[2], list[0]], {})?.id ?? matchSequence("Equipment", [list[2], list[0]], {})?.id).toBe("13");
  });
});
