import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/outreach", async (orig) => ({
  ...(await orig<typeof import("../lib/outreach")>()),
  outreachRequest: vi.fn(async () => new Response(JSON.stringify({ data: [{ attributes: { emailSignature: "<div>Mailbox sig</div>" } }] }), { status: 200 })),
}));

import { stepSignature, type SendSettings } from "../lib/e1-sends";

const settings: SendSettings = { dryRun: false, manualSend: false, sequenceMap: {}, signatureText: "", reviewWithModel: false, fillStep: true };

describe("stepSignature", () => {
  it("keeps Outreach's own signature block from the step 1 draft", async () => {
    const draft = '<p>Hi {{first_name}}, template</p><div><br/></div><div class="outreach-signature"><div>Sebastian Alvarez</div></div>';
    expect(await stepSignature(draft, settings)).toBe('<div><br/></div><div class="outreach-signature"><div>Sebastian Alvarez</div></div>');
  });
  it("falls back to the mailbox signature when the draft has none", async () => {
    expect(await stepSignature("<p>template only</p>", settings)).toBe('<div><br/></div><div class="outreach-signature"><div>Mailbox sig</div></div>');
  });
  it("uses the plain-text override when set", async () => {
    const out = await stepSignature('<div class="outreach-signature">x</div>', { ...settings, signatureText: "Seb\nValstone" });
    expect(out).toContain("Seb<br>Valstone");
    expect(out).not.toContain("outreach-signature");
  });
});
