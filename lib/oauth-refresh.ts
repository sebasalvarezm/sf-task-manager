// Shared rule for what to do when an OAuth token refresh fails.
//
// Only a definitive "this refresh token is dead" answer (expired, revoked,
// consent withdrawn) should delete the saved connection and force a manual
// reconnect. A 5xx, a 429 rate limit or any other hiccup is temporary: keep
// the connection and let the user retry, instead of silently logging them
// out of Salesforce / Outlook / Outreach.

export async function isDeadRefreshToken(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 401) return false;
  const body = (await response.text().catch(() => "")).toLowerCase();
  return (
    body.includes("invalid_grant") ||
    body.includes("interaction_required") ||
    body.includes("consent_required")
  );
}

export function transientRefreshError(provider: string, status: number): Error {
  return new Error(
    `Couldn't refresh the ${provider} connection right now (${provider} returned HTTP ${status}). Try again in a minute.`,
  );
}
