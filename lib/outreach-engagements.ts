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
};

// ── Mailings (send events + per-mailing open counts) ─────────────────────────

export async function fetchMailingsWithEngagement(
  start: string,   // yyyy-MM-dd
  end: string      // yyyy-MM-dd
): Promise<MailingFetchResult> {
  const credentials = await getOutreachValidCredentials();
  if (!credentials) throw new Error("OUTREACH_NOT_CONNECTED");

  // Outreach date range syntax uses `..` with NO trailing Z — the Z suffix
  // appears to silently match nothing. createdAt is more reliable than
  // deliveredAt because it's always populated; we filter by state / presence
  // of deliveredAt in the client.
  const startIso = `${start}T00:00:00`;
  const endIso = `${end}T23:59:59`;

  const path =
    `/mailings?filter[createdAt]=${encodeURIComponent(`${startIso}..${endIso}`)}` +
    `&fields[mailing]=deliveredAt,createdAt,state,openCount,clickCount` +
    `&page[size]=100` +
    `&sort=createdAt`;

  const mailings: MailingWithEngagement[] = [];
  const stateBreakdown: Record<string, number> = {};
  let rawCount = 0;
  let withDeliveredAt = 0;

  const rows = await paginate<{
    id: string;
    prospectId: string;
    deliveredAt: string | null;
    createdAt: string | null;
    state: string;
    openCount: number;
    clickCount: number;
  }>(credentials, path, (body) => {
    const out: {
      id: string;
      prospectId: string;
      deliveredAt: string | null;
      createdAt: string | null;
      state: string;
      openCount: number;
      clickCount: number;
    }[] = [];
    for (const row of body.data ?? []) {
      const prospectId = row.relationships?.prospect?.data?.id;
      if (!prospectId) continue;
      out.push({
        id: row.id,
        prospectId,
        deliveredAt: (row.attributes?.deliveredAt as string | null) ?? null,
        createdAt: (row.attributes?.createdAt as string | null) ?? null,
        state: (row.attributes?.state as string) ?? "unknown",
        openCount: Number(row.attributes?.openCount) || 0,
        clickCount: Number(row.attributes?.clickCount) || 0,
      });
    }
    return out;
  });

  for (const r of rows) {
    rawCount++;
    stateBreakdown[r.state] = (stateBreakdown[r.state] ?? 0) + 1;
    if (r.deliveredAt) withDeliveredAt++;

    // Accept any mailing that has either deliveredAt OR a "sent-ish" state.
    // We prefer deliveredAt as sentAt, falling back to createdAt.
    const sentAt = r.deliveredAt ?? r.createdAt;
    if (!sentAt) continue;

    mailings.push({
      mailingId: r.id,
      prospectId: r.prospectId,
      sentAt,
      state: r.state,
      openCount: r.openCount,
      clickCount: r.clickCount,
    });
  }

  return { mailings, rawCount, stateBreakdown, withDeliveredAt };
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
