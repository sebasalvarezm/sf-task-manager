import { getSupabaseAdmin } from "./supabase";

// Outreach.io access tokens last 2 hours; refresh after 90 minutes.
const REFRESH_THRESHOLD_MINUTES = 90;
const OUTREACH_API_BASE = "https://api.outreach.io/api/v2";

export type OutreachCredentials = {
  id: string;
  access_token: string;
  refresh_token: string;
  token_issued_at: string;
  updated_at: string;
};

// ── Token management ─────────────────────────────────────────────────────────

export async function getOutreachValidCredentials(): Promise<OutreachCredentials | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("outreach_credentials")
    .select("*")
    .eq("id", "default")
    .single();

  if (error || !data) return null;

  const credentials = data as OutreachCredentials;

  const issuedAt = new Date(credentials.token_issued_at);
  const ageMinutes = (Date.now() - issuedAt.getTime()) / 1000 / 60;

  if (ageMinutes > REFRESH_THRESHOLD_MINUTES) {
    return await refreshOutreachToken(credentials);
  }

  return credentials;
}

async function refreshOutreachToken(
  credentials: OutreachCredentials
): Promise<OutreachCredentials | null> {
  const clientId = process.env.OUTREACH_CLIENT_ID;
  const clientSecret = process.env.OUTREACH_CLIENT_SECRET;
  const callbackUrl = process.env.OUTREACH_CALLBACK_URL;

  if (!clientId || !clientSecret || !callbackUrl) {
    throw new Error("Missing OUTREACH_CLIENT_ID, OUTREACH_CLIENT_SECRET, or OUTREACH_CALLBACK_URL");
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: callbackUrl,
    refresh_token: credentials.refresh_token,
  });

  const response = await fetch("https://api.outreach.io/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const supabase = getSupabaseAdmin();
    await supabase.from("outreach_credentials").delete().eq("id", "default");
    return null;
  }

  const tokenData = await response.json();

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outreach_credentials")
    .update({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token ?? credentials.refresh_token,
      token_issued_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", "default")
    .select()
    .single();

  if (error || !data) return null;
  return data as OutreachCredentials;
}

// ── Helper: authenticated Outreach fetch ─────────────────────────────────────

async function outreachFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const credentials = await getOutreachValidCredentials();
  if (!credentials) throw new Error("OUTREACH_NOT_CONNECTED");

  const url = path.startsWith("http") ? path : `${OUTREACH_API_BASE}${path}`;

  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${credentials.access_token}`,
      "Content-Type": "application/vnd.api+json",
    },
  });
}

// ── Sequences ────────────────────────────────────────────────────────────────

export type OutreachSequence = {
  id: string;
  name: string;
  tags: string[];
  enabled: boolean;
};

export async function listSequences(): Promise<OutreachSequence[]> {
  const all: OutreachSequence[] = [];
  let next: string | null = "/sequences?page[size]=100";

  while (next) {
    const res: Response = await outreachFetch(next);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Outreach listSequences failed: ${err}`);
    }
    const body = (await res.json()) as {
      data?: Array<{
        id: string;
        attributes?: { name?: string; tags?: string[]; enabled?: boolean };
      }>;
      links?: { next?: string };
    };

    for (const row of body.data ?? []) {
      all.push({
        id: row.id,
        name: row.attributes?.name ?? "(unnamed)",
        tags: row.attributes?.tags ?? [],
        enabled: row.attributes?.enabled ?? true,
      });
    }
    next = body.links?.next ?? null;
  }

  return all;
}

// ── Mailboxes ────────────────────────────────────────────────────────────────

export type OutreachMailbox = {
  id: string;
  email: string;
};

