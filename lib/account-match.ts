/**
 * Ranking and query parsing for Salesforce account lookups.
 *
 * Salesforce's `Name LIKE '%x%'` returns every account whose name merely
 * contains the letters, sorted alphabetically. For a short name like "ITS"
 * that buries the real account under BrigitSolutions, Business Exits, ...
 * These helpers make the lookup deterministic: exact name first, then
 * starts-with, then whole-word, then contains. A pasted URL is matched on
 * the account's Website domain instead of its name.
 */

export type MatchableAccount = {
  accountId: string;
  accountName: string;
  website: string | null;
};

export type AccountQuery =
  | { kind: "name"; name: string }
  | { kind: "domain"; domain: string; raw: string };

/** Lower-case host without scheme, "www.", path, port or query string. */
export function normalizeDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  let host = value.trim().toLowerCase();
  if (!host) return null;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  host = host.replace(/^\/\//, "");
  host = host.split(/[/?#]/)[0] ?? "";
  host = host.split("@").pop() ?? "";
  host = host.split(":")[0] ?? "";
  host = host.replace(/^www\d*\./, "");
  host = host.replace(/\.+$/, "");
  if (!host || !host.includes(".")) return null;
  if (/\s/.test(host)) return null;
  return host;
}

/** Decide whether the user typed a company name or a website / URL. */
export function parseAccountQuery(raw: string): AccountQuery {
  const trimmed = raw.trim();
  const looksLikeUrl =
    /^(https?:\/\/|www\.)/i.test(trimmed) ||
    (!/\s/.test(trimmed) && /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed));
  if (looksLikeUrl) {
    const domain = normalizeDomain(trimmed);
    if (domain) return { kind: "domain", domain, raw: trimmed };
  }
  return { kind: "name", name: trimmed };
}

function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/** Letters and digits only: "Track'em" -> "trackem", "ITS Ltd." -> "itsltd". */
function squash(value: string): string {
  return fold(value).replace(/[^a-z0-9]/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lower is better. 0 and 1 are "this is the account", 2+ are suggestions. */
export function scoreNameMatch(query: string, accountName: string): number {
  const q = fold(query);
  const n = fold(accountName);
  if (!q) return 9;
  if (n === q) return 0;
  if (squash(n) === squash(q)) return 1;
  if (n.startsWith(q)) return 2;
  if (new RegExp(`(^|[^a-z0-9])${escapeRegExp(q)}([^a-z0-9]|$)`, "i").test(n)) return 3;
  if (n.includes(q)) return 4;
  if (squash(n).includes(squash(q))) return 5;
  return 9;
}

export function scoreDomainMatch(domain: string, website: string | null): number {
  const site = normalizeDomain(website);
  if (!site) return 9;
  if (site === domain) return 0;
  // Sub-domain either way: app.acme.com vs acme.com
  if (site.endsWith(`.${domain}`) || domain.endsWith(`.${site}`)) return 1;
  return 9;
}

export function rankAccounts<T extends MatchableAccount>(
  query: AccountQuery,
  accounts: T[],
): Array<T & { matchScore: number }> {
  const scored = accounts.map((account) => ({
    ...account,
    matchScore:
      query.kind === "domain"
        ? scoreDomainMatch(query.domain, account.website)
        : scoreNameMatch(query.name, account.accountName),
  }));
  const typed = query.kind === "name" ? query.name.trim() : "";
  const exactCase = (name: string) => (typed && name.trim() === typed ? 0 : 1);
  return scored
    .filter((account) => account.matchScore < 9)
    .sort(
      (a, b) =>
        a.matchScore - b.matchScore ||
        exactCase(a.accountName) - exactCase(b.accountName) ||
        a.accountName.length - b.accountName.length ||
        a.accountName.localeCompare(b.accountName),
    );
}

/**
 * The single account the query unambiguously means, or null.
 * - one account with the best score of 0 or 1 → that account
 * - otherwise, exactly one candidate in total → that account
 * - otherwise null (caller shows the ranked candidates)
 */
export function pickAccount<T extends MatchableAccount>(
  query: AccountQuery,
  accounts: T[],
): { account: T | null; candidates: Array<T & { matchScore: number }> } {
  const ranked = rankAccounts(query, accounts);
  if (ranked.length === 0) return { account: null, candidates: [] };
  const best = ranked[0];
  if (best.matchScore <= 1) {
    const ties = ranked.filter((a) => a.matchScore === best.matchScore);
    if (ties.length === 1) return { account: best, candidates: ranked };
    // Two accounts with the same exact name: ambiguous, let the user choose.
    return { account: null, candidates: ranked };
  }
  if (ranked.length === 1) return { account: best, candidates: ranked };
  return { account: null, candidates: ranked };
}

export function escapeSoql(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** SOQL WHERE clause that pulls every plausible candidate for one query. */
export function accountWhereClause(query: AccountQuery): string {
  if (query.kind === "domain") {
    const bare = escapeSoql(query.domain);
    return `Website LIKE '%${bare}%'`;
  }
  const name = escapeSoql(query.name);
  return `(Name = '${name}' OR Name LIKE '%${name}%')`;
}
