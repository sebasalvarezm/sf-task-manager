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

  const logs: string[] = [];

  try {
    // Run address extraction and outreach generation IN PARALLEL
    // (they don't depend on each other — saves ~15-20 seconds)
    logs.push("Finding company address...");

    const outreachLogs: string[] = [];

    const [address, outreachParagraph] = await Promise.all([
      extractAddress(anthropic, currentText, url),
      generateOutreach(anthropic, url, currentText, products, portfolioGroup, outreachLogs),
    ]);

    if (address) {
      logs.push(`Address found: ${address}`);
    } else {
      logs.push("Company address not found.");
    }

    // Append outreach logs (collected in parallel)
    logs.push(...outreachLogs);

    // Find restaurants (depends on address — must run after)
    let restaurants: { name: string; description: string }[] = [];
    if (address) {
      logs.push(`Searching for business dinner restaurants near ${address}...`);
      restaurants = await findRestaurants(anthropic, address);
      if (restaurants.length > 0) {
        logs.push(`Found ${restaurants.length} restaurant recommendation(s).`);
      } else {
        logs.push("Could not retrieve restaurant recommendations for this address.");
      }
    } else {
      logs.push("Skipping restaurant search \u2014 no address found.");
    }

    return NextResponse.json({
      address,
      restaurants,
      outreachParagraph,
      logs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message, logs }, { status: 500 });
  }
}

async function generateOutreach(
  client: Anthropic,
  url: string,
  currentText: string,
  products: string[],
  portfolioGroup: string | null,
  logs: string[]
): Promise<string | null> {
  if (!portfolioGroup) {
    logs.push("No portfolio group matched \u2014 skipping outreach paragraph.");
    return null;
  }

  logs.push("Drafting outreach paragraph...");
  const groups = loadGroupFiles();
  const fileName = findGroupFileName(portfolioGroup, groups);
  if (!fileName || !(fileName in groups)) {
    logs.push("Could not find group file for outreach template.");
    return null;
  }

  const baseOutreach = extractOutreachParagraph(groups[fileName]);
  if (!baseOutreach) {
    logs.push("No outreach template found in group file.");
    return null;
  }

  const result = await personalizeOutreach(client, baseOutreach, url, currentText, products);
  logs.push("Outreach paragraph complete.");
  return result;
}
