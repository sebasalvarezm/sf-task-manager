import { describe, expect, it } from "vitest";
import { findLinkedInCompanyUrl, formatExcluded, parseOwnershipCheck, applyOwnershipCheck, ownershipSummary, type ScreenVerdict } from "../lib/outreach-screen";
import { stripCites } from "../lib/anthropic";
import { htmlToText, isUsablePageText, parseGroupMatch } from "../lib/scout";

describe("LinkedIn company page from site text", () => {
  it("finds a company page in Jina markdown", () => {
    const text = "Follow us [LinkedIn](https://www.linkedin.com/company/tronia-systems/) and [Twitter](https://x.com/tronia)";
    expect(findLinkedInCompanyUrl(text)).toBe("https://www.linkedin.com/company/tronia-systems");
  });
  it("accepts regional hosts and upgrades http", () => {
    expect(findLinkedInCompanyUrl("http://ca.linkedin.com/company/acme")).toBe("https://ca.linkedin.com/company/acme");
  });
  it("ignores personal profiles", () => {
    expect(findLinkedInCompanyUrl("https://www.linkedin.com/in/dave-owner")).toBeNull();
  });
});

describe("LinkedIn lookup reply parsing", () => {
  it("pulls the company URL out of a chatty reply and strips tracking", () => {
    expect(findLinkedInCompanyUrl("The page is https://www.linkedin.com/company/tronia-systems/?trk=foo for Tronia.")).toBe("https://www.linkedin.com/company/tronia-systems");
  });
});

describe("formatExcluded", () => {
  it("turns Seb's wrong-market skips into one example line each, without repeats", () => {
    const text = formatExcluded([
      { account_name: "Acme Dental", skip_reason: "Wrong end market: dental labs", screen_facts: { softwareType: "lab scheduling" } },
      { account_name: "Acme Dental", skip_reason: "Wrong end market: dental labs", screen_facts: { softwareType: "lab scheduling" } },
      { account_name: "Church Hub", skip_reason: "Wrong end market", screen_facts: null },
    ]);
    expect(text).toBe("- Acme Dental (lab scheduling): dental labs\n- Church Hub");
  });
});

describe("stripCites", () => {
  it("removes the search tool's cite tags and nothing else", () => {
    expect(stripCites("<cite index='7-1'>Ecochain makes software.</cite> <cite index='6-5'>Two products.</cite>")).toBe("Ecochain makes software. Two products.");
    expect(stripCites("plain text")).toBe("plain text");
  });
});

describe("htmlToText", () => {
  it("drops scripts, styles and tags and keeps the words", () => {
    const html = "<html><head><style>p{}</style><script>x=1</script></head><body><h1>Ricult</h1><p>Farm &amp; crop software for <b>agri lenders</b>.</p></body></html>";
    expect(htmlToText(html)).toBe("Ricult\nFarm & crop software for agri lenders.");
  });
});

describe("isUsablePageText", () => {
  it("rejects thin pages and JavaScript shells, accepts real prose", () => {
    expect(isUsablePageText("short")).toBe(false);
    expect(isUsablePageText("You need to enable JavaScript to run this app. " + "x".repeat(700))).toBe(false);
    expect(isUsablePageText("Ricult builds credit scoring and farm management software for agricultural lenders. ".repeat(12))).toBe(true);
  });
});

describe("parseGroupMatch", () => {
  const groups = { "Agriculture/fresh-produce.md": "x", "Manufacturing/aftermarket-service.md": "y", "Logistics/rail.md": "z" };
  it("reads a clean JSON answer", () => {
    const m = parseGroupMatch('{"file":"Manufacturing/aftermarket-service.md","confidence":85}', groups);
    expect(m).toMatchObject({ matched: true, group: "Aftermarket Service", mainGroup: "Manufacturing", confidence: 85 });
  });
  it("reads JSON inside a fence or a sentence, and a bare file name", () => {
    expect(parseGroupMatch('```json\n{"file":"Logistics/rail.md","confidence":70}\n```', groups).group).toBe("Rail");
    expect(parseGroupMatch('Best fit: {"file": "rail.md", "confidence": 60}', groups).group).toBe("Rail");
    expect(parseGroupMatch('"Logistics/rail.md"', groups).group).toBe("Rail");
  });
  it("never guesses: an empty or unreadable answer is unmatched with a warning", () => {
    expect(parseGroupMatch("", groups)).toMatchObject({ matched: false, group: null });
    expect(parseGroupMatch("", groups).warning).toBeTruthy();
    const prose = parseGroupMatch("Looking at the website, this company builds software for", groups);
    expect(prose.matched).toBe(false);
    expect(prose.warning).toBeTruthy();
    expect(parseGroupMatch('{"file":"Agriculture/","confidence":50}', groups).matched).toBe(false);
    expect(parseGroupMatch('{"file":"NO_MATCH","confidence":10}', groups)).toMatchObject({ matched: false, confidence: 10 });
    expect(parseGroupMatch("NO_MATCH", groups).matched).toBe(false);
  });
});

describe("ownership check after the site check", () => {
  const base: ScreenVerdict = {
    status: "software",
    reason: "Fleet maintenance software for rail operators.",
    facts: { softwareType: "rail fleet maintenance software", businessModel: "software", acquiredBy: null, acquiredWhen: null, employeesOnSite: null, ownership: "unknown", investment: null, summary: "Rail fleet maintenance software, ownership unclear", group: null, linkedin: null, confidence: "high", source: [] },
  };
  it("keeps a clean company as software and says nothing was found", () => {
    const c = parseOwnershipCheck('{"acquired":false,"acquired_by":null,"acquired_when":null,"ownership":"bootstrapped","investment":null,"skip_rule":null,"evidence":null}');
    const v = applyOwnershipCheck(base, "Rail fleet maintenance", c);
    expect(v.status).toBe("software");
    expect(v.facts.ownership).toBe("bootstrapped");
    expect(v.facts.summary).toBe("Rail fleet maintenance, bootstrapped, no acquisition or investment on record");
  });
  it("turns a found acquisition into an acquired verdict", () => {
    const c = parseOwnershipCheck('Here you go: {"acquired":true,"acquired_by":"Trimble","acquired_when":"March 2026","ownership":"subsidiary","investment":null,"skip_rule":null,"evidence":"Trimble announced the acquisition in March 2026."}');
    const v = applyOwnershipCheck(base, "Rail fleet maintenance", c);
    expect(v.status).toBe("acquired");
    expect(v.reason).toBe("Trimble announced the acquisition in March 2026.");
    expect(v.facts.acquiredBy).toBe("Trimble");
  });
  it("applies Seb's ownership rule", () => {
    const c = parseOwnershipCheck('{"acquired":false,"ownership":"vc_backed","investment":"Series A, May 2026","skip_rule":"VC-backed, skip","evidence":"Raised a Series A in May 2026."}');
    const v = applyOwnershipCheck(base, "Rail fleet maintenance", c);
    expect(v.status).toBe("acquired");
    expect(v.reason).toBe("Your rule: VC-backed, skip. Raised a Series A in May 2026.");
    expect(v.facts.summary).toBe("Rail fleet maintenance, VC-backed, raised Series A, May 2026");
  });
  it("keeps the verdict but flags a check that did not run", () => {
    const v = applyOwnershipCheck(base, "Rail fleet maintenance", parseOwnershipCheck("no json here"));
    expect(v.status).toBe("software");
    expect(v.facts.confidence).toBe("low");
    expect(ownershipSummary("Rail fleet maintenance", null)).toBe("Rail fleet maintenance, acquisition check did not run");
  });
});
