import { forceRefreshCredentials, getValidCredentials } from "./token-manager";
import type { SfCredentials } from "./supabase";

/**
 * Run one SOQL query against Salesforce and return ALL its records.
 *
 * Centralizes what was previously hand-rolled at every call site: credential
 * lookup, the REST query endpoint, error surfacing, and — crucially —
 * nextRecordsUrl pagination, which most call sites skipped and which silently
 * truncated large result sets at 2,000 records.
 *
 * Pass `credentials` when the caller already fetched them (e.g. because it
 * also needs instance_url for building record links); otherwise they are
 * fetched here. Throws Error("NOT_CONNECTED") when Salesforce is not
 * connected, which API routes match on to return a 401-style response.
 */
export async function sfQuery<T>(
  soql: string,
  credentials?: SfCredentials | null,
): Promise<T[]> {
  const creds = credentials ?? (await getValidCredentials());
  if (!creds) throw new Error("NOT_CONNECTED");

  const records: T[] = [];
  let path: string | null =
    `/services/data/v62.0/query/?q=${encodeURIComponent(soql)}`;

  while (path) {
    const response = await sfFetch(path, {}, creds);
    if (!response.ok) {
      throw new Error(`Salesforce query failed: ${await sfErrorText(response)}`);
    }
    const body = (await response.json()) as {
      records?: T[];
      done?: boolean;
      nextRecordsUrl?: string;
    };
    records.push(...(body.records ?? []));
    path = body.done === false && body.nextRecordsUrl ? body.nextRecordsUrl : null;
  }

  return records;
}

/** Salesforce record ids are 15 or 18 letters and digits. */
export function isSalesforceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value);
}

/**
 * Throws unless `value` is a well-formed Salesforce id. Every write path calls
 * this before putting an id into a REST URL or a WhatId: an unchecked id such
 * as "../Account/001..." would otherwise turn "delete this task" into
 * "delete that account".
 */
export function assertSalesforceId(value: unknown, label = "record id"): string {
  if (!isSalesforceId(value)) {
    throw new Error(`Invalid Salesforce ${label}`);
  }
  return value;
}

/**
 * fetch() against the Salesforce REST API, with the access token added.
 *
 * `path` is relative to the instance ("/services/data/v62.0/..."). If
 * Salesforce answers 401 (session expired or revoked before our scheduled
 * refresh), the token is refreshed once and the request retried. A 401 means
 * Salesforce did not run the request, so retrying a write is safe. Throws
 * Error("NOT_CONNECTED") when the connection is gone for good.
 */
export async function sfFetch(
  path: string,
  init: RequestInit = {},
  credentials?: SfCredentials | null,
): Promise<Response> {
  let creds = credentials ?? (await getValidCredentials());
  if (!creds) throw new Error("NOT_CONNECTED");

  const send = (c: SfCredentials) =>
    fetch(`${c.instance_url}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${c.access_token}`,
      },
    });

  let response = await send(creds);
  if (response.status === 401) {
    creds = await forceRefreshCredentials();
    if (!creds) throw new Error("NOT_CONNECTED");
    response = await send(creds);
    if (response.status === 401) throw new Error("NOT_CONNECTED");
  }
  return response;
}

/**
 * Salesforce error bodies are JSON like
 * [{"message":"entity is deleted","errorCode":"ENTITY_IS_DELETED"}].
 * Turn that into a readable sentence instead of showing raw JSON.
 */
export async function sfErrorText(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const messages = list
      .map((e) => {
        const item = e as { message?: unknown; errorCode?: unknown; error_description?: unknown };
        const msg =
          typeof item.message === "string"
            ? item.message
            : typeof item.error_description === "string"
              ? item.error_description
              : null;
        if (!msg) return null;
        return typeof item.errorCode === "string" ? `${msg} (${item.errorCode})` : msg;
      })
      .filter((m): m is string => Boolean(m));
    if (messages.length > 0) return `Salesforce said: ${messages.join("; ")}`;
  } catch {
    // not JSON; fall through
  }
  const text = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return text
    ? `Salesforce returned HTTP ${response.status}: ${text}`
    : `Salesforce returned HTTP ${response.status}`;
}
