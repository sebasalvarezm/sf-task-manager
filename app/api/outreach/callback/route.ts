import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

// Outreach sends the user here after they log in and approve access.
// We exchange the code for tokens and save them to Supabase.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  if (error) {
    return NextResponse.redirect(
      `${appUrl}/?outreach_error=${encodeURIComponent(error)}`
    );
  }

  if (!code) {
    return NextResponse.redirect(`${appUrl}/?outreach_error=missing_code`);
  }

  const clientId = process.env.OUTREACH_CLIENT_ID;
  const clientSecret = process.env.OUTREACH_CLIENT_SECRET;
  const callbackUrl = process.env.OUTREACH_CALLBACK_URL;

  if (!clientId || !clientSecret || !callbackUrl) {
    return NextResponse.redirect(
      `${appUrl}/?outreach_error=missing_env_vars`
    );
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: callbackUrl,
  });

  const tokenResponse = await fetch("https://api.outreach.io/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text();
    console.error("Outreach token exchange failed:", errText);
    return NextResponse.redirect(
      `${appUrl}/?outreach_error=token_exchange_failed`
    );
  }

  const tokenData = await tokenResponse.json();

  const supabase = getSupabaseAdmin();
  const { error: dbError } = await supabase.from("outreach_credentials").upsert({
    id: "default",
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    token_issued_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (dbError) {
    console.error("Failed to save Outreach tokens:", dbError);
    return NextResponse.redirect(`${appUrl}/?outreach_error=db_save_failed`);
  }

  return NextResponse.redirect(`${appUrl}/?outreach_connected=true`);
}
