import { NextRequest, NextResponse } from "next/server";
import { getSessionCookieName, getSessionCookieValue } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const { password } = await request.json();

  if (!process.env.APP_PASSWORD) {
    return NextResponse.json(
      { error: "APP_PASSWORD not configured in environment" },
      { status: 500 }
    );
  }

  if (password !== process.env.APP_PASSWORD) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const response = NextResponse.json({ success: true });
  response.cookies.set(getSessionCookieName(), getSessionCookieValue(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: "/",
  });

  return response;
}
