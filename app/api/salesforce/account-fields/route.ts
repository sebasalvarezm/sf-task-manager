import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { updateAccount, type AccountFieldUpdate } from "@/lib/salesforce-accounts";
import {
  parseYearInput,
  parseEmployeesInput,
  parseCountryInput,
} from "@/lib/outreach-quality";

export const dynamic = "force-dynamic";

type Body = {
  accountId?: unknown;
  yearEstablished?: unknown;
  employees?: unknown;
  country?: unknown;
};

// Backfills the three fields the outreach quality ("BS") score reads, for an
// account where Salesforce is blank. Used by the fix-it inputs in the flagged
// email list: the sender finds the real value and pushes it here.
//
// `isAdmin` rather than `isAuthenticated` — this writes to the CRM, and /stats
// is admin-only anyway.
export async function POST(req: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  const accountId =
    typeof body?.accountId === "string" ? body.accountId.trim() : "";

  // Salesforce ids are 15 or 18 alphanumeric characters.
  if (!/^[a-zA-Z0-9]{15,18}$/.test(accountId)) {
    return NextResponse.json({ error: "Invalid accountId" }, { status: 400 });
  }

  const fields: AccountFieldUpdate = {};
  const rejected: string[] = [];

  if (body?.yearEstablished != null && body.yearEstablished !== "") {
    const year = parseYearInput(String(body.yearEstablished));
    if (year) fields.Year_Established__c = year;
    else rejected.push("year founded must be a 4-digit year");
  }

  if (body?.employees != null && body.employees !== "") {
    const employees = parseEmployeesInput(
      typeof body.employees === "number" ? body.employees : String(body.employees)
    );
    if (employees) fields.NumberOfEmployees = employees;
    else rejected.push("employee count must be a whole number above zero");
  }

  if (body?.country != null && body.country !== "") {
    const country = parseCountryInput(String(body.country));
    if (country) fields.BillingCountry = country;
    else rejected.push("country must be between 1 and 80 characters");
  }

  if (rejected.length > 0) {
    return NextResponse.json({ error: rejected.join("; ") }, { status: 400 });
  }
  if (Object.keys(fields).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  try {
    await updateAccount(accountId, fields);
    return NextResponse.json({ ok: true, updated: fields });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message === "NOT_CONNECTED") {
      return NextResponse.json({ error: "NOT_CONNECTED" }, { status: 403 });
    }
    // Surfaced verbatim on purpose. BillingCountry is free text here, so an org
    // with State & Country Picklists enabled rejects unrecognised countries with
    // INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST — the sender needs to see that,
    // not a generic failure.
    console.error("account-fields route error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
