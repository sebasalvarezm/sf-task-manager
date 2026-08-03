import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getAnthropicClient } from "@/lib/anthropic";

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json()) as { notes?: string; meetingTitle?: string; accountName?: string };
  if (!body.notes?.trim()) return NextResponse.json({ error: "Paste Granola notes first" }, { status: 400 });
  const client = getAnthropicClient();
  if (!client) return NextResponse.json({ error: "AI service not configured" }, { status: 503 });
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 700,
    messages: [{ role: "user", content: `Turn these Granola meeting notes into a proposed Salesforce call log. Preserve concrete facts and the user's straightforward language; avoid AI jargon, hype, and invented conclusions.

Meeting: ${body.meetingTitle ?? "Unknown"}
Salesforce account: ${body.accountName ?? "Unknown"}

Return ONLY JSON:
{
  "callType": "C1 or RCC",
  "commentary": "1-3 concise sentences covering outcome, key objection or signal, and agreed next step",
  "followUpDays": 7,
  "outcome": "short explicit outcome",
  "objections": ["specific objection"],
  "nextStep": "specific agreed follow-up"
}

Use null for followUpDays when no follow-up was agreed. C1 means first call; RCC means reconnect/catch-up call.

GRANOLA NOTES:
${body.notes.slice(0, 18000)}` }],
  });
  const text = message.content.filter((b) => b.type === "text").map((b) => b.type === "text" ? b.text : "").join("\n");
  try {
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text);
    return NextResponse.json({ suggestion: parsed });
  } catch {
    return NextResponse.json({ error: "Could not read the AI suggestion" }, { status: 502 });
  }
}
