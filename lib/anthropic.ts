import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

/**
 * Model tiers. Drafting: anything that writes in Seb's voice or reasons over
 * research (hooks, replies, one-pagers, anchor research). Extraction: pull a
 * fact out of text, classify, pick from a list; strict JSON answers where the
 * small model is as good and far cheaper. Override either from Vercel env
 * without a deploy: ANTHROPIC_MODEL_DRAFTING / ANTHROPIC_MODEL_EXTRACTION.
 */
/**
 * With the web search tool, Sonnet 5.5 wraps sentences in <cite index='..'>
 * tags inside its text. They are for the API's citation feature, not for
 * people, so every search-backed answer goes through this before use.
 */
export function stripCites(text: string): string {
  return text.replace(/<\/?cite\b[^>]*>/gi, "").replace(/[ \t]{2,}/g, " ").trim();
}

export const MODELS = {
  drafting: process.env.ANTHROPIC_MODEL_DRAFTING?.trim() || "claude-sonnet-5-5",
  extraction: process.env.ANTHROPIC_MODEL_EXTRACTION?.trim() || "claude-haiku-5-5",
} as const;
