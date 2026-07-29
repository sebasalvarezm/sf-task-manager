// Shared role vocabulary for the two-password login.
//
// Deliberately has NO imports: this module is used by both `middleware.ts`
// (Edge runtime, cannot touch `next/headers`) and `lib/auth.ts` (Node).
//
// - "admin"  = the APP_PASSWORD holder. Full access, exactly as before.
// - "intern" = the INTERN_PASSWORD holder. Sourcing tool only.

export type Role = "admin" | "intern";

export const SESSION_COOKIE = "sf_task_mgr_session";

// Admin keeps the original literal value so existing sessions stay signed in.
export const ADMIN_COOKIE_VALUE = "authenticated";
export const INTERN_COOKIE_VALUE = "intern";

export function cookieValueForRole(role: Role): string {
  return role === "admin" ? ADMIN_COOKIE_VALUE : INTERN_COOKIE_VALUE;
}

export function roleFromCookieValue(value?: string): Role | null {
  if (value === ADMIN_COOKIE_VALUE) return "admin";
  if (value === INTERN_COOKIE_VALUE) return "intern";
  return null;
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
