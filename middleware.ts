import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, internCanAccess, roleFromCookieValue } from "@/lib/roles";

// Protect every page except the login page and auth API routes.
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always allow: login page, auth API, OAuth callbacks,
  // and /api/inngest (Inngest validates requests via signing-key headers itself)
  const publicPaths = [
    "/login",
    "/api/auth/",
    "/api/salesforce/callback",
    "/api/microsoft/callback",
    "/api/outreach/callback",
    "/api/triage",
    "/api/inngest",
  ];

  const isPublic = publicPaths.some((p) => pathname.startsWith(p));
  if (isPublic) return NextResponse.next();

  const role = roleFromCookieValue(request.cookies.get(SESSION_COOKIE)?.value);

  if (role === null) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Interns are allow-listed to the Sourcing tool only. This is the real
  // enforcement point: the individual API routes only check "is there a
  // session", so anything not listed in lib/roles.ts must be stopped here.
  if (role === "intern" && !internCanAccess(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
