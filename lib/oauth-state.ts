import { NextRequest, NextResponse } from "next/server";

// CSRF protection for the three OAuth connect flows (Salesforce, Microsoft,
// Outreach). Connect stores a random value in a short-lived cookie and sends
// the same value to the provider as `state`; the callback only saves tokens
// when the two match. Without this, anyone could finish an OAuth login with
// their own account and overwrite the app's shared "default" connection.

export type OAuthProvider = "salesforce" | "microsoft" | "outreach";

const cookieName = (provider: OAuthProvider) => `oauth_state_${provider}`;

function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Redirect to the provider's consent page with a fresh `state`. */
export function redirectToOAuth(
  provider: OAuthProvider,
  authorizeUrl: string,
  params: URLSearchParams,
): NextResponse {
  const state = randomState();
  params.set("state", state);
  const response = NextResponse.redirect(`${authorizeUrl}?${params.toString()}`);
  response.cookies.set(cookieName(provider), state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/",
  });
  return response;
}

/** True when the callback's `state` matches the cookie set by connect. */
export function oauthStateMatches(request: NextRequest, provider: OAuthProvider): boolean {
  const expected = request.cookies.get(cookieName(provider))?.value;
  const actual = request.nextUrl.searchParams.get("state");
  if (!expected || !actual || expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}

/** Clear the one-time state cookie on whatever response the callback returns. */
export function clearOAuthState(response: NextResponse, provider: OAuthProvider): NextResponse {
  response.cookies.delete(cookieName(provider));
  return response;
}
