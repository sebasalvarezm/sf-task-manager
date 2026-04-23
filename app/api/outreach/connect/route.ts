import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";

// Redirects to Outreach.io OAuth login.
// After the user approves, Outreach sends them back to /api/outreach/callback.
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.OUTREACH_CLIENT_ID;
  const callbackUrl = process.env.OUTREACH_CALLBACK_URL;

  if (!clientId || !callbackUrl) {
    return NextResponse.json(
      { error: "Missing OUTREACH_CLIENT_ID or OUTREACH_CALLBACK_URL in environment" },
      { status: 500 }
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: callbackUrl,
    scope:
      "accounts.all prospects.all sequences.read sequenceStates.all mailboxes.read mailings.all users.read events.read",
  });

  const authUrl = `https://api.outreach.io/oauth/authorize?${params.toString()}`;
  return NextResponse.redirect(authUrl);
}
