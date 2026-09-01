import { getValidCredentials } from "./token-manager";
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
    const response = await fetch(`${creds.instance_url}${path}`, {
      headers: {
        Authorization: `Bearer ${creds.access_token}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(
        `Salesforce query failed (HTTP ${response.status}): ${err.slice(0, 500)}`,
      );
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
