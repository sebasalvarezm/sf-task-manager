import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getValidCredentials } from "@/lib/token-manager";
import { sfFetch, sfErrorText, assertSalesforceId } from "@/lib/sf-query";
import { OPPORTUNITY_STAGES, type OpportunityStage } from "@/lib/salesforce-stats";

export const dynamic = "force-dynamic";

/** PATCH { opportunityId, stage } moves a BRO to another pipeline stage in Salesforce. */
export async function PATCH(request: NextRequest) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { opportunityId?: string; stage?: string };
    const id = assertSalesforceId(body.opportunityId, "opportunity id");
    const stage = (OPPORTUNITY_STAGES as readonly string[]).includes(body.stage ?? "") ? (body.stage as OpportunityStage) : null;
    if (!stage) return NextResponse.json({ error: `Stage must be one of ${OPPORTUNITY_STAGES.join(", ")}.` }, { status: 400 });
    const credentials = await getValidCredentials();
    if (!credentials) return NextResponse.json({ error: "Salesforce isn't connected." }, { status: 409 });
    const response = await sfFetch(
      `/services/data/v62.0/sobjects/Opportunity/${id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ StageName: stage }) },
      credentials,
    );
    if (!response.ok && response.status !== 204) {
      return NextResponse.json({ error: `Salesforce refused the move: ${await sfErrorText(response)}` }, { status: 502 });
    }
    return NextResponse.json({ ok: true, opportunityId: id, stage });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error" }, { status: 500 });
  }
}
