import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { outreachRequest } from "@/lib/outreach";
import { getValidCredentials } from "@/lib/token-manager";
import { sfFetch } from "@/lib/sf-query";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Overnight test lab for the Outreach automation work. Admin session only.
 *
 * POST { api: "outreach" | "salesforce", method, path, body? }
 *
 * Reads (GET) are open. Every write is refused unless it can only touch test
 * data:
 *   Outreach: test prospects (Seb's Gmail and its +plus addresses), sequences named "[TEST]...",
 *     templates named "[TEST]...", and mailings / sequence states / tasks that
 *     belong to the test prospect.
 *   Salesforce: records on the test account (TEST_ACCOUNT) only.
 * Every call is printed to the Vercel log with its verdict.
 */
/** Seb's Gmail and its plus-addresses (sebasalvarezm+anything@gmail.com) all land in his inbox. */
const isTestEmail = (e: unknown) => typeof e === "string" && /^sebasalvarezm(\+[a-z0-9._-]+)?@gmail\.com$/i.test(e.trim());
const TEST_ACCOUNT = "Amormino Inc.";

type Json = Record<string, unknown>;

async function outreachGet(path: string): Promise<Json | null> {
  const res = await outreachRequest(path);
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as Json | null;
}

/** A prospect is test data when every email on it is Seb's Gmail or a plus-address of it. */
async function isTestProspect(id: string | null): Promise<boolean> {
  if (!id || !/^\d+$/.test(id)) return false;
  const body = await outreachGet(`/prospects/${id}?fields[prospect]=emails`);
  const emails = ((body?.data as { attributes?: { emails?: string[] } } | undefined)?.attributes?.emails) ?? [];
  return emails.length > 0 && emails.every(isTestEmail);
}

function relId(obj: unknown, rel: string): string | null {
  const d = (obj as { relationships?: Record<string, { data?: { id?: string | number } | null }> })?.relationships?.[rel]?.data;
  return d?.id != null ? String(d.id) : null;
}

async function sequenceIsTest(id: string | null): Promise<boolean> {
  if (!id) return false;
  const body = await outreachGet(`/sequences/${id}?fields[sequence]=name`);
  const name = ((body?.data as { attributes?: { name?: string } })?.attributes?.name ?? "").trim();
  return name.startsWith("[TEST]");
}

/** Why an Outreach write is allowed, or null when it is not. */
async function outreachWriteAllowed(method: string, path: string, body: unknown): Promise<string | null> {
  const prospects = { has: async (pid: string) => isTestProspect(pid) };
  const data = (body as { data?: Json } | undefined)?.data;
  const clean = path.split("?")[0];
  const m = clean.match(/^\/([a-zA-Z]+)(?:\/(\d+))?(?:\/actions\/\w+)?$/);
  if (!m) return null;
  const [, kind, id] = m;

  if (kind === "prospects") {
    if (method === "POST" && !id) {
      const emails = ((data?.attributes as Json | undefined)?.emails as string[] | undefined) ?? [];
      return emails.length > 0 && emails.every(isTestEmail) ? "new test prospect" : null;
    }
    return id && await prospects.has(id) ? "test prospect" : null;
  }
  if (kind === "sequenceStates") {
    if (!id) {
      return await prospects.has(relId(data, "prospect") ?? "") && (await sequenceIsTest(relId(data, "sequence"))) ? "test prospect into [TEST] sequence" : null;
    }
    const st = await outreachGet(`/sequenceStates/${id}`);
    return await prospects.has(relId(st?.data, "prospect") ?? "") ? "test prospect's sequence state" : null;
  }
  if (kind === "mailings") {
    if (!id) return await prospects.has(relId(data, "prospect") ?? "") ? "mailing to test prospect" : null;
    const ml = await outreachGet(`/mailings/${id}`);
    return await prospects.has(relId(ml?.data, "prospect") ?? "") ? "test prospect's mailing" : null;
  }
  if (kind === "tasks") {
    if (!id) return await prospects.has(relId(data, "prospect") ?? "") ? "task for test prospect" : null;
    const t = await outreachGet(`/tasks/${id}`);
    return await prospects.has(relId(t?.data, "prospect") ?? "") ? "test prospect's task" : null;
  }
  if (kind === "sequences") {
    if (!id) return String((data?.attributes as Json | undefined)?.name ?? "").startsWith("[TEST]") ? "new [TEST] sequence" : null;
    return (await sequenceIsTest(id)) ? "[TEST] sequence" : null;
  }
  if (kind === "sequenceSteps") {
    if (!id) return (await sequenceIsTest(relId(data, "sequence"))) ? "step on [TEST] sequence" : null;
    const step = await outreachGet(`/sequenceSteps/${id}`);
    return (await sequenceIsTest(relId(step?.data, "sequence"))) ? "step of [TEST] sequence" : null;
  }
  if (kind === "templates") {
    if (!id) return String((data?.attributes as Json | undefined)?.name ?? "").startsWith("[TEST]") ? "new [TEST] template" : null;
    const tp = await outreachGet(`/templates/${id}?fields[template]=name`);
    return String(((tp?.data as Json | undefined)?.attributes as Json | undefined)?.name ?? "").startsWith("[TEST]") ? "[TEST] template" : null;
  }
  if (kind === "sequenceTemplates") {
    if (!id) {
      const step = await outreachGet(`/sequenceSteps/${relId(data, "sequenceStep")}`);
      return (await sequenceIsTest(relId(step?.data, "sequence"))) ? "template on [TEST] step" : null;
    }
    const stp = await outreachGet(`/sequenceTemplates/${id}`);
    const step = await outreachGet(`/sequenceSteps/${relId(stp?.data, "sequenceStep")}`);
    return (await sequenceIsTest(relId(step?.data, "sequence"))) ? "[TEST] step's template" : null;
  }
  return null;
}

async function salesforceWriteAllowed(method: string, path: string, body: unknown): Promise<string | null> {
  const rows = await (async () => {
    const res = await sfFetch(`/services/data/v62.0/query?q=${encodeURIComponent(`SELECT Id FROM Account WHERE Name = '${TEST_ACCOUNT}' LIMIT 2`)}`);
    return res.ok ? (((await res.json()) as { records?: Array<{ Id: string }> }).records ?? []) : [];
  })();
  if (rows.length !== 1) return null;
  const accountId = rows[0].Id;
  const m = path.split("?")[0].match(/^\/services\/data\/v\d+\.\d+\/sobjects\/(Contact|Task|Lead)(?:\/(\w{15,18}))?$/);
  if (!m) return null;
  const [, object, id] = m;
  const b = (body ?? {}) as Json;
  if (!id) {
    if (object === "Contact") return b.AccountId === accountId && isTestEmail(b.Email) ? "test contact on test account" : null;
    if (object === "Task") return b.WhatId === accountId ? "task on test account" : null;
    return null;
  }
  const field = object === "Contact" ? "AccountId" : object === "Task" ? "WhatId" : null;
  if (!field) return null;
  const res = await sfFetch(`/services/data/v62.0/sobjects/${object}/${id}?fields=${field}${object === "Contact" ? ",Email" : ""}`);
  const rec = res.ok ? ((await res.json()) as Json) : null;
  // A contact on Seb's own test address may be moved onto the test account.
  if (object === "Contact" && method === "PATCH" && isTestEmail(rec?.Email) && b.AccountId === accountId) return "test contact moved to test account";
  if (rec?.[field] !== accountId) return null;
  if (object === "Contact" && method === "PATCH" && "AccountId" in b && b.AccountId !== accountId) return null;
  return `${object} on test account`;
}

export async function POST(request: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const req = (await request.json().catch(() => ({}))) as { api?: string; method?: string; path?: string; body?: unknown };
  const method = (req.method ?? "GET").toUpperCase();
  const path = req.path ?? "";
  if (!path.startsWith("/")) return NextResponse.json({ error: "path must start with /" }, { status: 400 });

  try {
    let why: string | null = "read";
    if (method !== "GET") {
      why = req.api === "salesforce" ? await salesforceWriteAllowed(method, path, req.body) : await outreachWriteAllowed(method, path, req.body);
    }
    console.log(`[lab] ${req.api} ${method} ${path} -> ${why ?? "REFUSED"}`);
    if (!why) return NextResponse.json({ refused: true, reason: "Write does not touch test data only" }, { status: 403 });

    const init: RequestInit = { method, ...(req.body !== undefined && method !== "GET" ? { body: JSON.stringify(req.body) } : {}) };
    const res =
      req.api === "salesforce"
        ? await sfFetch(path, init, await getValidCredentials())
        : await outreachRequest(path, init);
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    return NextResponse.json({ status: res.status, allowedBecause: why, body: parsed });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
