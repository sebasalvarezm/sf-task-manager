import { cookies } from "next/headers";

const SESSION_COOKIE = "sf_task_mgr_session";
const SESSION_VALUE = "authenticated";

export async function isAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE);
  return session?.value === SESSION_VALUE;
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}

export function getSessionCookieValue(): string {
  return SESSION_VALUE;
}
