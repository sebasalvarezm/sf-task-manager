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

export type MailingSend = {
  mailingId: string;
  prospectId: string;
  sentAt: string;       // ISO timestamp
};

export type EngagementEvent = {
  prospectId: string;
  mailingId: string | null;
  type: "open" | "reply";
  eventAt: string;      // ISO timestamp
};

// ── Mailings (send events) ───────────────────────────────────────────────────

// Fetches every mailing whose `deliveredAt` falls within [start, end].
// Pagination-safe. Returns only delivered mailings with a prospect attached.
export async function fetchSendEvents(
  start: string,   // yyyy-MM-dd
  end: string      // yyyy-MM-dd
): Promise<MailingSend[]> {
  const credentials = await getOutreachValidCredentials();
  if (!credentials) throw new Error("OUTREACH_NOT_CONNECTED");

  const startIso = `${start}T00:00:00Z`;
  const endIso = `${end}T23:59:59Z`;

  // Outreach filter syntax: filter[deliveredAt]=>=2026-01-01..<=2026-02-01
  const path =
    `/mailings?filter[deliveredAt]=${encodeURIComponent(`${startIso}..${endIso}`)}` +
    `&filter[state]=delivered` +
    `&page[size]=100` +
    `&sort=deliveredAt`;

  return paginate<MailingSend>(credentials, path, (body) => {
    const out: MailingSend[] = [];
    for (const row of body.data ?? []) {
      const prospectId = row.relationships?.prospect?.data?.id;
      const sentAt = row.attributes?.deliveredAt as string | undefined;
      if (!prospectId || !sentAt) continue;
      out.push({
        mailingId: row.id,
        prospectId,
        sentAt,
      });
    }
    return out;
  });
}

// ── Engagement events (opens + replies) ──────────────────────────────────────

// Pulls all open + reply events in [start, end].
// NB: Outreach exposes these as `mailboxEvents` with `type` values like
// "mailing_opened" and "mailing_replied_to" on some API versions. The
// cleanest universal approach is to query `/events` with a type filter.
export async function fetchOpenAndReplyEvents(
  start: string,
  end: string
): Promise<EngagementEvent[]> {
  const credentials = await getOutreachValidCredentials();
  if (!credentials) throw new Error("OUTREACH_NOT_CONNECTED");

  const startIso = `${start}T00:00:00Z`;
  const endIso = `${end}T23:59:59Z`;

  const path =
    `/events?filter[eventAt]=${encodeURIComponent(`${startIso}..${endIso}`)}` +
    `&filter[type]=${encodeURIComponent("mailing_opened,mailing_replied_to")}` +
    `&page[size]=100` +
    `&sort=eventAt`;

  return paginate<EngagementEvent>(credentials, path, (body) => {
    const out: EngagementEvent[] = [];
    for (const row of body.data ?? []) {
      const type = row.attributes?.type as string | undefined;
      const eventAt = row.attributes?.eventAt as string | undefined;
      const prospectId = row.relationships?.prospect?.data?.id;
      const mailingId = row.relationships?.mailing?.data?.id ?? null;
      if (!type || !eventAt || !prospectId) continue;

      let normalized: "open" | "reply" | null = null;
      if (type === "mailing_opened") normalized = "open";
      else if (type === "mailing_replied_to") normalized = "reply";
      if (!normalized) continue;

      out.push({ prospectId, mailingId, type: normalized, eventAt });
    }
    return out;
  });
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
