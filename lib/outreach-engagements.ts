import { getOutreachValidCredentials, OutreachCredentials } from "./outreach";

const OUTREACH_API_BASE = "https://api.outreach.io/api/v2";

// ── Authenticated Outreach fetch (mirrors lib/outreach.ts:outreachFetch) ─────

async function outreachFetch(
  credentials: OutreachCredentials,
  path: string
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${OUTREACH_API_BASE}${path}`;
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${credentials.access_token}`,
      "Content-Type": "application/vnd.api+json",
    },
  });
}

// Follow JSON:API `links.next` pagination until exhausted or cap reached.
async function paginate<T>(
  credentials: OutreachCredentials,
  initialPath: string,
  extractRows: (body: JsonApiBody) => T[],
  maxPages: number = 20
): Promise<T[]> {
  const all: T[] = [];
  let next: string | null = initialPath;
  let pages = 0;

  while (next && pages < maxPages) {
    const res = await outreachFetch(credentials, next);
    if (!res.ok) {
      if (res.status === 401) throw new Error("OUTREACH_NOT_CONNECTED");
      throw new Error(`Outreach request failed: ${await res.text()}`);
    }
    const body = (await res.json()) as JsonApiBody;
    all.push(...extractRows(body));
    next = body.links?.next ?? null;
    pages++;
  }

  return all;
}

type JsonApiBody = {
  data?: Array<{
    id: string;
    type?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, { data?: { id?: string; type?: string } | null }>;
  }>;
  links?: { next?: string };
};

// ── Types ────────────────────────────────────────────────────────────────────

// A single delivered mailing with its open/click counts.
// Outreach's /mailings resource exposes openCount and clickCount as
// first-class attributes. (replyCount is NOT on the mailing resource,
// so we track engagement via opens only — an "open rate" heatmap.)
export type MailingWithEngagement = {
  mailingId: string;
  prospectId: string;
  sentAt: string;       // deliveredAt (or createdAt fallback), ISO timestamp
  state: string;
  openCount: number;
  clickCount: number;
};

export type MailingFetchResult = {
  mailings: MailingWithEngagement[];
  rawCount: number;      // total mailing records returned by Outreach
  stateBreakdown: Record<string, number>; // how many of each state
  withDeliveredAt: number; // how many had deliveredAt populated
  withProspectId: number;  // how many had a prospect relationship populated
  countFilteredByMailbox: number; // skipped because not from an allowed mailbox
  // Date diagnostics: helps us see why records get filtered out.
  earliestCreatedAt: string | null;
  latestCreatedAt: string | null;
  countInRange: number;
  countBeforeRange: number;
  countAfterRange: number;
  sampleDates: string[]; // first 5 createdAt values we saw
  sampleRelationshipKeys: string[]; // keys on the first record's relationships object
};

// ── Mailings (send events + per-mailing open counts) ─────────────────────────
//
// NOTE: We do NOT use filter[createdAt] on the Outreach query — the date
// range syntax has been returning zero results regardless of format (with
// Z, without Z, filter[deliveredAt], filter[createdAt]). Instead we fetch
// mailings newest-first with no date filter and stop paginating once we
// pass the window. This is robust to Outreach's filter-syntax quirks.
//
// Trade-off: if the selected range is very old and the org has a huge
// volume of newer mailings, we could hit MAX_PAGES before reaching the
// range. In practice 3k mailings is plenty for the CDM team.

const MAX_PAGES = 30; // up to 3,000 mailings

