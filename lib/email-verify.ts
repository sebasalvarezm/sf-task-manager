/**
 * QuickEmailVerification, one address at a time, same service Seb uses by hand.
 * Key lives in Vercel as QUICKEMAILVERIFICATION_API_KEY.
 *
 * Verdicts the pipeline acts on:
 *   valid      -> proceed
 *   accept_all -> flag yellow, Seb decides (the domain accepts anything, so the address is unproven)
 *   unknown    -> flag yellow, Seb decides
 *   invalid / disposable / role -> flag red, pick another contact
 *   error      -> the service failed; flag yellow and let Seb retry
 */
export type VerifyResult = "valid" | "invalid" | "unknown" | "accept_all" | "role" | "disposable" | "error";

export type VerifyDetail = {
  result: VerifyResult;
  reason: string | null;
  raw: Record<string, unknown> | null;
};

export function isVerifyConfigured(): boolean {
  return Boolean(process.env.QUICKEMAILVERIFICATION_API_KEY);
}

export async function verifyEmail(email: string): Promise<VerifyDetail> {
  const key = process.env.QUICKEMAILVERIFICATION_API_KEY;
  if (!key) return { result: "error", reason: "QUICKEMAILVERIFICATION_API_KEY is not set in Vercel.", raw: null };
  try {
    const url = `https://api.quickemailverification.com/v1/verify?email=${encodeURIComponent(email)}&apikey=${encodeURIComponent(key)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !raw) return { result: "error", reason: `Verifier answered ${res.status}.`, raw };
    return { result: interpret(raw), reason: typeof raw.reason === "string" ? raw.reason : null, raw };
  } catch (err) {
    return { result: "error", reason: err instanceof Error ? err.message : "Verifier unreachable.", raw: null };
  }
}

/** Map the service's fields to one verdict. Exported for tests. */
export function interpret(raw: Record<string, unknown>): VerifyResult {
  const truthy = (v: unknown) => v === true || v === "true";
  const result = typeof raw.result === "string" ? raw.result : "unknown";
  if (truthy(raw.disposable)) return "disposable";
  if (truthy(raw.role)) return "role";
  if (result === "invalid") return "invalid";
  if (truthy(raw.accept_all)) return "accept_all";
  if (result === "valid") return "valid";
  return "unknown";
}

export function verifyLabel(result: VerifyResult | null | undefined): string {
  switch (result) {
    case "valid": return "Email verified";
    case "accept_all": return "Catch-all domain, unproven";
    case "unknown": return "Could not verify";
    case "invalid": return "Email invalid";
    case "role": return "Role address (info@, sales@)";
    case "disposable": return "Disposable address";
    case "error": return "Verifier error";
    default: return "Not verified yet";
  }
}
