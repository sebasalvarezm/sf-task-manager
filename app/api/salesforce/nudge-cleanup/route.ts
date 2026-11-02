import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { assertSalesforceId, sfErrorText, sfFetch, sfQuery } from "@/lib/sf-query";
import { getValidCredentials } from "@/lib/token-manager";
import { cleanupItems, cleanupChange, type CompletedRow, type LaterRow } from "@/lib/nudge-cleanup";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * One-off: delete the RCEs that nudges and follow-ups logged by mistake.
 * GET lists what would change (read only). POST { apply: true } makes the
 * change, recomputing the list on the server first. Admin only.
 */
async function findItems() {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");
  const me = assertSalesforceId(credentials.salesforce_user_id, "user id");
  const completed = await sfQuery<CompletedRow>(
    `SELECT Id, Subject, Type, Description, AccountId, Account.Name, LastModifiedDate, ActivityDate FROM Task ` +
      `WHERE OwnerId = '${me}' AND Status = 'Completed' AND Subject_Type__c = 'RCE1' AND LastModifiedDate >= 2026-10-20T00:00:00Z ` +
      `ORDER BY LastModifiedDate DESC LIMIT 1000`,
    credentials,
  );
  const accounts = [...new Set(completed.map((r) => r.AccountId).filter((id): id is string => !!id))];
  const later: LaterRow[] = [];
  for (let i = 0; i < accounts.length; i += 150) {
    const ids = accounts.slice(i, i + 150).map((id) => `'${assertSalesforceId(id, "account id")}'`).join(",");
    later.push(
      ...(await sfQuery<LaterRow>(
        `SELECT Id, AccountId, CreatedDate FROM Task WHERE OwnerId = '${me}' AND AccountId IN (${ids}) AND CreatedDate >= 2026-10-20T00:00:00Z`,
        credentials,
      )),
    );
  }
  return { items: cleanupItems(completed, later), credentials };
}

export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { items } = await findItems();
  return NextResponse.json({ count: items.length, delete: items.filter((i) => i.hasNextTask).length, reopen: items.filter((i) => !i.hasNextTask).length, items });
}

export async function POST(request: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  if (body?.apply !== true) return NextResponse.json({ error: "Send { apply: true } to make the change." }, { status: 400 });
  const { items, credentials } = await findItems();
  const results: Array<{ id: string; account: string; ok: boolean; error?: string }> = [];
  for (const item of items) {
    const change = cleanupChange(item);
    const res = await sfFetch(
      `/services/data/v62.0/sobjects/Task/${assertSalesforceId(item.id, "task id")}`,
      change.method === "DELETE" ? { method: "DELETE" } : { method: "PATCH", body: JSON.stringify(change.body) },
      credentials,
    );
    results.push({ id: item.id, account: item.account, ok: res.ok, error: res.ok ? undefined : await sfErrorText(res) });
  }
  return NextResponse.json({ fixed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), results });
}
