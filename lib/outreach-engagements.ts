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
  sentAt: string;       // deliveredAt, ISO timestamp
  openCount: number;
  clickCount: number;
};

// ── Mailings (send events + per-mailing open counts) ─────────────────────────

export async function fetchMailingsWithEngagement(
  start: string,   // yyyy-MM-dd
  end: string      // yyyy-MM-dd
): Promise<MailingWithEngagement[]> {
  const credentials = await getOutreachValidCredentials();
  if (!credentials) throw new Error("OUTREACH_NOT_CONNECTED");

  const startIso = `${start}T00:00:00Z`;
  const endIso = `${end}T23:59:59Z`;

  // filter[deliveredAt]=>=start..<=end is the Outreach range syntax.
  const path =
    `/mailings?filter[deliveredAt]=${encodeURIComponent(`${startIso}..${endIso}`)}` +
    `&filter[state]=delivered` +
    `&fields[mailing]=deliveredAt,openCount,clickCount` +
    `&page[size]=100` +
    `&sort=deliveredAt`;

  return paginate<MailingWithEngagement>(credentials, path, (body) => {
    const out: MailingWithEngagement[] = [];
    for (const row of body.data ?? []) {
      const prospectId = row.relationships?.prospect?.data?.id;
      const sentAt = row.attributes?.deliveredAt as string | undefined;
      if (!prospectId || !sentAt) continue;
      out.push({
        mailingId: row.id,
        prospectId,
        sentAt,
        openCount: Number(row.attributes?.openCount) || 0,
        clickCount: Number(row.attributes?.clickCount) || 0,
      });
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
