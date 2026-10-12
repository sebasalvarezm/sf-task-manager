import { describe, expect, it } from "vitest";
import { composeHtmlBody, extractSignatureHtml, extractSignatureText, htmlToText, textToHtml } from "../lib/outlook-signature";

describe("outlook signature", () => {
  it("lifts the Signature div out of a sent email, dropping cid images", () => {
    const html = `<html><body><div>Hi Niko,<br>Understood.<br><br>Best,<br>Sebastian</div><div id="Signature"><div><b>Sebastian Alvarez</b></div><div>Director, M&amp;A | Valstone</div><img src="cid:image001.png@01D" width="100"><div><a href="https://valstone.com">valstone.com</a></div></div><div id="divRplyFwdMsg">From: Niko</div></body></html>`;
    const sig = extractSignatureHtml(html)!;
    expect(sig).toContain("Sebastian Alvarez");
    expect(sig).toContain("valstone.com");
    expect(sig).not.toContain("cid:");
    expect(sig).not.toContain("From: Niko");
  });
  it("returns null without a Signature div", () => {
    expect(extractSignatureHtml("<div>Hi<br>Best,<br>Sebastian</div>")).toBeNull();
  });
  it("falls back to the text under the sign-off", () => {
    const text = "Hi Niko,\n\nUnderstood.\n\nBest,\nSebastian\n\nSebastian Alvarez\nDirector, M&A | Valstone\n+1 514 555 0100\n\nFrom: Niko Zorkin\nSent: Monday";
    expect(extractSignatureText(text)).toBe("Sebastian Alvarez\nDirector, M&A | Valstone\n+1 514 555 0100");
  });
  it("turns a plain draft into HTML and appends the signature", () => {
    const html = composeHtmlBody("Hi Niko,\n\nUnderstood & noted.\n\nBest,\nSebastian", "<div><b>Sebastian Alvarez</b></div>");
    expect(html).toContain("<p style=\"margin:0 0 1em 0\">Hi Niko,</p>");
    expect(html).toContain("Understood &amp; noted.");
    expect(html).toContain("Best,<br>Sebastian");
    expect(html.endsWith("<div><div><b>Sebastian Alvarez</b></div></div>")).toBe(true);
  });
  it("round-trips text", () => {
    expect(htmlToText(textToHtml("a\nb\n\nc"))).toBe("a\nb\n\nc");
  });
});
