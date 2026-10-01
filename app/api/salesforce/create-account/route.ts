import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { createAccount, AccountCreatePayload } from "@/lib/salesforce-accounts";
import { searchAccountsByName } from "@/lib/salesforce-calls";
import { normalizeDomain } from "@/lib/account-match";

type CreateAccountRequest = {
  companyName: string;
  website: string;
  yearEstablished?: string;
  employees?: number;
  industry?: string;
  country?: string;
  stateProvince?: string;
};

export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CreateAccountRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }

  if (!body.companyName || !body.website) {
    return NextResponse.json(
      { error: "Company name and website are required" },
      { status: 400 }
    );
  }

  try {
    // Duplicate guard, checked live at click time (the warning on the page
    // was computed when the enrichment ran and can be stale, e.g. after a
    // reload). If an account with this website already exists, don't create
    // a second one.
    if (normalizeDomain(body.website)) {
      const existing = await searchAccountsByName(body.website.trim());
      if (existing.length > 0) {
        return NextResponse.json(
          {
            error: `Already in Salesforce as "${existing[0].accountName}". Not created again.`,
            accountId: existing[0].accountId,
            accountUrl: existing[0].accountUrl,
          },
          { status: 409 },
        );
      }
    }

    const payload: AccountCreatePayload = {
      Name: body.companyName.trim(),
      Website: body.website.trim(),
      Group__c: "CDM",
      Stage__c: "Lead",
      Responded__c: "No",
    };

    if (body.yearEstablished) {
      payload.Year_Established__c = body.yearEstablished;
    }
    if (body.employees && body.employees > 0) {
      payload.NumberOfEmployees = body.employees;
    }
    if (body.industry) {
      payload.Industry = body.industry;
    }
    if (body.country) {
      payload.BillingCountry = body.country;
    }
    if (body.stateProvince) {
      payload.BillingState = body.stateProvince;
    }

    const result = await createAccount(payload);

    return NextResponse.json({
      success: true,
      accountId: result.id,
      accountUrl: result.url,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    if (message === "NOT_CONNECTED") {
      return NextResponse.json(
        { error: "Salesforce is not connected. Connect it and try again." },
        { status: 401 },
      );
    }
    if (message.includes("DUPLICATE")) {
      return NextResponse.json(
        { error: "An account with this name or website may already exist in Salesforce." },
        { status: 409 }
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
