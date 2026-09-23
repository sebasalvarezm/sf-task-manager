import { describe, it, expect } from "vitest";
import {
  parseRetryAfterMs,
  isFoundingAnchor,
  validateColdAnchors,
} from "../lib/scout";

// ── Retry-After parsing (Wayback throttling) ─────────────────────────────────

describe("parseRetryAfterMs", () => {
  it("parses a seconds value", () => {
    expect(parseRetryAfterMs("30")).toBe(30_000);
  });

  it("caps any cooldown at 60s, whatever the server asks for", () => {
    expect(parseRetryAfterMs("600")).toBe(60_000);
  });

  it("parses an HTTP-date value (capped)", () => {
    const inTenSec = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfterMs(inTenSec)!;
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(60_000);
  });

  it("returns null for garbage or a missing header", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("soon")).toBeNull();
  });
});

// ── Founding-fact ban ────────────────────────────────────────────────────────

describe("isFoundingAnchor — founding facts are banned as hooks", () => {
  it("catches founding phrasings", () => {
    expect(isFoundingAnchor("the founding of Acme in 1995")).toBe(true);
    expect(isFoundingAnchor("when the company was founded")).toBe(true);
    expect(isFoundingAnchor("its incorporation in Delaware")).toBe(true);
  });

  it("lets real product-history anchors through", () => {
    expect(isFoundingAnchor("the release of Herbst Attendance in 2008")).toBe(
      false,
    );
    expect(isFoundingAnchor("the days operating as Resolution Systems")).toBe(
      false,
    );
  });
});

// ── Cold-anchor validation ───────────────────────────────────────────────────

function rawAnchor(overrides: Record<string, unknown> = {}) {
  return {
    type: "product_release",
    anchor: "the release of WidgetPro in 2011",
    evidence: "found in a press release",
    sourceUrl: "https://www.prnewswire.com/some-release",
    sourceLabel: "PR Newswire",
    year: 2011,
    factConfidence: "high",
    dateConfidence: "high",
    obviousness: "buried",
    ...overrides,
  };
}

describe("validateColdAnchors — what survives into a hook", () => {
  const citedUrls = ["https://www.prnewswire.com/some-release"];

  it("keeps a well-sourced anchor whose host appeared in the search citations", () => {
    const out = validateColdAnchors([rawAnchor()], citedUrls, "acme.com");
    expect(out).toHaveLength(1);
    expect(out[0].factConfidence).toBe("high");
  });

  it("drops founding anchors outright, however well sourced", () => {
    const out = validateColdAnchors(
      [rawAnchor({ anchor: "the founding of Acme in 1995" })],
      citedUrls,
      "acme.com",
    );
    expect(out).toHaveLength(0);
  });

  it("drops an anchor with no checkable source URL", () => {
    const out = validateColdAnchors(
      [rawAnchor({ sourceUrl: null })],
      citedUrls,
      "acme.com",
    );
    expect(out).toHaveLength(0);
  });

  it("drops an anchor whose source host was never returned by the search (fabrication guard)", () => {
    const out = validateColdAnchors(
      [rawAnchor({ sourceUrl: "https://madeup-blog.io/post" })],
      citedUrls,
      "acme.com",
    );
    expect(out).toHaveLength(0);
  });

  it("keeps the anchor but caps confidence when there are no citations to check against", () => {
    const out = validateColdAnchors([rawAnchor()], [], "acme.com");
    expect(out).toHaveLength(1);
    expect(out[0].factConfidence).toBe("medium");
  });

  it("downgrades a self-sourced former-name claim from high to medium", () => {
    const out = validateColdAnchors(
      [
        rawAnchor({
          type: "former_name",
          anchor: "the days operating as OldCo Systems",
          sourceUrl: "https://acme.com/about",
        }),
      ],
      ["https://acme.com/about"],
      "acme.com",
    );
    expect(out).toHaveLength(1);
    expect(out[0].factConfidence).toBe("medium");
  });

  it("rejects unknown anchor types and empty anchors", () => {
    const out = validateColdAnchors(
      [rawAnchor({ type: "vibes" }), rawAnchor({ anchor: "  " })],
      citedUrls,
      "acme.com",
    );
    expect(out).toHaveLength(0);
  });
});

import { humanizeDomainStem, quickCompanyName } from "../lib/scout";

describe("humanizeDomainStem", () => {
  it("uses the page title when its letters spell the stem", () => {
    const text = "Title: Navitas Safety | Food Safety Software\n\nWelcome to Navitas Safety.";
    expect(humanizeDomainStem("navitassafety", text)).toBe("Navitas Safety");
  });
  it("finds the spelling in body text when the title is different", () => {
    const text = "Title: Home\n\nForesight Intelligence builds fleet tools. Foresight Intelligence was founded in 2012.";
    expect(humanizeDomainStem("foresightintelligence", text)).toBe("Foresight Intelligence");
  });
  it("splits a known suffix word without any page text", () => {
    expect(humanizeDomainStem("navitassafety", null)).toBe("Navitas Safety");
    expect(humanizeDomainStem("locicontrols", null)).toBe("Loci Controls");
    expect(humanizeDomainStem("fast-soft", null)).toBe("Fast Soft");
  });
  it("leaves single-word names alone", () => {
    expect(humanizeDomainStem("carga", "Title: Carga")).toBe("Carga");
    expect(humanizeDomainStem("route4me", null)).toBe("Route4me");
  });
  it("is used by quickCompanyName", () => {
    expect(quickCompanyName("https://www.navitassafety.com/about", null)).toBe("Navitas Safety");
  });
});
