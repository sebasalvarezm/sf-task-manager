import { enrichCompany } from "@/lib/enrichment";
import { findAccountByDomain } from "@/lib/salesforce-calls";

export type AccountFormData = {
  companyName: string;
  website: string;
  yearEstablished: string;
  employees: string;
  industry: string;
  country: string;
  stateProvince: string;
};

export type DuplicateMatch = {
  accountId: string;
  accountName: string;
  accountUrl: string;
};

export type EnrichedAccountItem = {
  url: string;
  enrichError: string | null;
  hasEnriched: boolean;
  confidence: "high" | "medium" | "low" | null;
  form: AccountFormData;
  duplicate: DuplicateMatch | null;
};

export type AccountsEnrichResult = {
  items: EnrichedAccountItem[];
};

function emptyForm(url: string): AccountFormData {
  return {
    companyName: "",
    website: url,
    yearEstablished: "",
    employees: "",
    industry: "",
    country: "",
    stateProvince: "",
  };
}

function extractDomain(raw: string): string {
  try {
    const withProtocol = raw.startsWith("http") ? raw : `https://${raw}`;
    return new URL(withProtocol).hostname.replace(/^www\./, "");
  } catch {
    return raw.trim();
  }
}

async function processOne(url: string): Promise<EnrichedAccountItem> {
  const trimmed = url.trim();
  const domain = extractDomain(trimmed);

  const [enrichRes, dupRes] = await Promise.allSettled([
    enrichCompany(trimmed),
    findAccountByDomain(domain),
  ]);

  let enrichError: string | null = null;
  let confidence: "high" | "medium" | "low" | null = null;
  let form = emptyForm(trimmed);

  if (enrichRes.status === "fulfilled") {
    const data = enrichRes.value;
    form = {
      companyName: data.companyName ?? "",
      website: data.website ?? trimmed,
      yearEstablished: data.yearEstablished ?? "",
      employees: data.employees != null ? String(data.employees) : "",
      industry: data.industry ?? "",
      country: data.country ?? "",
      stateProvince: data.stateProvince ?? "",
    };
    confidence = data.confidence ?? "medium";
  } else {
    enrichError = "Could not enrich this URL — you can fill in manually";
  }

  let duplicate: DuplicateMatch | null = null;
  if (dupRes.status === "fulfilled" && dupRes.value) {
    const m = dupRes.value;
    duplicate = {
      accountId: m.accountId,
      accountName: m.accountName,
      accountUrl: m.accountUrl,
    };
  }

  return {
    url: trimmed,
    enrichError,
    hasEnriched: true,
    confidence,
    form,
    duplicate,
  };
}

export async function runAccountsEnrichment({
  urls,
  onProgress,
}: {
  urls: string[];
  onProgress?: (state: { done: number; total: number }) => Promise<void> | void;
}): Promise<AccountsEnrichResult> {
  const validUrls = urls.map((u) => u.trim()).filter(Boolean);
  if (validUrls.length === 0) {
    return { items: [] };
  }

  const items: EnrichedAccountItem[] = [];
  let done = 0;
  for (const url of validUrls) {
    const item = await processOne(url);
    items.push(item);
    done += 1;
    if (onProgress) {
      try {
        await onProgress({ done, total: validUrls.length });
      } catch {
        /* ignore progress errors */
      }
    }
  }

  return { items };
}
