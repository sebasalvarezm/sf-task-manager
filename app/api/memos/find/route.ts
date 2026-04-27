import { NextResponse, NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { findMemoForAccount } from "@/lib/microsoft";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const accountName = req.nextUrl.searchParams.get("accountName") ?? "";
  if (!accountName.trim()) {
    return NextResponse.json({ error: "Missing accountName" }, { status: 400 });
  }
  try {
    const memo = await findMemoForAccount(accountName);
    return NextResponse.json({ memo });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message === "MS_NOT_CONNECTED") {
      return NextResponse.json({ memo: null, msConnected: false });
    }
    console.error("memos/find error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