export async function listMailboxes(): Promise<OutreachMailbox[]> {
  const res = await outreachFetch("/mailboxes?page[size]=100");
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Outreach listMailboxes failed: ${err}`);
  }
  const body = (await res.json()) as {
    data?: Array<{ id: string; attributes?: { email?: string } }>;
  };
  return (body.data ?? []).map((row) => ({
    id: row.id,
    email: row.attributes?.email ?? "",
  }));
}

// ── Prospects ────────────────────────────────────────────────────────────────

export type OutreachProspect = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  title: string;
};

export async function findProspectByEmail(
  email: string
): Promise<OutreachProspect | null> {
  const res = await outreachFetch(
    `/prospects?filter[emails]=${encodeURIComponent(email)}&page[size]=1`
  );
  if (!res.ok) return null;
  const body = (await res.json()) as {
    data?: Array<{
      id: string;
      attributes?: {
        firstName?: string;
        lastName?: string;
        emails?: string[];
        title?: string;
      };
    }>;
  };
  const row = (body.data ?? [])[0];
  if (!row) return null;
  return {
    id: row.id,
    firstName: row.attributes?.firstName ?? "",
    lastName: row.attributes?.lastName ?? "",
    email: (row.attributes?.emails ?? [])[0] ?? email,
    title: row.attributes?.title ?? "",
  };
}

export async function createProspect(params: {
  firstName: string;
  lastName: string;
  email: string;
  title?: string;
  company?: string;
}): Promise<OutreachProspect> {
  const res = await outreachFetch("/prospects", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "prospect",
        attributes: {
          firstName: params.firstName,
          lastName: params.lastName,
          emails: [params.email],
          title: params.title ?? null,
          company: params.company ?? null,
        },
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Outreach createProspect failed: ${err}`);
  }

  const body = (await res.json()) as {
    data: {
      id: string;
      attributes?: {
        firstName?: string;
        lastName?: string;
        emails?: string[];
        title?: string;
      };
    };
  };

  return {
    id: body.data.id,
    firstName: body.data.attributes?.firstName ?? params.firstName,
    lastName: body.data.attributes?.lastName ?? params.lastName,
    email: (body.data.attributes?.emails ?? [])[0] ?? params.email,
    title: body.data.attributes?.title ?? params.title ?? "",
  };
}

// ── Batched prospect lookups (for Outreach Queue enrichment) ────────────────

// Given a list of email addresses, returns a map of lowercase-email → prospectId
// for whichever emails match an Outreach prospect. Chunked at 50 per request to
// keep URL length sane. Per-chunk failures are swallowed (empty results).
export async function findProspectsByEmails(
  emails: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (emails.length === 0) return result;

  const normalized = Array.from(
    new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => !!e))
  );

  const CHUNK_SIZE = 50;
  for (let i = 0; i < normalized.length; i += CHUNK_SIZE) {
    const chunk = normalized.slice(i, i + CHUNK_SIZE);
    try {
      const filter = encodeURIComponent(chunk.join(","));
      const res = await outreachFetch(
        `/prospects?filter[emails]=${filter}&page[size]=${chunk.length}`
      );
      if (!res.ok) continue;
      const body = (await res.json()) as {
        data?: Array<{
          id: string;
          attributes?: { emails?: string[] };
        }>;
      };
      for (const row of body.data ?? []) {
        for (const em of row.attributes?.emails ?? []) {
          if (!em) continue;
          const key = em.toLowerCase();
          // If an email matches multiple prospects, keep the first one seen
          if (!result.has(key)) result.set(key, row.id);
        }
      }
    } catch {
      // skip this chunk
    }
  }

  return result;
}

export type LastSequenceUsed = {
  prospectId: string;
  sequenceId: string;
  sequenceName: string;
  enrolledAt: string | null;
};

