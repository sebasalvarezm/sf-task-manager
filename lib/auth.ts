import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  cookieValueForRole,
  roleFromCookieValue,
  type Role,
} from "./roles";

export type { Role };

/** The signed-in role, or null when there is no valid session. */
export async function getRole(): Promise<Role | null> {
  const cookieStore = await cookies();
  return roleFromCookieValue(cookieStore.get(SESSION_COOKIE)?.value);
}

/**
 * True for BOTH admin and intern sessions.
 *
 * Intentional: the ~52 API routes that call this only need to know "is there a
 * real session". Per-role restriction happens in `middleware.ts`, which blocks
 * intern requests before they ever reach a non-Sourcing route.
 */
export async function isAuthenticated(): Promise<boolean> {
  return (await getRole()) !== null;
}

export async function isAdmin(): Promise<boolean> {
  return (await getRole()) === "admin";
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}

export function getSessionCookieValue(role: Role = "admin"): string {
  return cookieValueForRole(role);
}
