// Shared role vocabulary for the two-password login.
//
// Deliberately has NO imports: this module is used by both `middleware.ts`
// (Edge runtime, cannot touch `next/headers`) and `lib/auth.ts` (Node).
//
// - "admin"  = the APP_PASSWORD holder. Full access, exactly as before.
// - "intern" = the INTERN_PASSWORD holder. Sourcing tool only.

export type Role = "admin" | "intern";

export const SESSION_COOKIE = "sf_task_mgr_session";

/** How long a login lasts. Matches the cookie maxAge set at login. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

// ---------------------------------------------------------------------------
// Signed session cookie
// ---------------------------------------------------------------------------
//
// The cookie used to be a fixed word ("authenticated" / "intern"). The repo is
// public, so anyone could set that cookie by hand and skip the password. It is
// now `<role>.<expiresAtSeconds>.<signature>`, where the signature is an
// HMAC-SHA256 keyed on APP_PASSWORD. Without the password nobody can mint a
// valid cookie, and changing APP_PASSWORD signs everyone out.
//
// Uses Web Crypto (globalThis.crypto.subtle), available in both the Edge
// runtime (middleware) and Node 18+ (API routes).

function signingSecret(): string | null {
  const secret = process.env.APP_PASSWORD;
  return secret ? `sf-task-manager-session-v1|${secret}` : null;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Cookie value for a fresh login. Throws if APP_PASSWORD is not set. */
export async function cookieValueForRole(
  role: Role,
  nowMs: number = Date.now(),
): Promise<string> {
  const secret = signingSecret();
  if (!secret) throw new Error("APP_PASSWORD not configured");
  const expires = Math.floor(nowMs / 1000) + SESSION_MAX_AGE_SECONDS;
  const payload = `${role}.${expires}`;
  return `${payload}.${await hmacHex(secret, payload)}`;
}

/** The role a cookie proves, or null if it is missing, forged or expired. */
export async function roleFromCookieValue(
  value?: string,
  nowMs: number = Date.now(),
): Promise<Role | null> {
  if (!value) return null;
  const secret = signingSecret();
  if (!secret) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [role, expiresRaw, signature] = parts;
  if (role !== "admin" && role !== "intern") return null;
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires * 1000 <= nowMs) return null;
  const expected = await hmacHex(secret, `${role}.${expiresRaw}`);
  return constantTimeEqual(signature, expected) ? role : null;
}

// ---------------------------------------------------------------------------
// Intern allow-lists — the single place to widen or narrow intern access.
// ---------------------------------------------------------------------------

/** Pages an intern may load. "/" is matched exactly; the rest by prefix. */
export const INTERN_PAGES: readonly string[] = ["/", "/sourcing"];

/** API prefixes an intern may call. */
export const INTERN_APIS: readonly string[] = [
  "/api/auth/logout",
  "/api/sourcing/",
  "/api/jobs",
];

/** Background job kinds an intern may launch via /api/jobs/start. */
export const INTERN_JOB_KINDS: readonly string[] = ["sourcing", "sourcing_bulk"];

export function internCanAccess(pathname: string): boolean {
  if (pathname === "/") return true;
  return (
    INTERN_PAGES.some((p) => p !== "/" && pathname.startsWith(p)) ||
    INTERN_APIS.some((p) => pathname.startsWith(p))
  );
}
