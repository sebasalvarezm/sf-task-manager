import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

// Microsoft sends the user here after they log in and approve access.
// We exchange the temporary code for real tokens and save them to Supabase.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  if (error) {
    return NextResponse.redirect(
      `${appUrl}/calls?ms_error=${encodeURIComponent(error)}`
    );
  }

  if (!code) {
    return NextResponse.redirect(`${appUrl}/calls?ms_error=missing_code`);
  }

  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  const callbackUrl = process.env.MS_CALLBACK_URL;

  if (!clientId || !clientSecret || !callbackUrl) {
    return NextResponse.redirect(`${appUrl}/calls?ms_error=missing_env_vars`);
  }

  // Exchange the authorization code for tokens
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: callbackUrl,
    scope: "Calendars.Read Mail.Send User.Read offline_access",
  });

  const tenantId = process.env.MS_TENANT_ID ?? "common";
  const tokenResponse = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }
  );

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text();
    console.error("Microsoft token exchange failed:", errText);
    return NextResponse.redirect(
      `${appUrl}/calls?ms_error=token_exchange_failed`
    );
  }

  const tokenData = await tokenResponse.json();

  // Save tokens to Supabase (upsert = insert if not exists, update if exists)
  const supabase = getSupabaseAdmin();
  const { error: dbError } = await supabase.from("ms_credentials").upsert({
    id: "default",
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    token_issued_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (dbError) {
    console.error("Failed to save Microsoft tokens:", dbError);
    return NextResponse.redirect(`${appUrl}/calls?ms_error=db_save_failed`);
  }

  return NextResponse.redirect(`${appUrl}/calls?ms_connected=true`);
}
