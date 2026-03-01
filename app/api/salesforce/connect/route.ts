import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";

// Redirects the user to the Salesforce OAuth login page.
// After the user approves access, Salesforce sends them back to /api/salesforce/callback.
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const consumerKey = process.env.SF_CONSUMER_KEY;
  const callbackUrl = process.env.SF_CALLBACK_URL;

  if (!consumerKey || !callbackUrl) {
    return NextResponse.json(
      { error: "Missing SF_CONSUMER_KEY or SF_CALLBACK_URL in environment" },
      { status: 500 }
    );
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: consumerKey,
    redirect_uri: callbackUrl,
    scope: "api refresh_token offline_access",
  });

  const authUrl = `https://login.salesforce.com/services/oauth2/authorize?${params.toString()}`;
  return NextResponse.redirect(authUrl);
}
