import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getValidCredentials } from "@/lib/token-manager";

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const credentials = await getValidCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "NOT_CONNECTED" }, { status: 401 });
  }

  try {
    const response = await fetch(
      `${credentials.instance_url}/services/data/v62.0/sobjects/Account/describe/`,
      { headers: { Authorization: `Bearer ${credentials.access_token}` } }
    );

    if (!response.ok) {
      const err = await response.text();
      return NextResponse.json({ error: `Describe failed: ${err}` }, { status: 500 });
    }

    const data = await response.json();

    // Extract active picklist labels for a given field API name
    function getPicklist(fieldName: string): string[] {
      const field = data.fields?.find(
        (f: { name: string }) => f.name === fieldName
      );
      if (!field || !Array.isArray(field.picklistValues)) return [];
      return field.picklistValues
        .filter((v: { active: boolean }) => v.active)
        .map((v: { label: string }) => v.label);
    }

    return NextResponse.json({
      industry: getPicklist("Industry"),
      stateProvince: getPicklist("BillingState"), // empty if State/Country picklists not enabled
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
