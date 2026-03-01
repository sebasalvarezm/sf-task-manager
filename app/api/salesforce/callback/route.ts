import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

// Salesforce sends the user here after they log in and approve access.
// We exchange the temporary code for real tokens and save them to Supabase.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  if (error) {
    return NextResponse.redirect(
      `${appUrl}/?sf_error=${encodeURIComponent(error)}`
    );
  }

  if (!code) {
    return NextResponse.redirect(`${appUrl}/?sf_error=missing_code`);
  }

  const consumerKey = process.env.SF_CONSUMER_KEY;
  const consumerSecret = process.env.SF_CONSUMER_SECRET;
  const callbackUrl = process.env.SF_CALLBACK_URL;

  if (!consumerKey || !consumerSecret || !callbackUrl) {
    return NextResponse.redirect(
      `${appUrl}/?sf_error=missing_env_vars`
    );
  }

  // Exchange the authorization code for tokens
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: consumerKey,
    client_secret: consumerSecret,
    redirect_uri: callbackUrl,
  });

  const tokenResponse = await fetch(
    "https://login.salesforce.com/services/oauth2/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }
  );

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text();
    console.error("Token exchange failed:", errText);
    return NextResponse.redirect(
      `${appUrl}/?sf_error=token_exchange_failed`
    );
  }

  const tokenData = await tokenResponse.json();

  // Extract the Salesforce User ID from the identity URL
  // The `id` field looks like: https://login.salesforce.com/id/00D.../005...
  const salesforceUserId = tokenData.id
    ? (tokenData.id as string).split("/").pop() ?? null
    : null;

  // Save tokens to Supabase (upsert = insert if not exists, update if exists)
  const supabase = getSupabaseAdmin();
  const { error: dbError } = await supabase.from("sf_credentials").upsert({
    id: "default",
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    instance_url: tokenData.instance_url,
    salesforce_user_id: salesforceUserId,
    token_issued_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (dbError) {
    console.error("Failed to save tokens:", dbError);
    return NextResponse.redirect(
      `${appUrl}/?sf_error=db_save_failed`
    );
  }

  return NextResponse.redirect(`${appUrl}/?sf_connected=true`);
}
