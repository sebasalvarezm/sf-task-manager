import { isDeadRefreshToken, transientRefreshError } from "./oauth-refresh";
import { getSupabaseAdmin, SfCredentials } from "./supabase";

// How long (in minutes) before we proactively refresh the access token.
// Salesforce tokens last 2 hours by default; we refresh after 100 minutes.
const REFRESH_THRESHOLD_MINUTES = 100;

export async function getValidCredentials(): Promise<SfCredentials | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("sf_credentials")
    .select("*")
    .eq("id", "default")
    .single();

  if (error || !data) return null;

  const credentials = data as SfCredentials;

  // Check if the token is old enough to need refreshing
  const issuedAt = new Date(credentials.token_issued_at);
  const ageMinutes = (Date.now() - issuedAt.getTime()) / 1000 / 60;

  if (ageMinutes > REFRESH_THRESHOLD_MINUTES) {
    return await refreshAccessToken(credentials);
  }

  return credentials;
}

/**
 * Refresh now, whatever the token's age. Used when Salesforce rejects a token
 * early with 401 INVALID_SESSION_ID (org session timeout shorter than our
 * 100-minute schedule, or a revoked session). Returns null when the
 * connection is gone and the user has to reconnect.
 */
let refreshInFlight: Promise<SfCredentials | null> | null = null;

export async function forceRefreshCredentials(): Promise<SfCredentials | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sf_credentials")
    .select("*")
    .eq("id", "default")
    .single();
  if (error || !data) return null;
  const credentials = data as SfCredentials;

  // Several calls often hit the same expired token at once (parallel queries,
  // query pages). If another call refreshed in the last minute, use its token
  // instead of refreshing again; and share one refresh within this instance.
  const ageSeconds = (Date.now() - new Date(credentials.token_issued_at).getTime()) / 1000;
  if (ageSeconds < 60) return credentials;
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken(credentials).finally(() => {
      refreshInFlight = null;
    });
  }
  return await refreshInFlight;
}

async function refreshAccessToken(
  credentials: SfCredentials
): Promise<SfCredentials | null> {
  const consumerKey = process.env.SF_CONSUMER_KEY;
  const consumerSecret = process.env.SF_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    throw new Error("Missing Salesforce consumer key/secret in environment.");
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: consumerKey,
    client_secret: consumerSecret,
    refresh_token: credentials.refresh_token,
  });

  const response = await fetch(
    "https://login.salesforce.com/services/oauth2/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }
  );

  if (!response.ok) {
    // Only a dead refresh token means "reconnect". Anything else (5xx, 429)
    // is temporary, so keep the saved connection.
    if (!(await isDeadRefreshToken(response))) {
      throw transientRefreshError("Salesforce", response.status);
    }
    const supabase = getSupabaseAdmin();
    await supabase.from("sf_credentials").delete().eq("id", "default");
    return null;
  }

  const tokenData = await response.json();

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sf_credentials")
    .update({
      access_token: tokenData.access_token,
      token_issued_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", "default")
    .select()
    .single();

  if (error || !data) return null;
  return data as SfCredentials;
}
