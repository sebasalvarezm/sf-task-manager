import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getAnthropicClient } from "@/lib/anthropic";
import fs from "fs";
import path from "path";

// Server-side cache so we don't re-query the same company name twice per session
const matchCache = new Map<string, { matched: boolean; group: string | null }>();

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

  const { accountName } = await request.json();

  if (!accountName || typeof accountName !== "string") {
    return NextResponse.json({ matched: false, group: null });
  }

  // Return cached result if available
  const cacheKey = accountName.toLowerCase().trim();
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

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: `You are classifying a software company into one of 9 industrial M&A portfolio groups.

Company name: "${accountName}"

Portfolio groups:
${groups}

Based on the company name, determine if this company likely sells software to one of these industrial verticals. Use your knowledge of real companies and industries — even if the name only partially hints at the industry (e.g. "Softree" → forestry, "Certainty" → compliance/safety, "AquaSpy" → agriculture/irrigation). Lean toward matching if there is a reasonable connection.

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
