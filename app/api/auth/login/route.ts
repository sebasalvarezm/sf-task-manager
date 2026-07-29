import { NextRequest, NextResponse } from "next/server";
import { getSessionCookieName, getSessionCookieValue } from "@/lib/auth";
import type { Role } from "@/lib/roles";

export async function POST(request: NextRequest) {
  const { password } = await request.json();

  if (!process.env.APP_PASSWORD) {
    return NextResponse.json(
      { error: "APP_PASSWORD not configured in environment" },
      { status: 500 }
    );
  }

  // Non-empty check on the submitted password AND on the configured intern
  // password, so a blank/unset INTERN_PASSWORD can never let anyone in.
  const submitted = typeof password === "string" ? password : "";
  const internPassword = process.env.INTERN_PASSWORD || "";

  let role: Role;
  if (submitted && submitted === process.env.APP_PASSWORD) {
    role = "admin";
  } else if (submitted && internPassword && submitted === internPassword) {
    role = "intern";
  } else {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const response = NextResponse.json({ success: true, role });
  response.cookies.set(getSessionCookieName(), getSessionCookieValue(role), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: "/",
  });

  return response;
}
