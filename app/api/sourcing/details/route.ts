import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getAnthropicClient } from "@/lib/anthropic";
import Anthropic from "@anthropic-ai/sdk";
import {
  extractAddress,
  findRestaurants,
  loadGroupFiles,
  extractOutreachParagraph,
  personalizeOutreach,
  findGroupFileName,
} from "@/lib/scout";

export const maxDuration = 55;

export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const anthropic = getAnthropicClient();
  if (!anthropic) {
    return NextResponse.json(
      { error: "AI service not configured" },
      { status: 500 }
    );
  }

  const { url, currentText, products, portfolioGroup } =
    (await request.json()) as {
      url: string;
      currentText: string;
      products: string[];
      portfolioGroup: string | null;
    };

  if (!url) {
    return NextResponse.json({ error: "Missing URL" }, { status: 400 });
  }

  try {
    // Run address extraction and outreach generation in parallel
    const [address, outreachParagraph] = await Promise.all([
      extractAddress(anthropic, currentText, url),
      generateOutreach(anthropic, url, currentText, products, portfolioGroup),
    ]);

    // Find restaurants (depends on address)
    let restaurants: { name: string; description: string }[] = [];
    if (address) {
      restaurants = await findRestaurants(anthropic, address);
    }

    return NextResponse.json({
      address,
      restaurants,
      outreachParagraph,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function generateOutreach(
  client: Anthropic,
  url: string,
  currentText: string,
  products: string[],
  portfolioGroup: string | null
): Promise<string | null> {
  if (!portfolioGroup) return null;

  const groups = loadGroupFiles();
  const fileName = findGroupFileName(portfolioGroup, groups);
  if (!fileName || !(fileName in groups)) return null;

  const baseOutreach = extractOutreachParagraph(groups[fileName]);
  if (!baseOutreach) return null;

  return personalizeOutreach(client, baseOutreach, url, currentText, products);
}
