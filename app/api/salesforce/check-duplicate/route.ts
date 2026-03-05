import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { findAccountByDomain } from "@/lib/salesforce-calls";

function extractDomain(raw: string): string {
  try {
    const withProtocol = raw.startsWith("http") ? raw : `https://${raw}`;
    const hostname = new URL(withProtocol).hostname;
    return hostname.replace(/^www\./, "");
  } catch {
    return raw.trim();
  }
}

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url).searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url param" }, { status: 400 });
  }

  const domain = extractDomain(url);

  try {
    const match = await findAccountByDomain(domain);
    return NextResponse.json({
      duplicate: match
        ? { accountId: match.accountId, accountName: match.accountName, accountUrl: match.accountUrl }
        : null,
    });
  } catch {
    return NextResponse.json({ duplicate: null });
  }
}
