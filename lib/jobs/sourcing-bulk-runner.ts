import { searchAccountsByName } from "@/lib/salesforce-calls";
import type { SourcingResult } from "@/lib/jobs/sourcing-runner";

// A bulk batch is capped so it stays within background-processing limits
// (each company takes 30-90s; see the per-company step design in the Inngest fn).
export const MAX_BULK_ENTRIES = 10;

// One row of a bulk sourcing run. `input` is the raw pasted line; `url` is what
// we resolved it to (null if unresolvable). `result` is the full sourcing
// output once the company has been processed (or reused from cache).
export type BulkSourcingItem = {
  input: string;
  url: string | null;
  resolvedFrom: "url" | "account";
  accountName?: string; // set when the input was a Salesforce account name
  cached: boolean; // true when a recent prior result was reused
  error: string | null; // set when the entry could not be resolved/processed
  result: SourcingResult | null;
};

export type BulkSourcingResult = { items: BulkSourcingItem[] };

// Heuristic: does a pasted line look like a URL/domain rather than an account
// name? URLs start with http(s), or are a single dotted token with no spaces
// (e.g. "acme.com", "www.acme.co.uk").
function looksLikeUrl(entry: string): boolean {
  const s = entry.trim();
  if (/^https?:\/\//i.test(s)) return true;
  if (!/\s/.test(s) && /\.[a-z]{2,}$/i.test(s)) return true;
  return false;
}

// Normalize a raw pasted blob (newline- or comma-separated) into a clean,
// deduped, capped list of entries. Shared shape used by both the UI (for the
// count/cap note) and the server (defensively).
export function parseEntries(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(/[\n,]/)) {
    const e = piece.trim();
    if (!e) continue;
    const key = e.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.slice(0, MAX_BULK_ENTRIES);
}

// Resolve each entry to a sourcing URL. URLs pass through; account names are
// looked up in Salesforce and resolved to the account's Website. Unresolvable
// entries get an `error` and are surfaced (they don't block the rest of the run).
export async function resolveEntries(
  entries: string[],
): Promise<BulkSourcingItem[]> {
  // Defensive re-normalize in case the caller passed raw/oversized input.
  const clean = parseEntries(entries.join("\n"));

  const items: BulkSourcingItem[] = [];
  for (const input of clean) {
    if (looksLikeUrl(input)) {
      items.push({
        input,
        url: input,
        resolvedFrom: "url",
        cached: false,
        error: null,
        result: null,
      });
      continue;
    }

    // Treat as a Salesforce account name.
    try {
      const matches = await searchAccountsByName(input);
      const withSite = matches.find((m) => m.website && m.website.trim());
      if (withSite && withSite.website) {
        items.push({
          input,
          url: withSite.website,
          resolvedFrom: "account",
          accountName: withSite.accountName,
          cached: false,
          error: null,
          result: null,
        });
      } else {
        items.push({
          input,
          url: null,
          resolvedFrom: "account",
          cached: false,
          error: `No Salesforce account with a website found for "${input}"`,
          result: null,
        });
      }
    } catch (err) {
      items.push({
        input,
        url: null,
        resolvedFrom: "account",
        cached: false,
        error:
          err instanceof Error
            ? `Salesforce lookup failed: ${err.message}`
            : "Salesforce lookup failed",
        result: null,
      });
    }
  }
  return items;
}
