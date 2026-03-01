import { NextRequest, NextResponse } from "next/server";

// Protect every page except the login page and auth API routes.
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always allow: login page, auth API, Salesforce OAuth callback
  const publicPaths = [
    "/login",
    "/api/auth/",
    "/api/salesforce/callback",
  ];

  const isPublic = publicPaths.some((p) => pathname.startsWith(p));
  if (isPublic) return NextResponse.next();

  const session = request.cookies.get("sf_task_mgr_session");
  if (session?.value !== "authenticated") {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
