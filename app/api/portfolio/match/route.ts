import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getAnthropicClient } from "@/lib/anthropic";
import fs from "fs";
import path from "path";

// Server-side cache so we don't re-query the same company name twice per session
const matchCache = new Map<string, { matched: boolean; group: string | null }>();

// Fetch a plain-text summary of a company's website via Jina AI Reader (free, no API key)
// Jina renders the page like a browser and returns clean readable text — works on SPAs too
async function fetchWebsiteText(url: string): Promise<string | null> {
  try {
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    const jinaUrl = `https://r.jina.ai/${normalized}`;
    const res = await fetch(jinaUrl, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "text/plain" },
    });
    const text = await res.text();
    // First 800 chars is plenty to understand what the company does
    return text.trim().slice(0, 800) || null;
  } catch {
    return null;
  }
}

function loadGroupDescriptions(): string {
  const groupsDir = path.join(process.cwd(), "content", "groups");
  const files = fs.readdirSync(groupsDir).filter((f) => f.endsWith(".md") && f !== "CLAUDE.md");

  return files
    .map((file) => {
      const content = fs.readFileSync(path.join(groupsDir, file), "utf-8");
      // Include full file content (overview + core outreach) for richer matching context
      return content
        .split("\n")
        .filter((l) => l.trim() !== "---")
        .join("\n")
        .trim();
    })
    .join("\n\n");
}

export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { accountName, accountWebsite } = await request.json();

  if (!accountName || typeof accountName !== "string") {
    return NextResponse.json({ matched: false, group: null });
  }

  // Return cached result if available (versioned so prompt changes invalidate old results)
  const CACHE_VERSION = "v6";
  const cacheKey = `${CACHE_VERSION}_${accountName.toLowerCase().trim()}`;
  if (matchCache.has(cacheKey)) {
    return NextResponse.json(matchCache.get(cacheKey));
  }

  // If no API key or client unavailable, return gracefully
  const anthropic = getAnthropicClient();
  if (!anthropic) {
    return NextResponse.json({ matched: false, group: null, unavailable: true });
  }

  try {
    const groups = loadGroupDescriptions();

    // Try to fetch website content for richer context (best-effort)
    const websiteText = accountWebsite ? await fetchWebsiteText(accountWebsite) : null;

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: `You are classifying a software company into one of 9 industrial M&A portfolio groups.

Company name: "${accountName}"
${accountWebsite ? `Company website URL: "${accountWebsite}"` : ""}
${websiteText ? `\nCompany description:\n"${websiteText}"\n` : ""}
Portfolio groups:
${groups}

Based on the company name${accountWebsite ? ", website URL," : ""}${websiteText ? " and website content" : ""} determine if this company sells software to one of these industrial verticals. Use all available signals — the domain name itself is often a strong clue (e.g. trashflow.com → waste, crewtracks.com → construction crews). Lean toward matching if there is a reasonable connection.

Respond with ONLY valid JSON, no explanation:
- If it fits a group: {"matched": true, "group": "exact group title from above"}
- If it does not fit any group: {"matched": false, "group": null}`,
        },
      ],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text.trim() : "";

    // Parse the JSON response, fall back to no-match if invalid
    let result: { matched: boolean; group: string | null } = {
      matched: false,
      group: null,
    };

    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.matched === "boolean") {
        result = { matched: parsed.matched, group: parsed.group ?? null };
      }
    } catch {
      // Claude returned something unexpected — treat as no match
    }

    matchCache.set(cacheKey, result);
    return NextResponse.json(result);
  } catch {
    // API error (no credits, network issue, etc.) — return gracefully, don't crash
    return NextResponse.json({ matched: false, group: null, unavailable: true });
  }
}
