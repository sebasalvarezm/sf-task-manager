import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";

// Redirects the user to the Microsoft OAuth login page.
// After the user approves access, Microsoft sends them back to /api/microsoft/callback.
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.MS_CLIENT_ID;
  const callbackUrl = process.env.MS_CALLBACK_URL;

  if (!clientId || !callbackUrl) {
    return NextResponse.json(
      { error: "Missing MS_CLIENT_ID or MS_CALLBACK_URL in environment" },
      { status: 500 }
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: callbackUrl,
    response_mode: "query",
    scope: "Calendars.Read Mail.Send User.Read offline_access",
    prompt: "select_account",
  });

  const tenantId = process.env.MS_TENANT_ID ?? "common";
  const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
  return NextResponse.redirect(authUrl);
}
