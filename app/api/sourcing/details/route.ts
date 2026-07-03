import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getAnthropicClient } from "@/lib/anthropic";
import Anthropic from "@anthropic-ai/sdk";
import {
  extractAddress,
  findRestaurants,
  quickCompanyName,
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
    const sourceCompanyName = quickCompanyName(url);

    const [addressInfo, outreachParagraph] = await Promise.all([
      extractAddress(anthropic, currentText, url, sourceCompanyName),
      generateOutreach(anthropic, url, currentText, products, portfolioGroup, outreachLogs),
    ]);

    let address = addressInfo.address;
    let addressSource = addressInfo.source;
    let addressSourceUrl = addressInfo.sourceUrl;
    let locationConfidence = addressInfo.confidence;
    if (address) {
      logs.push(`Address found: ${address}`);
    } else {
      logs.push(
        "Company address not found yet — the restaurant search will also try to locate the city."
      );
    }

    // Append outreach logs (collected in parallel)
    logs.push(...outreachLogs);

    // Always attempt a restaurant search; the company name lets it find a city
    // even when no address was resolved.
    logs.push("Searching for business dinner restaurants...");
    const restaurantResult = await findRestaurants(
      anthropic,
      address,
      sourceCompanyName,
    );
    const restaurants = restaurantResult.restaurants;
    if (restaurants.length > 0) {
      logs.push(`Found ${restaurants.length} restaurant recommendation(s).`);
    } else {
      logs.push("Could not retrieve restaurant recommendations.");
    }

    // Address rescue: if address extraction failed but the restaurant search
    // located the company's city, keep that city so the result always shows
    // at least "City, ST".
    if (!address && restaurantResult.city) {
      address = restaurantResult.city;
      addressSource = "web search (restaurant lookup)";
      addressSourceUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        restaurantResult.city
      )}`;
      locationConfidence = "city";
      logs.push(`City located via restaurant search: ${address}`);
    } else if (!address) {
      logs.push("Company location not found — even after all web searches.");
    }

    // Identify competitors (runs in parallel with restaurants, doesn't depend on address)
    logs.push("Identifying key competitors...");
    let competitors: { name: string; differentiator: string }[] = [];
    try {
      competitors = await identifyCompetitors(anthropic, currentText, products);
      if (competitors.length > 0) {
        logs.push(`Found ${competitors.length} competitor(s): ${competitors.map((c) => c.name).join(", ")}`);
      } else {
        logs.push("Could not identify specific competitors.");
      }
    } catch {
      logs.push("Competitor analysis failed — continuing.");
    }

    return NextResponse.json({
      address,
      addressSource,
      addressSourceUrl,
      locationConfidence,
      restaurants,
      outreachParagraph,
      competitors,
      logs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message, logs }, { status: 500 });
  }
}

async function identifyCompetitors(
  client: Anthropic,
  currentText: string,
  products: string[]
): Promise<{ name: string; differentiator: string }[]> {
  const productList = products.length > 0 ? products.join(", ") : "unknown";

  const resp = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: `Based on this company's website content, identify 2-3 key competitors or similar companies in their space.

COMPANY WEBSITE (excerpt):
${currentText.slice(0, 4000)}

PRODUCTS/SERVICES: ${productList}

Return a JSON array only (no markdown, no explanation):
[{"name":"Competitor Name","differentiator":"One sentence on how they differ or compete"}]

If you can't identify competitors with reasonable confidence, return [].`,
      },
    ],
  });

  const text = resp.content[0].type === "text" ? resp.content[0].text : "";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const parsed = JSON.parse(cleaned) as { name: string; differentiator: string }[];
  return (parsed ?? []).slice(0, 3);
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