export async function fetchMailingsWithEngagement(
  start: string,   // yyyy-MM-dd
  end: string,     // yyyy-MM-dd
  allowedMailboxIds?: Set<string> // if provided, skip mailings not from these mailboxes
): Promise<MailingFetchResult> {
  const credentials = await getOutreachValidCredentials();
  if (!credentials) throw new Error("OUTREACH_NOT_CONNECTED");

  const startMs = new Date(`${start}T00:00:00Z`).getTime();
  const endMs = new Date(`${end}T23:59:59Z`).getTime();

  const mailings: MailingWithEngagement[] = [];
  const stateBreakdown: Record<string, number> = {};
  let rawCount = 0;
  let withDeliveredAt = 0;
  let withProspectId = 0;
  let countFilteredByMailbox = 0;

  // Date diagnostics
  let earliestCreatedAt: string | null = null;
  let latestCreatedAt: string | null = null;
  let countInRange = 0;
  let countBeforeRange = 0;
  let countAfterRange = 0;
  const sampleDates: string[] = [];
  let sampleRelationshipKeys: string[] = [];

  // Drop sparse fieldset — it may be stripping the `prospect` relationship.
  const initialPath =
    `/mailings?page[size]=100` +
    `&sort=-createdAt`;

  let next: string | null = initialPath;
  let pages = 0;

  while (next && pages < MAX_PAGES) {
    const res = await outreachFetch(credentials, next);
    if (!res.ok) {
      if (res.status === 401) throw new Error("OUTREACH_NOT_CONNECTED");
      throw new Error(`Outreach request failed: ${await res.text()}`);
    }
    const body = (await res.json()) as JsonApiBody;

    for (const row of body.data ?? []) {
      rawCount++;
      const createdAt = (row.attributes?.createdAt as string | null) ?? null;
      if (!createdAt) continue;

      if (sampleDates.length < 5) sampleDates.push(createdAt);
      if (!earliestCreatedAt || createdAt < earliestCreatedAt)
        earliestCreatedAt = createdAt;
      if (!latestCreatedAt || createdAt > latestCreatedAt)
        latestCreatedAt = createdAt;

      // Capture relationship keys from the FIRST record so we can see what
      // Outreach actually returns.
      if (sampleRelationshipKeys.length === 0 && row.relationships) {
        sampleRelationshipKeys = Object.keys(row.relationships);
      }

      const state = (row.attributes?.state as string) ?? "unknown";
      stateBreakdown[state] = (stateBreakdown[state] ?? 0) + 1;

      const deliveredAt = (row.attributes?.deliveredAt as string | null) ?? null;
      if (deliveredAt) withDeliveredAt++;

      const createdMs = new Date(createdAt).getTime();

      if (createdMs < startMs) {
        countBeforeRange++;
        continue;
      }
      if (createdMs > endMs) {
        countAfterRange++;
        continue;
      }
      countInRange++;

      // Restrict to mailings sent from one of the CDM team's mailboxes
      // (if a filter set was provided). Non-CDM sends are excluded.
      if (allowedMailboxIds && allowedMailboxIds.size > 0) {
        const mailboxId = row.relationships?.mailbox?.data?.id;
        if (!mailboxId || !allowedMailboxIds.has(mailboxId)) {
          countFilteredByMailbox++;
          continue;
        }
      }

      const prospectId = row.relationships?.prospect?.data?.id;
      if (prospectId) withProspectId++;

      // Fallback prospectId: if the relationship isn't populated, use the
      // mailing's own id as a synthetic key. Opens against the same mailing
      // still group together, but multi-mailing prospect aggregation won't
      // work without the real prospect relationship.
      const effectiveProspectId = prospectId ?? `mailing:${row.id}`;

      mailings.push({
        mailingId: row.id,
        prospectId: effectiveProspectId,
        sentAt: deliveredAt ?? createdAt,
        state,
        openCount: Number(row.attributes?.openCount) || 0,
        clickCount: Number(row.attributes?.clickCount) || 0,
      });
    }

    next = body.links?.next ?? null;
    pages++;
  }

  return {
    mailings,
    rawCount,
    stateBreakdown,
    withDeliveredAt,
    withProspectId,
    countFilteredByMailbox,
    earliestCreatedAt,
    latestCreatedAt,
    countInRange,
    countBeforeRange,
    countAfterRange,
    sampleDates,
    sampleRelationshipKeys,
  };
}

// ── CDM team mailbox lookup ──────────────────────────────────────────────────
//
// Fetch Outreach mailboxes and their owning users in one call, then return
// the subset of mailbox IDs whose owning user's full name matches one of
// the CDM owner names. Used to filter mailings to sends from the CDM team.