// Given a list of prospect IDs, returns a map of prospectId → the most recent
// sequenceState they were enrolled in (with the sequence name resolved from
// the include[] block). Chunked at 50 per request. Graceful on per-chunk fail.
export async function getLastSequenceStateByProspect(
  prospectIds: string[]
): Promise<Map<string, LastSequenceUsed>> {
  const result = new Map<string, LastSequenceUsed>();
  if (prospectIds.length === 0) return result;

  const unique = Array.from(new Set(prospectIds.filter((id) => !!id)));
  const CHUNK_SIZE = 50;

  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    const chunk = unique.slice(i, i + CHUNK_SIZE);
    try {
      const filter = encodeURIComponent(chunk.join(","));
      // sort=-createdAt so newest states come first per prospect.
      // include=sequence so sequence names come back in the same response.
      const res = await outreachFetch(
        `/sequenceStates?filter[prospect][id]=${filter}&include=sequence&sort=-createdAt&page[size]=200`
      );
      if (!res.ok) continue;
      const body = (await res.json()) as {
        data?: Array<{
          id: string;
          attributes?: { createdAt?: string };
          relationships?: {
            prospect?: { data?: { id?: string } };
            sequence?: { data?: { id?: string } };
          };
        }>;
        included?: Array<{
          type: string;
          id: string;
          attributes?: { name?: string };
        }>;
      };

      // Build sequenceId → name lookup from the `included` array
      const sequenceNames = new Map<string, string>();
      for (const inc of body.included ?? []) {
        if (inc.type === "sequence") {
          sequenceNames.set(inc.id, inc.attributes?.name ?? "(unnamed)");
        }
      }

      // Walk states in order (already sorted newest-first); take the first
      // occurrence per prospect.
      for (const row of body.data ?? []) {
        const prospectId = row.relationships?.prospect?.data?.id;
        const sequenceId = row.relationships?.sequence?.data?.id;
        if (!prospectId || !sequenceId) continue;
        if (result.has(prospectId)) continue; // first seen = newest
        result.set(prospectId, {
          prospectId,
          sequenceId,
          sequenceName: sequenceNames.get(sequenceId) ?? "(unknown sequence)",
          enrolledAt: row.attributes?.createdAt ?? null,
        });
      }
    } catch {
      // skip this chunk
    }
  }

  return result;
}

// ── Mailing patching (best-effort) ───────────────────────────────────────────

export async function tryPatchMailing(params: {
  sequenceStateId: string;
  subject?: string;
  bodyText?: string;
}): Promise<{ patched: boolean; mailingId?: string; reason?: string }> {
  try {
    // Find the first mailing for this sequenceState (the E1 step).
    // Outreach may not create the mailing instantly, so retry a few times.
    let mailing: { id: string } | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1500)); // wait 1.5s between retries
      }
      const findRes = await outreachFetch(
        `/mailings?filter[sequenceState][id]=${params.sequenceStateId}&sort=createdAt&page[size]=1`
      );
      if (!findRes.ok) continue;
      const findBody = (await findRes.json()) as {
        data?: Array<{ id: string }>;
      };
      const found = (findBody.data ?? [])[0];
      if (found) {
        mailing = found;
        break;
      }
    }
    if (!mailing) {
      return {
        patched: false,
        reason: "Mailing not yet created by Outreach after 4 attempts (~6s). Edit manually in Outreach.",
      };
    }

    // Build the attributes to patch
    const attributes: Record<string, string> = {};
    if (params.subject) attributes.subject = params.subject;
    if (params.bodyText) {
      // Convert plain text (from SF Task.Description) to basic HTML
      attributes.bodyHtml = params.bodyText
        .split(/\n\n+/)
        .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
        .join("");
    }

    if (Object.keys(attributes).length === 0) {
      return { patched: false, mailingId: mailing.id, reason: "Nothing to patch" };
    }

    const patchRes = await outreachFetch(`/mailings/${mailing.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        data: {
          type: "mailing",
          id: mailing.id,
          attributes,
        },
      }),
    });
    if (!patchRes.ok) {
      const err = await patchRes.text();
      return { patched: false, mailingId: mailing.id, reason: err };
    }
    return { patched: true, mailingId: mailing.id };
  } catch (e: unknown) {
    return {
      patched: false,
      reason: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

// ── Sequence enrollment ──────────────────────────────────────────────────────

export async function addProspectToSequence(params: {
  prospectId: string;
  sequenceId: string;
  mailboxId: string;
}): Promise<{ id: string }> {
  const res = await outreachFetch("/sequenceStates", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "sequenceState",
        // No state attribute = defaults to "active".
        // The email goes to the Outreach Email Outbox for manual
        // review/edit/send — it does NOT auto-send.
        relationships: {
          prospect: { data: { type: "prospect", id: params.prospectId } },
          sequence: { data: { type: "sequence", id: params.sequenceId } },
          mailbox: { data: { type: "mailbox", id: params.mailboxId } },
        },
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Outreach addProspectToSequence failed: ${err}`);
  }

  const body = (await res.json()) as { data: { id: string } };
  return { id: body.data.id };
}