export type CdmMailboxResult = {
  mailboxIds: Set<string>;
  matched: string[];    // which owner names found a mailbox
  unmatched: string[];  // which didn't (so we can surface in debug)
};

export async function fetchCdmMailboxIds(
  ownerNames: readonly string[]
): Promise<CdmMailboxResult> {
  const credentials = await getOutreachValidCredentials();
  if (!credentials) throw new Error("OUTREACH_NOT_CONNECTED");

  // `include=user` sideloads the owning user for each mailbox in the same
  // response (JSON:API's `included` block), so we don't need a second call.
  const mailboxIds = new Set<string>();
  const matchedSet = new Set<string>();
  const wantedLower = new Map(
    ownerNames.map((n) => [n.toLowerCase(), n])
  );

  let next: string | null = "/mailboxes?include=user&page[size]=100";
  let pages = 0;

  while (next && pages < 5) {
    const res = await outreachFetch(credentials, next);
    if (!res.ok) {
      if (res.status === 401) throw new Error("OUTREACH_NOT_CONNECTED");
      throw new Error(`fetchCdmMailboxIds failed: ${await res.text()}`);
    }
    const body = (await res.json()) as {
      data?: Array<{
        id: string;
        relationships?: { user?: { data?: { id?: string } | null } };
      }>;
      included?: Array<{
        id: string;
        type?: string;
        attributes?: { firstName?: string; lastName?: string };
      }>;
      links?: { next?: string };
    };

    // Build userId -> fullName map from the included block
    const userNameById = new Map<string, string>();
    for (const inc of body.included ?? []) {
      if (inc.type !== "user") continue;
      const full = `${inc.attributes?.firstName ?? ""} ${inc.attributes?.lastName ?? ""}`
        .trim()
        .toLowerCase();
      userNameById.set(inc.id, full);
    }

    for (const mb of body.data ?? []) {
      const userId = mb.relationships?.user?.data?.id;
      if (!userId) continue;
      const full = userNameById.get(userId);
      if (!full) continue;
      if (wantedLower.has(full)) {
        mailboxIds.add(mb.id);
        matchedSet.add(wantedLower.get(full)!);
      }
    }

    next = body.links?.next ?? null;
    pages++;
  }

  const matched = Array.from(matchedSet);
  const unmatched = ownerNames.filter((n) => !matchedSet.has(n));
  return { mailboxIds, matched, unmatched };
}

// ── Batched prospect lookups (name + company) ────────────────────────────────

export type ProspectInfo = {
  id: string;
  firstName: string;
  lastName: string;
  company: string;
  email: string;
};

export async function fetchProspectsByIds(
  prospectIds: string[]
): Promise<Map<string, ProspectInfo>> {
  const result = new Map<string, ProspectInfo>();
  if (prospectIds.length === 0) return result;

  const credentials = await getOutreachValidCredentials();
  if (!credentials) throw new Error("OUTREACH_NOT_CONNECTED");

  const unique = Array.from(new Set(prospectIds.filter((id) => !!id)));
  const CHUNK_SIZE = 50;

  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    const chunk = unique.slice(i, i + CHUNK_SIZE);
    try {
      const filter = encodeURIComponent(chunk.join(","));
      const res = await outreachFetch(
        credentials,
        `/prospects?filter[id]=${filter}&page[size]=${chunk.length}`
      );
      if (!res.ok) continue;
      const body = (await res.json()) as {
        data?: Array<{
          id: string;
          attributes?: {
            firstName?: string;
            lastName?: string;
            company?: string;
            emails?: string[];
          };
        }>;
      };
      for (const row of body.data ?? []) {
        result.set(row.id, {
          id: row.id,
          firstName: row.attributes?.firstName ?? "",
          lastName: row.attributes?.lastName ?? "",
          company: row.attributes?.company ?? "",
          email: (row.attributes?.emails ?? [])[0] ?? "",
        });
      }
    } catch {
      // skip chunk on failure
    }
  }

  return result;
}
